import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../common/db.service';
import { GraphStoreService } from '../../common/graph-store.service';
import { ENT_INDEX, SearchIndexService } from '../../common/search-index.service';
import { maskValue } from '../../common/text';
import { AuthUser, PII_TYPES } from '../../common/types';
import { Normalized } from '../identity/identity.service';
import { TransformInput } from '../connectors/connector.types';

export interface EntityRow {
  id: string;
  case_id: string;
  canonical_type: string;
  canonical_key: string;
  label: string;
  properties: Record<string, any>;
  confidence: number;
  resolution_status: string;
  merged_into: string | null;
  is_seed: boolean;
  first_seen: string;
  last_seen: string;
}

export interface RelRow {
  id: string;
  case_id: string;
  from_id: string;
  type: string;
  to_id: string;
  confidence: number;
  status: string;
  label: string | null;
  evidence_id: string | null;
  source_id: string | null;
}

const num = (v: unknown) => Number(v);

@Injectable()
export class EntitiesService {
  constructor(
    private readonly db: DbService,
    private readonly graph: GraphStoreService,
    private readonly index: SearchIndexService,
  ) {}

  async get(id: string): Promise<EntityRow | null> {
    return this.db.one<EntityRow>('SELECT * FROM intelligence.entities WHERE id = $1', [id]);
  }

  /** Upsert by (case, type, canonical key). Merged entities resolve to their survivor. */
  async upsert(
    caseId: string,
    n: Normalized,
    opts: { confidence?: number; isSeed?: boolean; client?: PoolClient } = {},
  ): Promise<EntityRow> {
    const row = await this.db.one<EntityRow>(
      `INSERT INTO intelligence.entities(case_id, canonical_type, canonical_key, label, properties, confidence, is_seed, resolution_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (case_id, canonical_type, canonical_key) DO UPDATE SET
         properties = intelligence.entities.properties || EXCLUDED.properties,
         confidence = GREATEST(intelligence.entities.confidence, EXCLUDED.confidence),
         is_seed = intelligence.entities.is_seed OR EXCLUDED.is_seed,
         resolution_status = CASE WHEN EXCLUDED.is_seed AND intelligence.entities.resolution_status = 'CANDIDATE'
                                  THEN 'RESOLVED' ELSE intelligence.entities.resolution_status END,
         last_seen = now(), updated_at = now()
       RETURNING *`,
      [
        caseId,
        n.type,
        n.canonicalKey,
        n.label,
        JSON.stringify(n.properties ?? {}),
        opts.confidence ?? 0.5,
        !!opts.isSeed,
        opts.isSeed ? 'RESOLVED' : 'CANDIDATE',
      ],
      opts.client,
    );
    if (row!.merged_into) return (await this.get(row!.merged_into)) ?? row!;
    return row!;
  }

  async addAttribute(entityId: string, key: string, value: string, sourceId: string | null, evidenceId: string | null) {
    await this.db.query(
      `INSERT INTO intelligence.entity_attributes(entity_id, key, value, source_id, evidence_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entity_id, key, value) DO NOTHING`,
      [entityId, key, value.slice(0, 2000), sourceId, evidenceId],
    );
  }

  async relate(
    caseId: string,
    fromId: string,
    type: string,
    toId: string,
    confidence: number,
    extra: { label?: string | null; evidenceId?: string | null; sourceId?: string | null } = {},
  ): Promise<RelRow | null> {
    if (fromId === toId) return null;
    return this.db.one<RelRow>(
      `INSERT INTO intelligence.relationships(case_id, from_id, type, to_id, confidence, label, evidence_id, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (from_id, type, to_id) DO UPDATE SET
         confidence = GREATEST(intelligence.relationships.confidence, EXCLUDED.confidence),
         label = COALESCE(intelligence.relationships.label, EXCLUDED.label),
         evidence_id = COALESCE(intelligence.relationships.evidence_id, EXCLUDED.evidence_id)
       RETURNING *`,
      [caseId, fromId, type, toId, confidence, extra.label ?? null, extra.evidenceId ?? null, extra.sourceId ?? null],
    );
  }

