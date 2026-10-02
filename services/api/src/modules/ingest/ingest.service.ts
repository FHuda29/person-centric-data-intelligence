import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../config';
import { DbService } from '../../common/db.service';
import { OBS_INDEX, SearchIndexService } from '../../common/search-index.service';
import { StorageService } from '../../common/storage.service';
import { sha256, truncate } from '../../common/text';
import { ConnectorOutput, ObservationDraft } from '../connectors/connector.types';
import { EntitiesService, EntityRow } from '../entities/entities.service';
import { ExtractionService } from '../extraction/extraction.service';
import { IdentityService } from '../identity/identity.service';

export interface IngestContext {
  caseId: string;
  sourceId: string;
  sourceKey: string;
  accessMethod: string;
  inputEntity: EntityRow | null;
  jobId?: string | null;
  userId?: string | null;
}

export interface IngestSummary {
  observations: number;
  newEvidence: number;
  entities: number;
  relationships: number;
  mentions: number;
  notes: string[];
}

const EXT: Record<string, string> = {
  'application/json': 'json',
  'application/rdap+json': 'json',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

/** Persists connector output: evidence objects → observations → entities/relationships → extraction → projections. */
@Injectable()
export class IngestService {
  private readonly log = new Logger('Ingest');
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly index: SearchIndexService,
    private readonly entities: EntitiesService,
    private readonly identity: IdentityService,
    private readonly extraction: ExtractionService,
  ) {}

  async ingest(ctx: IngestContext, out: ConnectorOutput): Promise<IngestSummary> {
    const summary: IngestSummary = { observations: 0, newEvidence: 0, entities: 0, relationships: 0, mentions: 0, notes: out.notes ?? [] };
    const touchedEntities = new Set<string>();
    const touchedRels = new Set<string>();
    const obsMap = new Map<string, { observationId: string; evidenceId: string; text: string; title: string | null; url: string | null; extract: boolean; entityRef?: string }>();

    // 1. Evidence + observations
    for (const o of out.observations) {
      const stored = await this.storeObservation(ctx, o);
      if (stored.newEvidence) summary.newEvidence++;
      summary.observations++;
      obsMap.set(o.ref, { ...stored, text: o.text ?? '', title: o.title ?? null, url: o.url ?? null, extract: !!o.extract, entityRef: o.entityRef });
    }
    const evOf = (ref?: string) => (ref ? (obsMap.get(ref)?.evidenceId ?? null) : null);

    // 2. Entities
    const entMap = new Map<string, EntityRow>();
    if (ctx.inputEntity) entMap.set('input', ctx.inputEntity);
    for (const d of out.entities) {
      try {
        const n = this.identity.normalize(d.type, d.value, { ...(d.hints ?? {}), title: (d.properties as any)?.title });
        n.properties = { ...n.properties, ...(d.properties ?? {}), source: ctx.sourceKey };
        const row = await this.entities.upsert(ctx.caseId, n, { confidence: d.confidence ?? 0.5 });
        entMap.set(d.ref, row);
        touchedEntities.add(row.id);
      } catch (e) {
        summary.notes.push(`skipped ${d.type} "${truncate(d.value, 60)}": ${e.message}`);
      }
    }
    summary.entities = touchedEntities.size;

    // 3. Relationships + attributes
    for (const r of out.relationships) {
      const a = entMap.get(r.from);
      const b = entMap.get(r.to);
      if (!a || !b) continue;
      const rel = await this.entities.relate(ctx.caseId, a.id, r.type, b.id, r.confidence, {
        label: r.label ?? null,
        evidenceId: evOf(r.obsRef),
        sourceId: ctx.sourceId,
      });
      if (rel) touchedRels.add(rel.id);
    }
    for (const at of out.attributes ?? []) {
      const e = entMap.get(at.entityRef);
      if (e) await this.entities.addAttribute(e.id, at.key, at.value, ctx.sourceId, evOf(at.obsRef));
    }

    // 4. Extraction over textual observations
    const needsExtraction = [...obsMap.values()].some((o) => o.extract && o.text);
    if (needsExtraction) {
      const known = await this.db.query<{ id: string; canonical_type: string; label: string }>(
        `SELECT id, canonical_type, label FROM intelligence.entities
         WHERE case_id = $1 AND canonical_type IN ('ORGANIZATION','LOCATION','EVENT','PERSON') AND resolution_status <> 'MERGED'
         ORDER BY is_seed DESC LIMIT 3000`,
        [ctx.caseId],
      );
      const knownList = known.map((k) => ({ id: k.id, type: k.canonical_type, label: k.label }));
      for (const [ref, o] of obsMap) {
        if (!o.extract || !o.text) continue;
        let content = o.entityRef ? entMap.get(o.entityRef) : undefined;
        if (!content && o.url) {
          try {
            content = await this.entities.upsert(ctx.caseId, this.identity.normalize('ARTICLE', o.url, { title: o.title }), { confidence: 0.9 });
            touchedEntities.add(content.id);
          } catch {
            /* not a URL */
          }
        }
        if (!content) continue;
        await this.entities.addAttribute(content.id, 'content_evidence', o.title ?? o.url ?? ref, ctx.sourceId, o.evidenceId);
        const res = this.extraction.extract(`${o.title ?? ''}\n${o.text}`, knownList);
        for (const m of res.mentions) {
          try {
            let target: EntityRow | null = null;
            if (m.type === 'PERSON') {
              // A name in text is only a *mention*; it is never attached to a specific identity automatically.
              target = await this.entities.upsert(ctx.caseId, this.identity.normalize('PERSON', m.value, { discriminator: 'mention' }), { confidence: 0.3 });
            } else if (m.entityId) {
              target = await this.entities.get(m.entityId);
            } else {
              const n = this.identity.normalize(m.type, m.value);
              if (m.type === 'URL' && (n.canonicalKey === content.canonical_key || n.canonicalKey === o.url)) continue;
              target = await this.entities.upsert(ctx.caseId, { ...n, properties: { ...n.properties, extracted_by: m.method } }, { confidence: m.confidence });
            }
            if (!target || target.id === content.id) continue;
            touchedEntities.add(target.id);
            const rel = await this.entities.relate(ctx.caseId, target.id, 'MENTIONED_IN', content.id, Math.min(0.6, m.confidence), {
              label: `extracted (${m.method})`,
              evidenceId: o.evidenceId,
              sourceId: ctx.sourceId,
            });
            if (rel) touchedRels.add(rel.id);
            summary.mentions++;
          } catch {
            /* invalid identifier from text — ignore */
          }
        }
        if (res.hashtags.length) await this.entities.addAttribute(content.id, 'hashtags', res.hashtags.slice(0, 15).join(' '), ctx.sourceId, o.evidenceId);
      }
    }
    summary.relationships = touchedRels.size;

    // 5. Projections (Neo4j + OpenSearch)
    await this.entities.project([...touchedEntities], [...touchedRels]);
    return summary;
  }

  /** Stores one raw payload as an evidence object (deduplicated by SHA-256) and records the observation. */
  async storeObservation(ctx: IngestContext, o: ObservationDraft): Promise<{ observationId: string; evidenceId: string; newEvidence: boolean }> {
    const body = Buffer.isBuffer(o.raw) ? o.raw : Buffer.from(o.raw ?? '', 'utf8');
    const hash = sha256(body);
    const ct = o.contentType || 'application/octet-stream';
    const published = o.publishedAt ? new Date(o.publishedAt) : null;
    const pub = published && !isNaN(published.getTime()) ? published : null;
    let newEvidence = false;
    let ev = await this.db.one<{ id: string }>('SELECT id FROM evidence.evidence WHERE case_id = $1 AND hash = $2', [ctx.caseId, hash]);
    if (!ev) {
      const objectRef = await this.storage.put(`cases/${ctx.caseId}/evidence/${hash}.${EXT[ct] ?? 'bin'}`, body, ct);
      ev = await this.db.one<{ id: string }>(
        `INSERT INTO evidence.evidence(case_id, source_id, url, title, published_at, access_method, hash, excerpt,
           object_ref, content_type, collector_version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          ctx.caseId, ctx.sourceId, o.url ?? null, o.title ?? null, pub, ctx.accessMethod, hash,
          truncate(o.text ?? (ct.includes('json') ? body.toString('utf8') : ''), 600),
          objectRef, ct, `${ctx.sourceKey}@${config.collectorVersion}`, ctx.userId ?? null,
        ],
      );
      newEvidence = true;
    }
    const obs = await this.db.one<{ id: string; observed_at: string }>(
      `INSERT INTO collection.observations(case_id, source_id, job_id, url, title, content_text, content_hash, author,
         published_at, raw_ref, evidence_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (case_id, content_hash) DO UPDATE SET observed_at = now()
       RETURNING id, observed_at`,
      [ctx.caseId, ctx.sourceId, ctx.jobId ?? null, o.url ?? null, o.title ?? null, o.text ?? null, hash, o.author ?? null, pub, `evidence:${ev!.id}`, ev!.id],
    );
    if (o.text || o.title) {
      await this.index.indexDoc(OBS_INDEX, obs!.id, {
        case_id: ctx.caseId,
        source_id: ctx.sourceId,
        source_key: ctx.sourceKey,
        evidence_id: ev!.id,
        url: o.url ?? null,
        title: o.title ?? null,
        content: o.text ?? null,
        author: o.author ?? null,
        published_at: pub ? pub.toISOString() : null,
        observed_at: obs!.observed_at,
      });
    }
    return { observationId: obs!.id, evidenceId: ev!.id, newEvidence };
  }
}
