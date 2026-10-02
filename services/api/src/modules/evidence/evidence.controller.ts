import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { StorageService } from '../../common/storage.service';
import { AuthUser, CLAIM_TYPES, FINDING_STATUSES } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';

@Controller('evidence')
export class EvidenceController {
  constructor(
    private readonly db: DbService,
    private readonly policy: PolicyService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('caseId') caseId: string,
    @Query('q') q?: string,
    @Query('sourceKey') sourceKey?: string,
    @Query('limit') limit = '200',
    @Query('offset') offset = '0',
  ) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    const params: unknown[] = [caseId];
    const where = ['e.case_id = $1'];
    if (q) where.push(`(e.title ILIKE $${params.push(`%${q}%`)} OR e.url ILIKE $${params.length} OR e.excerpt ILIKE $${params.length})`);
    if (sourceKey) where.push(`s.connector_key = $${params.push(sourceKey)}`);
    const rows = await this.db.query(
      `SELECT e.id, e.url, e.title, e.published_at, e.retrieved_at, e.access_method, e.hash, e.excerpt, e.content_type,
              e.collector_version, s.name AS source_name, s.connector_key, s.tier
       FROM evidence.evidence e LEFT JOIN sources.sources s ON s.id = e.source_id
       WHERE ${where.join(' AND ')} ORDER BY e.retrieved_at DESC
       LIMIT ${Math.min(1000, Number(limit) || 200)} OFFSET ${Math.max(0, Number(offset) || 0)}`,
      params,
    );
    const total = await this.db.one<{ c: number }>(
      `SELECT count(*)::int AS c FROM evidence.evidence e LEFT JOIN sources.sources s ON s.id = e.source_id WHERE ${where.join(' AND ')}`,
      params,
    );
    return { total: total?.c ?? 0, items: rows };
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const e = await this.db.one(
      `SELECT e.*, s.name AS source_name, s.connector_key, s.tier, s.legal_basis, u.username AS created_by_name
       FROM evidence.evidence e LEFT JOIN sources.sources s ON s.id = e.source_id
       LEFT JOIN iam.users u ON u.id = e.created_by WHERE e.id = $1`,
      [id],
    );
    if (!e) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, e.case_id, 'READ');
    const usedBy = await this.db.query(
      `SELECT r.id, r.type, r.confidence, r.status, a.label AS from_label, b.label AS to_label
       FROM intelligence.relationships r JOIN intelligence.entities a ON a.id = r.from_id
       JOIN intelligence.entities b ON b.id = r.to_id WHERE r.evidence_id = $1 LIMIT 100`,
      [id],
    );
    const findings = await this.db.query(
      `SELECT f.id, f.title, f.status FROM intelligence.findings f
       JOIN intelligence.finding_evidence fe ON fe.finding_id = f.id WHERE fe.evidence_id = $1`,
      [id],
    );
    return { ...e, relationships: usedBy, findings };
  }

  /** Streams the raw evidence object. Viewing raw content is audited. */
  @Get(':id/raw')
  async raw(@CurrentUser() user: AuthUser, @Param('id') id: string, @RequestId() rid: string, @Res() res: Response) {
    const e = await this.db.one('SELECT case_id, object_ref, content_type, hash FROM evidence.evidence WHERE id = $1', [id]);
    if (!e?.object_ref) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, e.case_id, 'READ');
    await this.audit.record({ actor: user, action: 'evidence.raw.view', objectType: 'evidence', objectId: id, caseId: e.case_id, requestId: rid });
    const buf = await this.storage.getBuffer(e.object_ref);
    // Served as plain text so stored HTML can never execute in the console origin.
    res.setHeader('Content-Type', e.content_type?.includes('json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('X-Content-SHA256', e.hash);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(buf);
  }
}

@Controller('findings')
export class FindingsController {
  constructor(
    private readonly db: DbService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    return this.db.query(
      `SELECT f.*, cu.username AS created_by_name, ru.username AS reviewed_by_name,
         COALESCE((SELECT json_agg(json_build_object('id', e.id, 'title', e.title, 'url', e.url, 'retrieved_at', e.retrieved_at,
             'hash', e.hash, 'source', s.name))
           FROM intelligence.finding_evidence fe JOIN evidence.evidence e ON e.id = fe.evidence_id
           LEFT JOIN sources.sources s ON s.id = e.source_id WHERE fe.finding_id = f.id), '[]') AS evidence,
         COALESCE((SELECT json_agg(json_build_object('id', x.id, 'label', x.label, 'type', x.canonical_type))
           FROM intelligence.entities x WHERE x.id = ANY(f.entity_ids)), '[]') AS entities
       FROM intelligence.findings f LEFT JOIN iam.users cu ON cu.id = f.created_by LEFT JOIN iam.users ru ON ru.id = f.reviewed_by
       WHERE f.case_id = $1 ORDER BY f.created_at DESC`,
      [caseId],
    );
  }

