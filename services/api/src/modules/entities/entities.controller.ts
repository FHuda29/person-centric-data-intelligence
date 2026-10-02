import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { GraphStoreService } from '../../common/graph-store.service';
import { AuthUser, RELATIONSHIP_TYPES } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { IdentityService } from '../identity/identity.service';
import { PolicyService } from '../policy/policy.service';
import { EntitiesService, EntityRow, RelRow } from './entities.service';

/** Structural graph metrics — position in the dataset, NOT evidence of coordination or intent (paper §8). */
export function graphMetrics(ents: EntityRow[], rels: RelRow[]) {
  const adj = new Map<string, Set<string>>();
  for (const e of ents) adj.set(e.id, new Set());
  for (const r of rels) {
    if (r.status === 'REJECTED') continue;
    adj.get(r.from_id)?.add(r.to_id);
    adj.get(r.to_id)?.add(r.from_id);
  }
  const n = Math.max(1, ents.length - 1);
  const degree = new Map([...adj].map(([id, s]) => [id, s.size / n]));
  // Connected components (BFS)
  const comp = new Map<string, number>();
  let c = 0;
  for (const id of adj.keys()) {
    if (comp.has(id)) continue;
    const q = [id];
    comp.set(id, c);
    while (q.length) {
      const x = q.shift()!;
      for (const y of adj.get(x) ?? []) if (!comp.has(y)) (comp.set(y, c), q.push(y));
    }
    c++;
  }
  // Brandes betweenness (unweighted) for graphs of manageable size.
  const betweenness = new Map<string, number>([...adj.keys()].map((k) => [k, 0]));
  if (adj.size <= 800) {
    for (const s of adj.keys()) {
      const stack: string[] = [];
      const pred = new Map<string, string[]>();
      const sigma = new Map<string, number>([[s, 1]]);
      const dist = new Map<string, number>([[s, 0]]);
      const q = [s];
      while (q.length) {
        const v = q.shift()!;
        stack.push(v);
        for (const w of adj.get(v) ?? []) {
          if (!dist.has(w)) (dist.set(w, dist.get(v)! + 1), q.push(w));
          if (dist.get(w) === dist.get(v)! + 1) {
            sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!);
            pred.set(w, [...(pred.get(w) ?? []), v]);
          }
        }
      }
      const delta = new Map<string, number>();
      while (stack.length) {
        const w = stack.pop()!;
        for (const v of pred.get(w) ?? []) {
          delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0)));
        }
        if (w !== s) betweenness.set(w, betweenness.get(w)! + (delta.get(w) ?? 0));
      }
    }
    const norm = adj.size > 2 ? (adj.size - 1) * (adj.size - 2) : 1;
    for (const [k, v] of betweenness) betweenness.set(k, v / norm);
  }
  return { degree, component: comp, components: c, betweenness };
}

