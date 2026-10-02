import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { config } from '../../config';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { GraphStoreService } from '../../common/graph-store.service';
import { jaroWinkler, nameKey, normalizeName } from '../../common/text';
import { AuthUser } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { EntitiesService, EntityRow } from '../entities/entities.service';
import { PolicyService } from '../policy/policy.service';

/** Baseline engineering weights from paper §7 — to be calibrated against a labelled test set. */
export const WEIGHTS = {
  phone: 0.35,
  email: 0.3,
  name: 0.15,
  organization: 0.08,
  location: 0.05,
  username: 0.05,
  temporal: 0.02,
};
export const THRESHOLDS = { candidate: 0.55, reviewReady: 0.8 };

interface Profile {
  e: EntityRow;
  name: string;
  phones: Set<string>;
  emails: Map<string, boolean>; // id -> generic mailbox?
  orgs: Set<string>;
  locations: Set<string>;
  handles: string[];
  birthYear?: string;
}

@Injectable()
export class ResolutionService {
  private readonly log = new Logger('Resolution');
  constructor(
    private readonly db: DbService,
    private readonly entities: EntitiesService,
    private readonly graph: GraphStoreService,
    private readonly audit: AuditService,
  ) {}

  private async profiles(caseId: string): Promise<Profile[]> {
    const persons = await this.db.query<EntityRow>(
      `SELECT * FROM intelligence.entities WHERE case_id = $1 AND canonical_type = 'PERSON'
       AND resolution_status IN ('CANDIDATE','RESOLVED') ORDER BY is_seed DESC, confidence DESC LIMIT 400`,
      [caseId],
    );
    if (!persons.length) return [];
    const links = await this.db.query<{ pid: string; type: string; nid: string; label: string; key: string; props: any }>(
      `SELECT p.id AS pid, n.canonical_type AS type, n.id AS nid, n.label, n.canonical_key AS key, n.properties AS props
       FROM intelligence.entities p
       JOIN intelligence.relationships r ON (r.from_id = p.id OR r.to_id = p.id) AND r.status <> 'REJECTED'
       JOIN intelligence.entities n ON n.id = CASE WHEN r.from_id = p.id THEN r.to_id ELSE r.from_id END
       WHERE p.id = ANY($1::uuid[])`,
      [persons.map((p) => p.id)],
    );
    const attrs = await this.db.query<{ entity_id: string; value: string }>(
      `SELECT entity_id, value FROM intelligence.entity_attributes WHERE key = 'birth_year' AND entity_id = ANY($1::uuid[])`,
      [persons.map((p) => p.id)],
    );
    return persons.map((e) => {
      const mine = links.filter((l) => l.pid === e.id);
      const handles = mine
        .filter((l) => l.type === 'USERNAME' || l.type === 'SOCIAL_ACCOUNT')
        .map((l) => String(l.props?.handle ?? l.key.split(':').pop() ?? '').toLowerCase());
      return {
        e,
        name: nameKey(e.label),
        phones: new Set(mine.filter((l) => l.type === 'PHONE').map((l) => l.nid)),
        emails: new Map(mine.filter((l) => l.type === 'EMAIL').map((l) => [l.nid, !!l.props?.generic_mailbox] as [string, boolean])),
        orgs: new Set(mine.filter((l) => l.type === 'ORGANIZATION').map((l) => normalizeName(l.label))),
        locations: new Set(mine.filter((l) => l.type === 'LOCATION').map((l) => normalizeName(l.label))),
        handles,
        birthYear: attrs.find((a) => a.entity_id === e.id)?.value ?? (e.properties?.birth_year as string | undefined),
      };
    });
  }