  /** Distinct independent sources behind a set of evidence (by publisher host, else by source). */
  private async independentSources(evidenceIds: string[]) {
    const rows = await this.db.query<{ k: string }>(
      `SELECT DISTINCT COALESCE(NULLIF(split_part(split_part(e.url, '://', 2), '/', 1), ''), e.source_id::text) AS k
       FROM evidence.evidence e WHERE e.id = ANY($1::uuid[])`,
      [evidenceIds],
    );
    return rows.length;
  }

  @Post()
  @Roles('ADMIN', 'ANALYST')
  async create(
    @CurrentUser() user: AuthUser,
    @Body()
    b: { caseId: string; title: string; statement: string; claimType?: string; confidence?: number; entityIds?: string[]; evidenceIds: string[] },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    if (!b.title?.trim() || !b.statement?.trim()) throw new BadRequestException('Title and statement are required');
    if (!b.evidenceIds?.length) throw new BadRequestException('Every finding requires at least one evidence reference');
    if (b.claimType && !(CLAIM_TYPES as readonly string[]).includes(b.claimType)) throw new BadRequestException('Invalid claimType');
    const ev = await this.db.query('SELECT id FROM evidence.evidence WHERE case_id = $1 AND id = ANY($2::uuid[])', [b.caseId, b.evidenceIds]);
    if (ev.length !== new Set(b.evidenceIds).size) throw new BadRequestException('Evidence must belong to the same case');
    const f = await this.db.tx(async (t) => {
      const row = await this.db.one(
        `INSERT INTO intelligence.findings(case_id, title, statement, claim_type, confidence, entity_ids, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.caseId, b.title.trim(), b.statement.trim(), b.claimType ?? 'OBSERVED_FACT', Math.max(0, Math.min(1, b.confidence ?? 0.5)), b.entityIds ?? [], user.id],
        t,
      );
      for (const e of new Set(b.evidenceIds)) {
        await t.query('INSERT INTO intelligence.finding_evidence(finding_id, evidence_id) VALUES ($1,$2)', [row.id, e]);
      }
      return row;
    });
    await this.audit.record({ actor: user, action: 'finding.created', objectType: 'finding', objectId: f.id, caseId: b.caseId, requestId: rid, detail: { evidence: b.evidenceIds.length } });
    return f;
  }

  /** Analyst review: sets the evidence status (paper §9) with operational checks. */
  @Post(':id/review')
  @Roles('ADMIN', 'ANALYST')
  async review(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() b: { status: string; analystNote?: string; confidence?: number; addEvidenceIds?: string[] },
    @RequestId() rid: string,
  ) {
    const f = await this.db.one('SELECT * FROM intelligence.findings WHERE id = $1', [id]);
    if (!f) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, f.case_id, 'EDIT');
    if (!(FINDING_STATUSES as readonly string[]).includes(b.status)) throw new BadRequestException('Invalid status');
    if (b.addEvidenceIds?.length) {
      const ok = await this.db.query('SELECT id FROM evidence.evidence WHERE case_id = $1 AND id = ANY($2::uuid[])', [f.case_id, b.addEvidenceIds]);
      for (const e of ok) {
        await this.db.query('INSERT INTO intelligence.finding_evidence VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, e.id]);
      }
    }
    const evIds = (await this.db.query<{ evidence_id: string }>('SELECT evidence_id FROM intelligence.finding_evidence WHERE finding_id = $1', [id])).map((r) => r.evidence_id);
    if (b.status === 'CORROBORATED' && (await this.independentSources(evIds)) < 2) {
      throw new BadRequestException('CORROBORATED requires evidence from two or more independent sources');
    }
    if (['CONFIRMED', 'CONTRADICTED', 'REJECTED'].includes(b.status) && !(b.analystNote ?? f.analyst_note)?.trim()) {
      throw new BadRequestException(`${b.status} requires an analyst note`);
    }
    const row = await this.db.one(
      `UPDATE intelligence.findings SET status = $2, analyst_note = COALESCE($3, analyst_note),
         confidence = COALESCE($4, confidence), reviewed_by = $5, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.status, b.analystNote ?? null, b.confidence ?? null, user.id],
    );
    await this.audit.record({ actor: user, action: 'finding.review', objectType: 'finding', objectId: id, caseId: f.case_id, requestId: rid, detail: { from: f.status, to: b.status } });
    return row;
  }
}