@Controller()
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly identity: IdentityService,
    private readonly policy: PolicyService,
    private readonly graph: GraphStoreService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async load(user: AuthUser, id: string, need: 'READ' | 'EDIT' = 'READ') {
    const e = await this.entities.get(id);
    if (!e) throw new NotFoundException('Entity not found');
    await this.policy.assertCaseAccess(user, e.case_id, need);
    return e;
  }

  @Get('entities')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('caseId') caseId: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') limit = '200',
    @Query('offset') offset = '0',
  ) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    const params: unknown[] = [caseId];
    const where = ['case_id = $1', `resolution_status <> 'MERGED'`];
    if (type) where.push(`canonical_type = $${params.push(type)}`);
    if (status) where.push(`resolution_status = $${params.push(status)}`);
    if (q) where.push(`label ILIKE $${params.push(`%${q}%`)}`);
    const lim = Math.min(1000, Number(limit) || 200);
    const off = Math.max(0, Number(offset) || 0);
    const rows = await this.db.query<EntityRow & { degree: number }>(
      `SELECT e.*, (SELECT count(*) FROM intelligence.relationships r WHERE r.from_id = e.id OR r.to_id = e.id)::int AS degree
       FROM intelligence.entities e WHERE ${where.join(' AND ')}
       ORDER BY is_seed DESC, degree DESC, confidence DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    const total = await this.db.one<{ c: number }>(`SELECT count(*)::int AS c FROM intelligence.entities WHERE ${where.join(' AND ')}`, params);
    return { total: total?.c ?? 0, items: rows.map((r) => ({ ...this.entities.present(r), degree: r.degree })) };
  }

  /** Manually add an entity to the case graph (optionally linked to an existing entity). */
  @Post('entities')
  @Roles('ADMIN', 'ANALYST')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() b: { caseId: string; type: string; value: string; linkTo?: string; relType?: string; note?: string },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    const n = this.identity.normalize(b.type, b.value, { discriminator: `analyst:${Date.now().toString(36)}` });
    n.properties = { ...n.properties, source: 'analyst', analyst_note: b.note ?? null };
    const e = await this.entities.upsert(b.caseId, n, { confidence: 0.6 });
    const relIds: string[] = [];
    if (b.linkTo) {
      const other = await this.load(user, b.linkTo, 'EDIT');
      if (other.case_id !== b.caseId) throw new BadRequestException('linkTo must be in the same case');
      const type = (b.relType ?? 'ASSOCIATED_WITH').toUpperCase();
      if (!(RELATIONSHIP_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Invalid relType');
      const rel = await this.entities.relate(b.caseId, other.id, type, e.id, 0.5, { label: 'analyst assertion' });
      if (rel) relIds.push(rel.id);
    }
    await this.entities.project([e.id], relIds);
    await this.audit.record({ actor: user, action: 'entity.created', objectType: 'entity', objectId: e.id, caseId: b.caseId, requestId: rid, detail: { type: b.type } });
    return this.entities.present(e);
  }

  @Get('entities/:id')
  async profile(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const e = await this.load(user, id);
    const attrs = await this.db.query(
      `SELECT a.key, a.value, a.evidence_id, a.created_at, s.name AS source_name, s.connector_key
       FROM intelligence.entity_attributes a LEFT JOIN sources.sources s ON s.id = a.source_id
       WHERE a.entity_id = $1 ORDER BY a.key, a.created_at`,
      [id],
    );
    const rels = await this.db.query<RelRow & { other_id: string; direction: string }>(
      `SELECT r.*, CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END AS other_id,
              CASE WHEN r.from_id = $1 THEN 'OUT' ELSE 'IN' END AS direction
       FROM intelligence.relationships r WHERE r.from_id = $1 OR r.to_id = $1
       ORDER BY r.confidence DESC LIMIT 500`,
      [id],
    );
    const others = rels.length
      ? await this.db.query<EntityRow>('SELECT * FROM intelligence.entities WHERE id = ANY($1::uuid[])', [rels.map((r) => r.other_id)])
      : [];
    const byId = new Map(others.map((o) => [o.id, this.entities.present(o)]));
    const evidenceIds = [...new Set([...rels.map((r) => r.evidence_id), ...attrs.map((a) => a.evidence_id)].filter(Boolean))];
    const evidence = evidenceIds.length
      ? await this.db.query(
          `SELECT e.id, e.url, e.title, e.retrieved_at, e.published_at, e.hash, e.access_method, s.name AS source_name, s.tier
           FROM evidence.evidence e LEFT JOIN sources.sources s ON s.id = e.source_id WHERE e.id = ANY($1::uuid[])`,
          [evidenceIds],
        )
      : [];
    const candidates = await this.db.query(
      `SELECT rc.id, rc.score, rc.status, rc.signals,
              CASE WHEN rc.entity_a = $1 THEN rc.entity_b ELSE rc.entity_a END AS other_id,
              o.label AS other_label, o.canonical_key AS other_key
       FROM intelligence.resolution_candidates rc
       JOIN intelligence.entities o ON o.id = CASE WHEN rc.entity_a = $1 THEN rc.entity_b ELSE rc.entity_a END
       WHERE rc.entity_a = $1 OR rc.entity_b = $1 ORDER BY rc.score DESC`,
      [id],
    );
    const ctx = await this.entities.transformInput(e);
    return {
      entity: this.entities.present(e),
      attributes: attrs,
      relationships: rels.map((r) => ({ ...this.entities.presentRel(r), direction: r.direction, other: byId.get(r.other_id) })),
      evidence,
      resolutionCandidates: candidates.map((c) => ({ ...c, score: Number(c.score) })),
      searchExpansion: this.identity.expand(e.canonical_type, e.label, ctx.context),
    };
  }

  /** Reveals a masked identifier. Requires the PII-reveal permission and is always audited. */
  @Post('entities/:id/reveal')
  async reveal(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { reason?: string }, @RequestId() rid: string) {
    const e = await this.load(user, id);
    if (!user.canRevealPii) {
      await this.audit.record({ actor: user, action: 'pii.reveal.denied', objectType: 'entity', objectId: id, caseId: e.case_id, requestId: rid });
      throw new ForbiddenException('PII reveal permission required');
    }
    if (!b?.reason || b.reason.trim().length < 5) throw new BadRequestException('A reason is required to reveal PII');
    await this.audit.record({ actor: user, action: 'pii.reveal', objectType: 'entity', objectId: id, caseId: e.case_id, requestId: rid, detail: { reason: b.reason, type: e.canonical_type } });
    return this.entities.present(e, true);
  }

  @Post('entities/:id/status')
  @Roles('ADMIN', 'ANALYST')
  async setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { status: string; note?: string }, @RequestId() rid: string) {
    const e = await this.load(user, id, 'EDIT');
    if (!['CANDIDATE', 'RESOLVED', 'REJECTED'].includes(b.status)) throw new BadRequestException('Invalid status');
    const row = await this.db.one<EntityRow>(
      `UPDATE intelligence.entities SET resolution_status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.status],
    );
    await this.entities.project([id], []);
    await this.audit.record({ actor: user, action: 'entity.review', objectType: 'entity', objectId: id, caseId: e.case_id, requestId: rid, detail: { from: e.resolution_status, to: b.status, note: b.note } });
    return this.entities.present(row!);
  }

  @Post('relationships/:id/review')
  @Roles('ADMIN', 'ANALYST')
  async reviewRel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() b: { status: string; note?: string }, @RequestId() rid: string) {
    const r = await this.db.one<RelRow>('SELECT * FROM intelligence.relationships WHERE id = $1', [id]);
    if (!r) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, r.case_id, 'EDIT');
    if (!['CANDIDATE', 'CONFIRMED', 'REJECTED'].includes(b.status)) throw new BadRequestException('Invalid status');
    if (b.status === 'CONFIRMED' && !r.evidence_id) throw new BadRequestException('Cannot confirm a relationship without evidence');
    const row = await this.db.one<RelRow>('UPDATE intelligence.relationships SET status = $2 WHERE id = $1 RETURNING *', [id, b.status]);
    await this.entities.project([], [id]);
    await this.audit.record({ actor: user, action: 'relationship.review', objectType: 'relationship', objectId: id, caseId: r.case_id, requestId: rid, detail: { from: r.status, to: b.status, note: b.note } });
    return this.entities.presentRel(row!);
  }

  private async graphPayload(ents: EntityRow[], rels: RelRow[]) {
    const m = graphMetrics(ents, rels);
    return {
      nodes: ents.map((e) => ({
        ...this.entities.present(e),
        degree: Number((m.degree.get(e.id) ?? 0).toFixed(4)),
        betweenness: Number((m.betweenness.get(e.id) ?? 0).toFixed(4)),
        component: m.component.get(e.id) ?? 0,
      })),
      edges: rels.map((r) => this.entities.presentRel(r)),
      components: m.components,
    };
  }

  @Get('graph')
  async caseGraph(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    const { ents, rels } = await this.entities.caseGraph(caseId);
    return { ...(await this.graphPayload(ents, rels)), engine: this.graph.available ? 'neo4j+postgres' : 'postgres' };
  }

  @Get('entities/:id/neighbors')
  async neighbors(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('depth') depth = '1') {
    await this.load(user, id);
    const d = Math.max(1, Math.min(3, Number(depth) || 1));
    const hood = this.graph.available ? await this.graph.neighborhood(id, d, 400) : await this.entities.neighborhoodPg(id, d);
    const { ents, rels } = await this.entities.subgraph(hood.nodeIds, hood.edgeIds);
    return { ...(await this.graphPayload(ents, rels)), engine: this.graph.available ? 'neo4j' : 'postgres' };
  }

  @Get('entities/:id/path/:other')
  async path(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('other') other: string) {
    const a = await this.load(user, id);
    const b = await this.load(user, other);
    if (a.case_id !== b.case_id) throw new BadRequestException('Entities belong to different cases');
    if (!this.graph.available) throw new BadRequestException('Shortest path requires the Neo4j graph store');
    const p = await this.graph.shortestPath(id, other);
    if (!p) return { found: false, nodes: [], edges: [] };
    const { ents, rels } = await this.entities.subgraph(p.nodeIds, p.edgeIds);
    return { found: true, order: p.nodeIds, ...(await this.graphPayload(ents, rels)) };
  }

  @Post('graph/rebuild')
  @Roles('ADMIN', 'ANALYST')
  async rebuild(@CurrentUser() user: AuthUser, @Body() b: { caseId: string }) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    return this.entities.rebuildCaseProjection(b.caseId);
  }
}