  /** Pushes entities/relationships to the Neo4j projection and the OpenSearch entity index. */
  async project(entityIds: string[], relIds: string[]): Promise<void> {
    const ents = entityIds.length
      ? await this.db.query<EntityRow>('SELECT * FROM intelligence.entities WHERE id = ANY($1::uuid[])', [entityIds])
      : [];
    await this.graph.upsertNodes(
      ents
        .filter((e) => e.resolution_status !== 'MERGED')
        .map((e) => ({
          id: e.id,
          caseId: e.case_id,
          type: e.canonical_type,
          label: PII_TYPES.has(e.canonical_type) ? maskValue(e.canonical_type, e.label) : e.label,
          confidence: num(e.confidence),
          status: e.resolution_status,
        })),
    );
    for (const e of ents) {
      await this.index.indexDoc(ENT_INDEX, e.id, {
        case_id: e.case_id,
        type: e.canonical_type,
        label: e.label,
        canonical_key: e.canonical_key,
        properties_text: Object.values(e.properties ?? {}).filter((v) => typeof v === 'string').join(' '),
        first_seen: e.first_seen,
      });
    }
    const rels = relIds.length
      ? await this.db.query<RelRow>('SELECT * FROM intelligence.relationships WHERE id = ANY($1::uuid[])', [relIds])
      : [];
    await this.graph.upsertEdges(
      rels.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        from: r.from_id,
        to: r.to_id,
        type: r.type,
        confidence: num(r.confidence),
        status: r.status,
        label: r.label,
      })),
    );
  }

  /** Re-projects a whole case into Neo4j (used after merges or when Neo4j was unavailable). */
  async rebuildCaseProjection(caseId: string): Promise<{ nodes: number; edges: number }> {
    await this.graph.deleteCase(caseId);
    const ents = await this.db.query<{ id: string }>(
      `SELECT id FROM intelligence.entities WHERE case_id = $1 AND resolution_status <> 'MERGED'`,
      [caseId],
    );
    const rels = await this.db.query<{ id: string }>('SELECT id FROM intelligence.relationships WHERE case_id = $1', [caseId]);
    for (let i = 0; i < ents.length; i += 500) await this.project(ents.slice(i, i + 500).map((e) => e.id), []);
    for (let i = 0; i < rels.length; i += 500) await this.project([], rels.slice(i, i + 500).map((r) => r.id));
    return { nodes: ents.length, edges: rels.length };
  }

  /** Presentation with PII masking unless explicitly revealed. */
  present(e: EntityRow, reveal = false) {
    const pii = PII_TYPES.has(e.canonical_type);
    const masked = pii && !reveal;
    const props = { ...(e.properties ?? {}) };
    if (masked) for (const k of ['e164', 'address', 'national', 'international', 'local_part', 'whatsapp_namespace']) {
      if (props[k]) props[k] = maskValue(e.canonical_type, String(props[k]));
    }
    return {
      id: e.id,
      caseId: e.case_id,
      type: e.canonical_type,
      label: masked ? maskValue(e.canonical_type, e.label) : e.label,
      masked,
      properties: props,
      confidence: num(e.confidence),
      status: e.resolution_status,
      mergedInto: e.merged_into,
      isSeed: e.is_seed,
      firstSeen: e.first_seen,
      lastSeen: e.last_seen,
    };
  }

  presentRel(r: RelRow) {
    return {
      id: r.id,
      from: r.from_id,
      to: r.to_id,
      type: r.type,
      confidence: num(r.confidence),
      status: r.status,
      label: r.label,
      evidenceId: r.evidence_id,
      sourceId: r.source_id,
    };
  }

  /** Context for transforms: organisations, cities and CONFIRMED identifiers linked to the entity. */
  async transformInput(e: EntityRow): Promise<TransformInput> {
    const linked = await this.db.query<{ canonical_type: string; label: string; status: string }>(
      `SELECT n.canonical_type, n.label, r.status FROM intelligence.relationships r
       JOIN intelligence.entities n ON n.id = CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END
       WHERE (r.from_id = $1 OR r.to_id = $1) AND r.status <> 'REJECTED'`,
      [e.id],
    );
    const of = (t: string, confirmedOnly = false) =>
      linked.filter((l) => l.canonical_type === t && (!confirmedOnly || l.status === 'CONFIRMED')).map((l) => l.label);
    return {
      entityId: e.id,
      caseId: e.case_id,
      type: e.canonical_type as any,
      value: e.canonical_type === 'PERSON' || e.canonical_type === 'ORGANIZATION' ? e.label : e.canonical_type === 'USERNAME' ? e.canonical_key : e.label,
      properties: e.properties ?? {},
      context: {
        organizations: of('ORGANIZATION'),
        cities: of('LOCATION'),
        verifiedPhones: of('PHONE', true),
        verifiedEmails: of('EMAIL', true),
      },
    };
  }

  async caseGraph(caseId: string, limit = 1500) {
    const ents = await this.db.query<EntityRow>(
      `SELECT * FROM intelligence.entities WHERE case_id = $1 AND resolution_status NOT IN ('MERGED')
       ORDER BY is_seed DESC, confidence DESC, created_at LIMIT $2`,
      [caseId, limit],
    );
    const ids = ents.map((e) => e.id);
    const rels = await this.db.query<RelRow>(
      `SELECT * FROM intelligence.relationships WHERE case_id = $1 AND from_id = ANY($2::uuid[]) AND to_id = ANY($2::uuid[])`,
      [caseId, ids],
    );
    return { ents, rels };
  }

  async subgraph(nodeIds: string[], edgeIds: string[]) {
    const ents = await this.db.query<EntityRow>('SELECT * FROM intelligence.entities WHERE id = ANY($1::uuid[])', [nodeIds]);
    const rels = edgeIds.length
      ? await this.db.query<RelRow>('SELECT * FROM intelligence.relationships WHERE id = ANY($1::uuid[])', [edgeIds])
      : [];
    return { ents, rels };
  }

  /** PostgreSQL fallback traversal (BFS) when Neo4j is unavailable. */
  async neighborhoodPg(id: string, depth: number) {
    const seen = new Set([id]);
    const edgeIds = new Set<string>();
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const rels = await this.db.query<RelRow>(
        `SELECT * FROM intelligence.relationships WHERE from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[]) LIMIT 1000`,
        [frontier],
      );
      const next: string[] = [];
      for (const r of rels) {
        edgeIds.add(r.id);
        for (const x of [r.from_id, r.to_id]) if (!seen.has(x)) (seen.add(x), next.push(x));
      }
      frontier = next;
    }
    return { nodeIds: [...seen], edgeIds: [...edgeIds] };
  }
}
