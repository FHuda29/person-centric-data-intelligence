import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { config } from '../../config';
import { DbService } from '../../common/db.service';
import { bullConnection, COLLECT_QUEUE, MAINTENANCE_QUEUE, RedisService } from '../../common/redis.service';
import { sleep } from '../../common/text';
import { AuditService } from '../audit/audit.service';
import { RetentionService } from '../cases/cases.controller';
import { EntitiesService } from '../entities/entities.service';
import { IngestService } from '../ingest/ingest.service';
import { ResolutionService } from '../resolution/resolution.service';
import { SourcesService } from '../sources/sources.service';
import { CollectJobData } from './collection.service';

const TIMEOUT_MS = 90_000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

/** Worker & connector layer: executes transforms with policy re-check, rate limit, timeout, retry and dead-letter. */
@Injectable()
export class CollectProcessor implements OnModuleDestroy {
  private readonly log = new Logger('Worker');
  private worker?: Worker;
  private maintenance?: Worker;

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly sources: SourcesService,
    private readonly entities: EntitiesService,
    private readonly ingest: IngestService,
    private readonly resolution: ResolutionService,
    private readonly retention: RetentionService,
    private readonly audit: AuditService,
  ) {}

  /** Started explicitly by worker.ts once storage, index and graph stores are ready. */
  async start() {
    this.worker = new Worker<CollectJobData>(COLLECT_QUEUE, (job) => this.process(job), {
      connection: bullConnection(),
      concurrency: config.workerConcurrency,
      lockDuration: 180_000,
    });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.log.error(`worker error: ${err.message}`));

    this.maintenance = new Worker(MAINTENANCE_QUEUE, async (job) => {
      if (job.name === 'retention-purge') return { purged: await this.retention.purgeExpired() };
    }, { connection: bullConnection() });
    await this.redis.maintenanceQueue.upsertJobScheduler('retention-purge', { every: 6 * 3600 * 1000 }, { name: 'retention-purge' });
    this.log.log(`Collection worker started (concurrency ${config.workerConcurrency})`);
  }

  private async process(job: Job<CollectJobData>) {
    const id = job.data.collectionJobId;
    const row = await this.db.one(
      `SELECT j.*, s.connector_key FROM collection.collection_jobs j JOIN sources.sources s ON s.id = j.source_id WHERE j.id = $1`,
      [id],
    );
    if (!row || ['COMPLETED', 'SKIPPED'].includes(row.status)) return;
    const source = await this.sources.byKey(row.connector_key);
    const gate = this.sources.isRunnable(source);
    const kase = await this.db.one('SELECT status FROM cases.cases WHERE id = $1', [row.case_id]);
    if (!gate.ok || kase?.status !== 'OPEN') {
      const reason = !gate.ok ? gate.reason : `case is ${kase?.status}`;
      await this.db.query(`UPDATE collection.collection_jobs SET status = 'SKIPPED', error = $2, ended_at = now() WHERE id = $1`, [id, reason]);
      return;
    }
    await this.db.query(
      `UPDATE collection.collection_jobs SET status = 'RUNNING', attempts = $2, started_at = now(), error = NULL WHERE id = $1`,
      [id, job.attemptsMade + 1],
    );
    // Per-source rate limit (fixed window in Redis).
    for (let wait = await this.redis.acquireRate(source.connector_key, source.rate_limit_per_min); wait > 0; ) {
      await sleep(Math.min(wait, 60_000));
      wait = await this.redis.acquireRate(source.connector_key, source.rate_limit_per_min);
    }
    let entity = await this.entities.get(row.input_entity_id);
    if (entity?.merged_into) entity = await this.entities.get(entity.merged_into);
    if (!entity) throw new Error('Input entity no longer exists');
    const connector = this.sources.connectors.get(source.connector_key)!;
    const input = await this.entities.transformInput(entity);
    const out = await withTimeout(connector.run(input), TIMEOUT_MS, source.connector_key);
    const summary = await this.ingest.ingest(
      {
        caseId: row.case_id,
        sourceId: source.id,
        sourceKey: source.connector_key,
        accessMethod: source.access_method,
        inputEntity: entity,
        jobId: id,
        userId: row.requested_by,
      },
      out,
    );
    const res = await this.resolution.recompute(row.case_id).catch((e) => {
      this.log.warn(`resolution recompute failed: ${e.message}`);
      return null;
    });
    await this.db.query(
      `UPDATE collection.collection_jobs SET status = 'COMPLETED', result_summary = $2, ended_at = now() WHERE id = $1`,
      [id, JSON.stringify({ ...summary, resolutionPairs: res?.pairs ?? null })],
    );
    await this.audit.record({
      action: 'collection.job.completed',
      objectType: 'collection_job',
      objectId: id,
      caseId: row.case_id,
      detail: { source: source.connector_key, ...summary, notes: summary.notes.slice(0, 5) },
    });
    return summary;
  }

  private async onFailed(job: Job<CollectJobData> | undefined, err: Error) {
    if (!job) return;
    const id = job.data.collectionJobId;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.log.warn(`job ${id} failed (attempt ${job.attemptsMade}): ${err.message}`);
    await this.db
      .query(`UPDATE collection.collection_jobs SET status = $2, error = $3, ended_at = CASE WHEN $4 THEN now() ELSE NULL END WHERE id = $1`, [
        id,
        final ? 'DEAD' : 'QUEUED',
        err.message.slice(0, 1000),
        final,
      ])
      .catch(() => undefined);
    if (final) {
      await this.redis.deadLetterQueue.add('dead', { collectionJobId: id, error: err.message, failedAt: new Date().toISOString() });
      await this.audit.record({ action: 'collection.job.dead_letter', objectType: 'collection_job', objectId: id, detail: { error: err.message.slice(0, 500) } }).catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.worker?.close(), this.maintenance?.close()]);
  }
}
