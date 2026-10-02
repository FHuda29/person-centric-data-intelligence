import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { GraphStoreService } from '../../common/graph-store.service';
import { SearchIndexService } from '../../common/search-index.service';
import { StorageService } from '../../common/storage.service';
import { htmlToText, sha256 } from '../../common/text';
import { AuthUser } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { CollectionService } from '../collection/collection.service';
import { EntitiesService } from '../entities/entities.service';
import { IdentityService } from '../identity/identity.service';
import { IngestService } from '../ingest/ingest.service';
import { PolicyService } from '../policy/policy.service';
import { SourcesService } from '../sources/sources.service';

/** Per-case retention + purge workflow (paper §13). Audit events are retained. */
@Injectable()
export class RetentionService {
  private readonly log = new Logger('Retention');
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly index: SearchIndexService,
    private readonly graph: GraphStoreService,
    private readonly audit: AuditService,
  ) {}

  async purge(caseId: string, actor: AuthUser | null, reason: string, requestId: string | null) {
    await this.db.tx(async (t) => {
      for (const table of [
        'intelligence.finding_evidence USING intelligence.findings f WHERE finding_id = f.id AND f.case_id = $1',
        'intelligence.findings WHERE case_id = $1',
        'intelligence.narratives WHERE case_id = $1',
        'intelligence.resolution_candidates WHERE case_id = $1',
        'intelligence.relationships WHERE case_id = $1',
        'intelligence.entities WHERE case_id = $1',
        'intelligence.reports WHERE case_id = $1',
        'collection.observations WHERE case_id = $1',
        'collection.collection_jobs WHERE case_id = $1',
        'evidence.evidence WHERE case_id = $1',
        'cases.seed_entities WHERE case_id = $1',
      ]) {
        await t.query(`DELETE FROM ${table}`, [caseId]);
      }
      await t.query(`UPDATE cases.cases SET status = 'PURGED', updated_at = now() WHERE id = $1`, [caseId]);
    });
    await this.storage.removePrefix(`cases/${caseId}/`).catch((e) => this.log.warn(`object purge: ${e.message}`));
    await this.index.deleteByCase(caseId);
    await this.graph.deleteCase(caseId);
    await this.audit.record({ actor, action: 'case.purged', objectType: 'case', objectId: caseId, caseId, requestId, detail: { reason } });
  }

  async purgeExpired(): Promise<number> {
    const expired = await this.db.query<{ id: string }>(
      `SELECT id FROM cases.cases WHERE status <> 'PURGED' AND retention_until < current_date`,
    );
    for (const c of expired) await this.purge(c.id, null, 'retention period expired', null);
    if (expired.length) this.log.log(`Purged ${expired.length} expired case(s)`);
    return expired.length;
  }
}

const TEXT_TYPES = /^(text\/(plain|html|markdown|csv)|application\/(json|xhtml\+xml))/;

@Controller('cases')
export class CasesController {
  constructor(
    private readonly db: DbService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly entities: EntitiesService,
    private readonly ingest: IngestService,
    private readonly sources: SourcesService,
    private readonly retention: RetentionService,
    private readonly collection: CollectionService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const ids = await this.policy.accessibleCaseIds(user);
    return this.db.query(
      `SELECT c.*, u.username AS owner_name,
         (SELECT count(*)::int FROM intelligence.entities e WHERE e.case_id = c.id AND e.resolution_status <> 'MERGED') AS entity_count,
         (SELECT count(*)::int FROM intelligence.findings f WHERE f.case_id = c.id) AS finding_count,
         (SELECT count(*)::int FROM collection.collection_jobs j WHERE j.case_id = c.id AND j.status IN ('QUEUED','RUNNING')) AS active_jobs
       FROM cases.cases c JOIN iam.users u ON u.id = c.owner_id
       WHERE c.id = ANY($1::uuid[]) ORDER BY c.updated_at DESC`,
      [ids],
    );
  }