  /** score = Σ(weight_i · signal_i) − conflict_penalty ; status = policy(score, deterministic, conflicts). */
  score(a: Profile, b: Profile) {
    const signals: Record<string, number> = {};
    const shared = <T>(x: Set<T>, y: Set<T>) => [...x].some((v) => y.has(v));
    signals.phone = shared(a.phones, b.phones) ? 1 : 0;
    const sharedEmails = [...a.emails.keys()].filter((k) => b.emails.has(k));
    signals.email = sharedEmails.length ? (sharedEmails.every((k) => a.emails.get(k)) ? 0.4 : 1) : 0;
    signals.name = jaroWinkler(a.name, b.name);
    signals.organization = shared(a.orgs, b.orgs) ? 1 : 0;
    signals.location = shared(a.locations, b.locations) ? 1 : 0;
    let u = 0;
    for (const x of a.handles) for (const y of b.handles) u = Math.max(u, jaroWinkler(x, y));
    signals.username = u >= 0.85 ? u : 0;
    const conflicts: string[] = [];
    if (a.birthYear && b.birthYear && a.birthYear !== b.birthYear) conflicts.push(`birth year ${a.birthYear} vs ${b.birthYear}`);
    signals.temporal = conflicts.length ? 0 : 1;
    const penalty = conflicts.length ? 0.4 : 0;
    let score = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) score += w * (signals[k] ?? 0);
    score = Math.max(0, Math.min(1, score - penalty));
    const deterministic = signals.phone === 1 || signals.email === 1;
    let status: 'UNRESOLVED' | 'CANDIDATE' | 'REVIEW_READY' =
      score >= THRESHOLDS.reviewReady ? 'REVIEW_READY' : score >= THRESHOLDS.candidate ? 'CANDIDATE' : 'UNRESOLVED';
    // Guard-rail: without a deterministic identifier a pair can never be review-ready (no merge on name alone).
    if (!deterministic && status === 'REVIEW_READY') status = 'CANDIDATE';
    return { score: Number(score.toFixed(3)), signals, conflicts, deterministic, status, penalty };
  }

  /** Recomputes candidate pairs for a case. Reviewed pairs (MERGED/REJECTED) are never overwritten. */
  async recompute(caseId: string): Promise<{ pairs: number; autoMerged: number }> {
    const ps = await this.profiles(caseId);
    let pairs = 0;
    let autoMerged = 0;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const [a, b] = [ps[i], ps[j]];
        const quickName = jaroWinkler(a.name, b.name);
        const shareId = [...a.phones].some((x) => b.phones.has(x)) || [...a.emails.keys()].some((x) => b.emails.has(x));
        if (quickName < 0.8 && !shareId) continue;
        const s = this.score(a, b);
        if (s.score < 0.1) continue;
        const [x, y] = a.e.id < b.e.id ? [a.e.id, b.e.id] : [b.e.id, a.e.id];
        await this.db.query(
          `INSERT INTO intelligence.resolution_candidates(case_id, entity_a, entity_b, score, signals, deterministic, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (entity_a, entity_b) DO UPDATE SET score = EXCLUDED.score, signals = EXCLUDED.signals,
             deterministic = EXCLUDED.deterministic, updated_at = now(),
             status = CASE WHEN intelligence.resolution_candidates.status IN ('MERGED','REJECTED')
                           THEN intelligence.resolution_candidates.status ELSE EXCLUDED.status END`,
          [caseId, x, y, s.score, JSON.stringify({ ...s.signals, _conflicts: s.conflicts, _penalty: s.penalty }), s.deterministic, s.status],
        );
        pairs++;
        if (config.autoMergeDeterministic && s.deterministic && s.status === 'REVIEW_READY' && !s.conflicts.length) {
          const cand = await this.db.one('SELECT id, status FROM intelligence.resolution_candidates WHERE entity_a = $1 AND entity_b = $2', [x, y]);
          if (cand?.status === 'REVIEW_READY') {
            await this.merge(null, cand.id, a.e.is_seed ? a.e.id : b.e.id, 'auto-merge: deterministic identifier policy', null);
            autoMerged++;
          }
        }
      }
    }
    return { pairs, autoMerged };
  }

  async list(caseId: string, status?: string) {
    const rows = await this.db.query(
      `SELECT rc.*, a.label AS a_label, a.properties AS a_props, a.is_seed AS a_seed, a.canonical_key AS a_key,
              b.label AS b_label, b.properties AS b_props, b.is_seed AS b_seed, b.canonical_key AS b_key
       FROM intelligence.resolution_candidates rc
       JOIN intelligence.entities a ON a.id = rc.entity_a
       JOIN intelligence.entities b ON b.id = rc.entity_b
       WHERE rc.case_id = $1 ${status ? 'AND rc.status = $2' : ''}
       ORDER BY CASE rc.status WHEN 'REVIEW_READY' THEN 0 WHEN 'CANDIDATE' THEN 1 WHEN 'UNRESOLVED' THEN 2 ELSE 3 END, rc.score DESC`,
      status ? [caseId, status] : [caseId],
    );
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  /** Merges `loser` into `survivor`: relationships and attributes move, loser becomes MERGED. */
  async merge(user: AuthUser | null, candidateId: string, survivorId: string, note: string, requestId: string | null) {
    const c = await this.db.one('SELECT * FROM intelligence.resolution_candidates WHERE id = $1', [candidateId]);
    if (!c) throw new NotFoundException('Candidate not found');
    if (['MERGED', 'REJECTED'].includes(c.status)) throw new BadRequestException(`Candidate already ${c.status}`);
    if (![c.entity_a, c.entity_b].includes(survivorId)) throw new BadRequestException('Survivor must be one of the pair');
    const loserId = survivorId === c.entity_a ? c.entity_b : c.entity_a;
    const loser = await this.entities.get(loserId);
    await this.db.tx(async (t) => {
      // Move relationships; drop the ones that would duplicate an existing edge.
      await t.query(
        `DELETE FROM intelligence.relationships r WHERE r.from_id = $1 AND EXISTS (
           SELECT 1 FROM intelligence.relationships x WHERE x.from_id = $2 AND x.type = r.type AND x.to_id = r.to_id)`,
        [loserId, survivorId],
      );
      await t.query(
        `DELETE FROM intelligence.relationships r WHERE r.to_id = $1 AND EXISTS (
           SELECT 1 FROM intelligence.relationships x WHERE x.to_id = $2 AND x.type = r.type AND x.from_id = r.from_id)`,
        [loserId, survivorId],
      );
      await t.query(`UPDATE intelligence.relationships SET from_id = $2 WHERE from_id = $1`, [loserId, survivorId]);
      await t.query(`UPDATE intelligence.relationships SET to_id = $2 WHERE to_id = $1`, [loserId, survivorId]);
      await t.query(`DELETE FROM intelligence.relationships WHERE from_id = to_id`);
      await t.query(
        `INSERT INTO intelligence.entity_attributes(entity_id, key, value, source_id, evidence_id)
         SELECT $2, key, value, source_id, evidence_id FROM intelligence.entity_attributes WHERE entity_id = $1
         ON CONFLICT DO NOTHING`,
        [loserId, survivorId],
      );
      await t.query(
        `UPDATE intelligence.entities SET
           properties = jsonb_set(properties, '{aliases}',
             (COALESCE(properties->'aliases','[]'::jsonb) || to_jsonb($3::text))),
           resolution_status = 'RESOLVED', updated_at = now()
         WHERE id = $2`,
        [loserId, survivorId, loser?.label ?? ''],
      );
      await t.query(
        `UPDATE intelligence.entities SET resolution_status = 'MERGED', merged_into = $2, updated_at = now() WHERE id = $1`,
        [loserId, survivorId],
      );
      await t.query(
        `UPDATE intelligence.resolution_candidates SET status = 'MERGED', reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [candidateId, user?.id ?? null],
      );
      // Other open pairs involving the loser are obsolete.
      await t.query(
        `UPDATE intelligence.resolution_candidates SET status = 'REJECTED', updated_at = now()
         WHERE id <> $1 AND (entity_a = $2 OR entity_b = $2) AND status NOT IN ('MERGED','REJECTED')`,
        [candidateId, loserId],
      );
    });
    await this.graph.deleteNode(loserId);
    const rels = await this.db.query<{ id: string }>(
      'SELECT id FROM intelligence.relationships WHERE from_id = $1 OR to_id = $1',
      [survivorId],
    );
    await this.entities.project([survivorId], rels.map((r) => r.id));
    await this.audit.record({
      actor: user,
      action: user ? 'resolution.merge' : 'resolution.auto_merge',
      objectType: 'entity',
      objectId: survivorId,
      caseId: c.case_id,
      requestId,
      detail: { candidateId, merged: loserId, score: Number(c.score), signals: c.signals, note },
    });
    return { survivorId, mergedId: loserId };
  }

  async reject(user: AuthUser, candidateId: string, note: string, requestId: string) {
    const c = await this.db.one(
      `UPDATE intelligence.resolution_candidates SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND status NOT IN ('MERGED') RETURNING *`,
      [candidateId, user.id],
    );
    if (!c) throw new NotFoundException('Candidate not found or already merged');
    await this.audit.record({ actor: user, action: 'resolution.reject', objectType: 'resolution_candidate', objectId: candidateId, caseId: c.case_id, requestId, detail: { note } });
    return c;
  }
}

@Controller('resolution')
export class ResolutionController {
  constructor(
    private readonly resolution: ResolutionService,
    private readonly policy: PolicyService,
    private readonly db: DbService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string, @Query('status') status?: string) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    return { weights: WEIGHTS, thresholds: THRESHOLDS, autoMergeDeterministic: config.autoMergeDeterministic, candidates: await this.resolution.list(caseId, status) };
  }

  @Post('recompute')
  @Roles('ADMIN', 'ANALYST')
  async recompute(@CurrentUser() user: AuthUser, @Body() b: { caseId: string }) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    return this.resolution.recompute(b.caseId);
  }

  private async caseOf(candidateId: string) {
    const c = await this.db.one('SELECT case_id FROM intelligence.resolution_candidates WHERE id = $1', [candidateId]);
    if (!c) throw new NotFoundException();
    return c.case_id as string;
  }

  @Post(':id/merge')
  @Roles('ADMIN', 'ANALYST')
  async merge(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { survivorId: string; note?: string }, @RequestId() rid: string) {
    await this.policy.assertCaseAccess(user, await this.caseOf(id), 'EDIT');
    if (!b.note || b.note.trim().length < 5) throw new BadRequestException('A review note is required for merges');
    return this.resolution.merge(user, id, b.survivorId, b.note, rid);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'ANALYST')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { note?: string }, @RequestId() rid: string) {
    await this.policy.assertCaseAccess(user, await this.caseOf(id), 'EDIT');
    return this.resolution.reject(user, id, b.note ?? '', rid);
  }
}
