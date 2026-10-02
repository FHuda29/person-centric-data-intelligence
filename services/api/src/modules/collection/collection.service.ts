import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { RedisService } from '../../common/redis.service';
import { AuthUser } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { EntitiesService, EntityRow } from '../entities/entities.service';
import { PolicyService } from '../policy/policy.service';
import { SourceRow, SourcesService } from '../sources/sources.service';

export interface CollectJobData {
  collectionJobId: string;
}

const STRONG_PIVOTS = ['EMAIL', 'USERNAME', 'DOMAIN', 'PHONE', 'SOCIAL_ACCOUNT', 'URL'];

@Injectable()
export class CollectionService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly sources: SourcesService,
    private readonly entities: EntitiesService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  /** Transforms applicable to an entity: every registered source whose input types include the entity type. */
  async transformsFor(entity: EntityRow) {
    const all = await this.sources.list();
    return all
      .filter((s) => s.input_types.includes(entity.canonical_type))
      .map((s) => ({
        key: s.connector_key,
        name: s.name,
        tier: s.tier,
        category: s.category,
        description: s.description,
        autoRun: s.auto_run,
        policyState: s.policy_state,
        connectorStatus: s.connector_status,
        runnable: this.sources.isRunnable(s).ok,
        blockedReason: this.sources.isRunnable(s).reason ?? null,
      }));
  }

  private async enqueue(user: AuthUser, entity: EntityRow, source: SourceRow, requestId: string, idem?: string) {
    const job = await this.db.one<{ id: string }>(
      `INSERT INTO collection.collection_jobs(case_id, source_id, input_entity_id, input_type, input_value, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [entity.case_id, source.id, entity.id, entity.canonical_type, entity.label, user.id, idem ?? null],
    );
    await this.redis.collectQueue.add(
      source.connector_key,
      { collectionJobId: job!.id } satisfies CollectJobData,
      {
        jobId: job!.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 2000 },
        removeOnFail: { count: 5000 },
      },
    );
    await this.audit.record({
      actor: user,
      action: 'collection.job.queued',
      objectType: 'collection_job',
      objectId: job!.id,
      caseId: entity.case_id,
      requestId,
      detail: { source: source.connector_key, input_type: entity.canonical_type, entity_id: entity.id },
    });
    return job!.id;
  }

  /** Maltego-style single transform on one entity (analyst initiated). */
  async runTransform(user: AuthUser, entityId: string, connectorKey: string, requestId: string) {
    const entity = await this.entities.get(entityId);
    if (!entity) throw new NotFoundException('Entity not found');
    await this.policy.assertCaseAccess(user, entity.case_id, 'EDIT');
    await this.policy.assertCaseCollectable(entity.case_id);
    const source = await this.sources.byKey(connectorKey);
    const gate = this.sources.isRunnable(source);
    if (!gate.ok) throw new BadRequestException(`Source ${connectorKey} blocked: ${gate.reason}`);
    if (!source.input_types.includes(entity.canonical_type)) {
      throw new BadRequestException(`${connectorKey} does not accept ${entity.canonical_type}`);
    }
    const jobId = await this.enqueue(user, entity, source, requestId);
    return { jobId, status: 'QUEUED' };
  }

  /** Runs all auto-run, policy-approved transforms over the case seeds (optionally one pivot hop further). */
  async runInvestigation(
    user: AuthUser,
    caseId: string,
    opts: { depth?: number; force?: boolean },
    requestId: string,
    idempotencyKey?: string,
  ) {
    await this.policy.assertCaseAccess(user, caseId, 'EDIT');
    await this.policy.assertCaseCollectable(caseId);
    const idemKey = idempotencyKey ? `idem:run:${user.id}:${caseId}:${idempotencyKey}` : null;
    if (idemKey) {
      const prior = await this.redis.redis.get(idemKey);
      if (prior) return { ...JSON.parse(prior), idempotentReplay: true };
    }
    let targets = await this.db.query<EntityRow>(
      `SELECT * FROM intelligence.entities WHERE case_id = $1 AND is_seed AND resolution_status <> 'MERGED'`,
      [caseId],
    );
    if ((opts.depth ?? 1) >= 2) {
      const pivots = await this.db.query<EntityRow>(
        `SELECT DISTINCT n.* FROM intelligence.relationships r
         JOIN intelligence.entities s ON s.id IN (r.from_id, r.to_id) AND s.is_seed
         JOIN intelligence.entities n ON n.id IN (r.from_id, r.to_id) AND n.id <> s.id
         WHERE r.case_id = $1 AND r.confidence >= 0.7 AND r.status <> 'REJECTED'
           AND n.canonical_type = ANY($2) AND n.resolution_status <> 'MERGED'`,
        [caseId, STRONG_PIVOTS],
      );
      targets = [...targets, ...pivots.filter((p) => !targets.some((t) => t.id === p.id))];
    }
    const sources = (await this.sources.list()).filter((s) => s.auto_run && this.sources.isRunnable(s).ok);
    const queued: { jobId: string; source: string; entity: string }[] = [];
    const skipped: { source: string; entity: string; reason: string }[] = [];
    for (const e of targets.slice(0, 50)) {
      for (const s of sources.filter((x) => x.input_types.includes(e.canonical_type))) {
        if (!opts.force) {
          const recent = await this.db.one(
            `SELECT 1 FROM collection.collection_jobs WHERE input_entity_id = $1 AND source_id = $2
             AND status IN ('QUEUED','RUNNING','COMPLETED') AND created_at > now() - interval '24 hours'`,
            [e.id, s.id],
          );
          if (recent) {
            skipped.push({ source: s.connector_key, entity: e.label, reason: 'already collected in last 24h' });
            continue;
          }
        }
        queued.push({ jobId: await this.enqueue(user, e, s, requestId, idempotencyKey), source: s.connector_key, entity: e.label });
      }
    }
    const blocked = (await this.sources.list())
      .filter((s) => s.auto_run && !this.sources.isRunnable(s).ok)
      .map((s) => ({ source: s.connector_key, reason: this.sources.isRunnable(s).reason }));
    const result = { caseId, queued, skipped, blockedSources: blocked };
    if (idemKey) await this.redis.redis.set(idemKey, JSON.stringify(result), 'EX', 86400);
    return result;
  }
}

@Controller()
export class CollectionController {
  constructor(
    private readonly collection: CollectionService,
    private readonly entities: EntitiesService,
    private readonly policy: PolicyService,
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  @Post('investigations/:caseId/run')
  @Roles('ADMIN', 'ANALYST')
  run(
    @CurrentUser() user: AuthUser,
    @Param('caseId') caseId: string,
    @Body() body: { depth?: number; force?: boolean },
    @Headers('idempotency-key') idem: string | undefined,
    @RequestId() rid: string,
  ) {
    return this.collection.runInvestigation(user, caseId, body ?? {}, rid, idem);
  }

  @Get('entities/:id/transforms')
  async transforms(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const e = await this.entities.get(id);
    if (!e) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, e.case_id, 'READ');
    return this.collection.transformsFor(e);
  }

  @Post('entities/:id/transforms/:key')
  @Roles('ADMIN', 'ANALYST')
  runTransform(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('key') key: string, @RequestId() rid: string) {
    return this.collection.runTransform(user, id, key, rid);
  }

  @Get('jobs')
  async jobs(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string, @Query('limit') limit = '100') {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    return this.db.query(
      `SELECT j.id, j.status, j.input_type, j.input_value, j.input_entity_id, j.attempts, j.result_summary, j.error,
              j.created_at, j.started_at, j.ended_at, s.connector_key, s.name AS source_name, s.tier
       FROM collection.collection_jobs j JOIN sources.sources s ON s.id = j.source_id
       WHERE j.case_id = $1 ORDER BY j.created_at DESC LIMIT $2`,
      [caseId, Math.min(500, Number(limit) || 100)],
    );
  }

  @Get('jobs/:jobId')
  async job(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string) {
    const j = await this.db.one(
      `SELECT j.*, s.connector_key, s.name AS source_name FROM collection.collection_jobs j
       JOIN sources.sources s ON s.id = j.source_id WHERE j.id = $1`,
      [jobId],
    );
    if (!j) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, j.case_id, 'READ');
    return j;
  }

  @Get('queue/stats')
  async stats() {
    const [collect, dead] = await Promise.all([
      this.redis.collectQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      this.redis.deadLetterQueue.getJobCounts('waiting', 'completed'),
    ]);
    return { collect, deadLetter: dead };
  }
}