  @Post()
  @Roles('ADMIN', 'ANALYST')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() b: { title: string; purpose: string; scope?: string; legalBasis?: string; classification?: string; retentionDays?: number },
    @RequestId() rid: string,
  ) {
    if (!b.title?.trim()) throw new BadRequestException('Title is required');
    if (!b.purpose || b.purpose.trim().length < 10) throw new BadRequestException('A documented purpose (≥10 chars) is required');
    const days = Math.max(1, Math.min(3650, Number(b.retentionDays) || 180));
    const year = new Date().getFullYear();
    const seq = await this.db.one<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM cases.cases WHERE code LIKE $1`, [`CASE-${year}-%`]);
    const c = await this.db.one(
      `INSERT INTO cases.cases(code, title, purpose, scope, legal_basis, owner_id, classification, retention_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7, current_date + $8::int) RETURNING *`,
      [
        `CASE-${year}-${String(seq!.n).padStart(3, '0')}`, b.title.trim(), b.purpose.trim(), b.scope ?? null, b.legalBasis ?? null,
        user.id, b.classification ?? 'CONFIDENTIAL', days,
      ],
    );
    await this.audit.record({ actor: user, action: 'case.created', objectType: 'case', objectId: c.id, caseId: c.id, requestId: rid, detail: { purpose: b.purpose, classification: c.classification } });
    return c;
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.policy.assertCaseAccess(user, id, 'READ');
    const c = await this.db.one(
      `SELECT c.*, u.username AS owner_name FROM cases.cases c JOIN iam.users u ON u.id = c.owner_id WHERE c.id = $1`,
      [id],
    );
    const stats = await this.db.one(
      `SELECT
        (SELECT count(*)::int FROM intelligence.entities WHERE case_id = $1 AND resolution_status <> 'MERGED') AS entities,
        (SELECT count(*)::int FROM intelligence.relationships WHERE case_id = $1) AS relationships,
        (SELECT count(*)::int FROM evidence.evidence WHERE case_id = $1) AS evidence,
        (SELECT count(*)::int FROM collection.observations WHERE case_id = $1) AS observations,
        (SELECT count(*)::int FROM intelligence.findings WHERE case_id = $1) AS findings,
        (SELECT count(*)::int FROM intelligence.resolution_candidates WHERE case_id = $1 AND status IN ('CANDIDATE','REVIEW_READY')) AS pending_resolution,
        (SELECT count(*)::int FROM intelligence.narratives WHERE case_id = $1) AS narratives`,
      [id],
    );
    const byType = await this.db.query(
      `SELECT canonical_type AS type, count(*)::int AS count FROM intelligence.entities
       WHERE case_id = $1 AND resolution_status <> 'MERGED' GROUP BY 1 ORDER BY 2 DESC`,
      [id],
    );
    const jobs = await this.db.query(
      `SELECT status, count(*)::int AS count FROM collection.collection_jobs WHERE case_id = $1 GROUP BY 1`,
      [id],
    );
    const findings = await this.db.query(
      `SELECT status, count(*)::int AS count FROM intelligence.findings WHERE case_id = $1 GROUP BY 1`,
      [id],
    );
    const seeds = await this.db.query(
      `SELECT s.*, e.label, e.resolution_status FROM cases.seed_entities s LEFT JOIN intelligence.entities e ON e.id = s.entity_id
       WHERE s.case_id = $1 ORDER BY s.created_at`,
      [id],
    );
    const members = await this.db.query(
      `SELECT m.user_id, m.access, u.username, u.display_name FROM cases.case_members m JOIN iam.users u ON u.id = m.user_id WHERE m.case_id = $1`,
      [id],
    );
    const access = await this.policy.caseAccess(user, id);
    return {
      ...c,
      access,
      stats,
      byType,
      jobs,
      findings,
      members,
      seeds: seeds.map((s) => ({ ...s, normalized_value: ['PHONE', 'EMAIL'].includes(s.type) ? undefined : s.normalized_value, raw_value: undefined })),
    };
  }

  @Patch(':id')
  @Roles('ADMIN', 'ANALYST')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() b: { status?: string; scope?: string; classification?: string; retentionDays?: number },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, id, 'EDIT');
    if (b.status && !['OPEN', 'ON_HOLD', 'CLOSED'].includes(b.status)) throw new BadRequestException('Invalid status');
    const c = await this.db.one(
      `UPDATE cases.cases SET status = COALESCE($2, status), scope = COALESCE($3, scope),
         classification = COALESCE($4, classification),
         retention_until = CASE WHEN $5::int IS NULL THEN retention_until ELSE current_date + $5::int END,
         updated_at = now()
       WHERE id = $1 AND status <> 'PURGED' RETURNING *`,
      [id, b.status ?? null, b.scope ?? null, b.classification ?? null, b.retentionDays ?? null],
    );
    if (!c) throw new NotFoundException();
    await this.audit.record({ actor: user, action: 'case.updated', objectType: 'case', objectId: id, caseId: id, requestId: rid, detail: b as any });
    return c;
  }

  @Post(':id/members')
  @Roles('ADMIN', 'ANALYST')
  async addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() b: { username: string; access?: 'READ' | 'EDIT' },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, id, 'EDIT');
    const u = await this.db.one('SELECT id FROM iam.users WHERE username = $1 AND active', [b.username]);
    if (!u) throw new NotFoundException('User not found');
    await this.db.query(
      `INSERT INTO cases.case_members(case_id, user_id, access) VALUES ($1,$2,$3)
       ON CONFLICT (case_id, user_id) DO UPDATE SET access = EXCLUDED.access`,
      [id, u.id, b.access ?? 'READ'],
    );
    await this.audit.record({ actor: user, action: 'case.member.added', objectType: 'case', objectId: id, caseId: id, requestId: rid, detail: { username: b.username, access: b.access ?? 'READ' } });
    return { ok: true };
  }

  /** Seed intake (paper §10): primary identifier + secondary identifiers, normalised and linked. */
  @Post(':id/seeds')
  @Roles('ADMIN', 'ANALYST')
  async addSeed(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() b: { type?: string; value: string; secondary_identifiers?: { type: string; value: string }[]; purpose?: string },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, id, 'EDIT');
    await this.policy.assertCaseCollectable(id);
    const type = (b.type ?? this.identity.classify(b.value ?? '')).toUpperCase();
    const primary = this.identity.normalize(type, b.value);
    const seedEntity = await this.entities.upsert(id, primary, { confidence: 1, isSeed: true });
    await this.db.query(
      `INSERT INTO cases.seed_entities(case_id, type, raw_value, normalized_value, entity_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, primary.type, primary.raw, primary.canonicalKey, seedEntity.id, user.id],
    );
    // The intake itself is recorded as evidence so analyst-supplied links remain traceable (paper §9).
    const intakeSrc = await this.sources.byKey('local.analyst-intake');
    const intake = await this.ingest.storeObservation(
      { caseId: id, sourceId: intakeSrc.id, sourceKey: intakeSrc.connector_key, accessMethod: intakeSrc.access_method, inputEntity: null, userId: user.id },
      {
        ref: 'intake',
        title: `Analyst intake: ${primary.type} seed`,
        raw: JSON.stringify({ analyst: user.username, at: new Date().toISOString(), purpose: b.purpose ?? null, primary: { type: primary.type, value: primary.canonicalKey }, secondary: b.secondary_identifiers ?? [] }),
        contentType: 'application/json',
      },
    );
    const touched = [seedEntity.id];
    const rels: string[] = [];
    const relFor: Record<string, string> = { PHONE: 'HAS_PHONE', EMAIL: 'HAS_EMAIL', USERNAME: 'USES_ALIAS', SOCIAL_ACCOUNT: 'HAS_ACCOUNT', ORGANIZATION: 'WORKS_FOR' };
    for (const s of b.secondary_identifiers ?? []) {
      const n = this.identity.normalize(s.type, s.value);
      const e = await this.entities.upsert(id, n, { confidence: 1, isSeed: true });
      touched.push(e.id);
      await this.db.query(
        `INSERT INTO cases.seed_entities(case_id, type, raw_value, normalized_value, entity_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, n.type, n.raw, n.canonicalKey, e.id, user.id],
      );
      // Analyst-supplied linkage: confirmed by intake, but it has no external evidence (status CANDIDATE until reviewed).
      const rel = await this.entities.relate(id, seedEntity.id, relFor[n.type] ?? 'ASSOCIATED_WITH', e.id, 0.9, {
        label: 'analyst-supplied secondary identifier',
        evidenceId: intake.evidenceId,
        sourceId: intakeSrc.id,
      });
      if (rel) rels.push(rel.id);
    }
    await this.entities.project(touched, rels);
    await this.audit.record({
      actor: user,
      action: 'case.seed.added',
      objectType: 'entity',
      objectId: seedEntity.id,
      caseId: id,
      requestId: rid,
      detail: { type: primary.type, secondary: (b.secondary_identifiers ?? []).map((s) => s.type), purpose: b.purpose ?? null },
    });
    return { entity: this.entities.present(seedEntity), secondary: touched.length - 1, queries: this.identity.expand(primary.type, primary.label) };
  }

  /**
   * Live sweep from universal search: seeds the identifier into a case (a new one with the documented purpose,
   * or an existing one) and runs every approved auto-run source against it.
   */
  @Post('sweep')
  @Roles('ADMIN', 'ANALYST')
  async sweep(
    @CurrentUser() user: AuthUser,
    @Body() b: { q: string; type?: string; caseId?: string; purpose?: string; legalBasis?: string },
    @RequestId() rid: string,
  ) {
    const q = (b.q ?? '').trim();
    if (q.length < 3) throw new BadRequestException('Enter at least 3 characters to sweep');
    let caseId = b.caseId;
    if (!caseId) {
      const c = await this.create(
        user,
        { title: `Sweep — ${q.slice(0, 80)}`, purpose: b.purpose ?? '', legalBasis: b.legalBasis, scope: 'Open-source discovery from universal search', classification: 'CONFIDENTIAL', retentionDays: 90 },
        rid,
      );
      caseId = c.id as string;
    }
    const seed = await this.addSeed(user, caseId, { type: b.type || undefined, value: q, purpose: b.purpose }, rid);
    const run = await this.collection.runInvestigation(user, caseId, { depth: 1 }, rid);
    return { caseId, seed: seed.entity, queued: run.queued.length, skipped: run.skipped.length, blockedSources: run.blockedSources };
  }

  /** Sweep results: every collected item with a public URL, plus candidate social accounts, newest first. */
  @Get(':id/sweep-results')
  async sweepResults(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.policy.assertCaseAccess(user, id, 'READ');
    const [items, accounts, jobs] = await Promise.all([
      this.db.query(
        `SELECT o.id, o.url, o.title, left(o.content_text, 400) AS snippet, o.author, o.published_at, o.observed_at, o.evidence_id,
                s.connector_key AS source_key, s.name AS source_name, s.category, s.tier
         FROM collection.observations o JOIN sources.sources s ON s.id = o.source_id
         WHERE o.case_id = $1 AND o.url ~ '^https?://' AND length(coalesce(o.content_text, '')) > 3
           AND s.connector_key NOT LIKE 'local.%'
         ORDER BY o.published_at DESC NULLS LAST, o.observed_at DESC LIMIT 600`,
        [id],
      ),
      this.db.query(
        `SELECT e.id, e.label, e.properties, e.confidence, e.resolution_status AS status,
                (SELECT max(r.confidence) FROM intelligence.relationships r
                   JOIN intelligence.entities s ON s.id = r.from_id AND s.is_seed WHERE r.to_id = e.id) AS link_confidence
         FROM intelligence.entities e
         WHERE e.case_id = $1 AND e.canonical_type = 'SOCIAL_ACCOUNT' AND e.resolution_status <> 'MERGED'
         ORDER BY link_confidence DESC NULLS LAST, e.label LIMIT 300`,
        [id],
      ),
      this.db.query(
        `SELECT j.status, s.connector_key, s.name AS source_name, j.result_summary, j.error
         FROM collection.collection_jobs j JOIN sources.sources s ON s.id = j.source_id
         WHERE j.case_id = $1 ORDER BY j.created_at`,
        [id],
      ),
    ]);
    return { items, accounts, jobs };
  }

  @Get(':id/timeline')
  async timeline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
  ) {
    await this.policy.assertCaseAccess(user, id, 'READ');
    const content = await this.db.query(
      `SELECT o.id, 'CONTENT' AS kind, COALESCE(o.published_at, o.observed_at) AS time, o.published_at IS NOT NULL AS dated,
              o.title, o.url, o.author, o.evidence_id, s.connector_key AS source, s.name AS source_name
       FROM collection.observations o JOIN sources.sources s ON s.id = o.source_id
       WHERE o.case_id = $1 AND o.content_text IS NOT NULL
         AND ($2::timestamptz IS NULL OR COALESCE(o.published_at, o.observed_at) >= $2)
         AND ($3::timestamptz IS NULL OR COALESCE(o.published_at, o.observed_at) <= $3)
         AND ($4::text IS NULL OR s.connector_key = $4)
       ORDER BY time DESC LIMIT 1000`,
      [id, from || null, to || null, source || null],
    );
    const events = await this.db.query(
      `SELECT e.id, 'EVENT' AS kind, (e.properties->>'date')::timestamptz AS time, true AS dated, e.label AS title
       FROM intelligence.entities e WHERE e.case_id = $1 AND e.canonical_type = 'EVENT' AND e.properties ? 'date'`,
      [id],
    );
    const findings = await this.db.query(
      `SELECT id, 'FINDING' AS kind, created_at AS time, true AS dated, title, status FROM intelligence.findings WHERE case_id = $1`,
      [id],
    );
    return [...content, ...events, ...findings].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }

  /** Internal authorised documents (Tier E): uploaded text/HTML/CSV/JSON is stored as evidence and extracted. */
  @Post(':id/documents')
  @Roles('ADMIN', 'ANALYST')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
    @Body() b: { title?: string; legalBasis?: string },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, id, 'EDIT');
    await this.policy.assertCaseCollectable(id);
    if (!file) throw new BadRequestException('file is required');
    if (!TEXT_TYPES.test(file.mimetype) && !/\.(txt|md|csv|json|html?)$/i.test(file.originalname)) {
      throw new BadRequestException('Only text, markdown, CSV, JSON and HTML documents are supported');
    }
    const raw = file.buffer.toString('utf8');
    const text = /html/i.test(file.mimetype) || /\.html?$/i.test(file.originalname) ? htmlToText(raw) : raw;
    const hash = sha256(file.buffer);
    const src = await this.sources.byKey('local.document-upload').catch(() => null);
    if (!src) throw new BadRequestException('Document upload source not registered');
    const title = b.title?.trim() || file.originalname;
    const summary = await this.ingest.ingest(
      { caseId: id, sourceId: src.id, sourceKey: src.connector_key, accessMethod: src.access_method, inputEntity: null, userId: user.id },
      {
        observations: [{ ref: 'doc', title, text: text.slice(0, 200000), author: user.username, raw: file.buffer, contentType: file.mimetype || 'text/plain', extract: true, entityRef: 'docEntity' }],
        entities: [{ ref: 'docEntity', type: 'DOCUMENT', value: title, hints: { hash }, properties: { filename: file.originalname, size: file.size, hash, uploaded_by: user.username, legal_basis: b.legalBasis ?? null }, confidence: 1, obsRef: 'doc' }],
        relationships: [],
      },
    );
    await this.audit.record({ actor: user, action: 'document.uploaded', objectType: 'document', objectId: hash, caseId: id, requestId: rid, detail: { filename: file.originalname, size: file.size, ...summary } });
    return summary;
  }

  @Post(':id/purge')
  @Roles('ADMIN')
  async purge(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { reason: string }, @RequestId() rid: string) {
    if (!b?.reason || b.reason.trim().length < 5) throw new BadRequestException('A purge reason is required');
    await this.retention.purge(id, user, b.reason, rid);
    return { purged: true };
  }
}
