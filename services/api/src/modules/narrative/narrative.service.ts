import { Body, Controller, Get, Injectable, Post, Query } from '@nestjs/common';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { jaccard, sha256, stripDiacritics, truncate } from '../../common/text';
import { AuthUser } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { EntitiesService } from '../entities/entities.service';
import { IdentityService } from '../identity/identity.service';
import { PolicyService } from '../policy/policy.service';

const STOP = new Set(
  (
    'the a an and or of to in on for with by from at as is are was were be been this that these those it its not no ' +
    'but if then than so such can could will would should may might has have had do does did about into over after before ' +
    'yang dan di ke dari untuk dengan pada dalam ini itu adalah akan tidak sudah juga atau oleh karena sebagai bagi kami ' +
    'kita mereka ia dia saya anda para serta hingga sampai agar bahwa lebih masih harus dapat telah ada tanpa atas besok ' +
    'https http www com html amp rt via'
  ).split(/\s+/),
);

interface Doc {
  id: string;
  text: string;
  title: string | null;
  url: string | null;
  author: string | null;
  source: string;
  time: Date;
  evidence_id: string | null;
}

const tokens = (s: string) =>
  stripDiacritics(s.toLowerCase())
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}#]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));

const shingles = (tk: string[], k = 3) => {
  const s = new Set<string>();
  for (let i = 0; i + k <= tk.length; i++) s.add(tk.slice(i, i + k).join(' '));
  return s;
};

const actorOf = (d: Doc) => {
  if (d.author) return d.author;
  try {
    return d.url ? new URL(d.url).hostname.replace(/^www\./, '') : d.source;
  } catch {
    return d.source;
  }
};

/**
 * Narrative & network intelligence (paper §8). Similarity, bursts and centrality describe structure in the
 * collected dataset; they are not evidence of coordination, command-and-control or intent.
 */
@Injectable()
export class NarrativeService {
  static readonly DISCLAIMER =
    'Clusters show textual similarity and timing in collected data only. They do not establish coordination, ' +
    'common command-and-control, financing or motive — those remain analyst hypotheses requiring evidence.';

  constructor(
    private readonly db: DbService,
    private readonly entities: EntitiesService,
    private readonly identity: IdentityService,
  ) {}

  private urlKeys(url: string | null): string[] {
    if (!url) return [];
    try {
      return [url, this.identity.normalize('URL', url).canonicalKey];
    } catch {
      return [url];
    }
  }

  private async docs(caseId: string): Promise<Doc[]> {
    const rows = await this.db.query(
      `SELECT o.id, COALESCE(o.content_text, '') AS text, o.title, o.url, o.author, s.connector_key AS source,
              COALESCE(o.published_at, o.observed_at) AS time, o.evidence_id
       FROM collection.observations o JOIN sources.sources s ON s.id = o.source_id
       WHERE o.case_id = $1 AND length(COALESCE(o.content_text, '')) >= 20
       ORDER BY time LIMIT 5000`,
      [caseId],
    );
    return rows.map((r) => ({ ...r, time: new Date(r.time) }));
  }

  async analyze(caseId: string) {
    const docs = await this.docs(caseId);
    // --- claim clusters: near-duplicate sentences across different observations
    type Sent = { doc: Doc; text: string; sh: Set<string> };
    const sents: Sent[] = [];
    for (const d of docs) {
      for (const raw of `${d.text}`.split(/(?<=[.!?])\s+|\n+/)) {
        const tk = tokens(raw).filter((t) => !t.startsWith('#'));
        if (tk.length < 5) continue;
        sents.push({ doc: d, text: raw.trim(), sh: shingles(tk) });
      }
    }
    const claimClusters: { rep: Sent; members: Sent[] }[] = [];
    for (const s of sents.slice(0, 6000)) {
      let best: { c: (typeof claimClusters)[number]; j: number } | null = null;
      for (const c of claimClusters) {
        const j = jaccard(s.sh, c.rep.sh);
        if (j >= 0.45 && (!best || j > best.j)) best = { c, j };
      }
      if (best) best.c.members.push(s);
      else claimClusters.push({ rep: s, members: [s] });
    }
    const claims = claimClusters
      .map((c) => {
        const obs = new Map<string, Sent>();
        for (const m of c.members) if (!obs.has(m.doc.id)) obs.set(m.doc.id, m);
        const ordered = [...obs.values()].sort((a, b) => a.doc.time.getTime() - b.doc.time.getTime());
        const actors = new Set(ordered.map((m) => actorOf(m.doc)));
        return { c, ordered, actors };
      })
      .filter((x) => x.ordered.length >= 2 && x.actors.size >= 2)
      .sort((a, b) => b.ordered.length - a.ordered.length)
      .slice(0, 25);

    // --- topic clusters: TF-IDF top terms per document, grouped by overlap
    const df = new Map<string, number>();
    const docTokens = docs.map((d) => {
      const tk = tokens(`${d.title ?? ''} ${d.text}`);
      for (const t of new Set(tk)) df.set(t, (df.get(t) ?? 0) + 1);
      return tk;
    });
    const N = Math.max(1, docs.length);
    const topTerms = docTokens.map((tk) => {
      const tf = new Map<string, number>();
      for (const t of tk) tf.set(t, (tf.get(t) ?? 0) + 1);
      return new Map(
        [...tf]
          .map(([t, f]) => [t, (f / tk.length) * Math.log(1 + N / (df.get(t) ?? 1))] as [string, number])
          .filter(([t]) => (df.get(t) ?? 0) >= 2 || t.startsWith('#'))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8),
      );
    });
    const topicClusters: { terms: Map<string, number>; docs: number[] }[] = [];
    topTerms.forEach((terms, i) => {
      if (!terms.size) return;
      const keys = new Set(terms.keys());
      let best: { c: (typeof topicClusters)[number]; j: number } | null = null;
      for (const c of topicClusters) {
        const j = jaccard(keys, new Set([...c.terms.keys()].slice(0, 12)));
        if (j >= 0.2 && (!best || j > best.j)) best = { c, j };
      }
      if (best) {
        best.c.docs.push(i);
        for (const [t, w] of terms) best.c.terms.set(t, (best.c.terms.get(t) ?? 0) + w);
        best.c.terms = new Map([...best.c.terms].sort((a, b) => b[1] - a[1]));
      } else topicClusters.push({ terms: new Map(terms), docs: [i] });
    });
    const topics = topicClusters
      .filter((c) => c.docs.length >= 2)
      .sort((a, b) => b.docs.length - a.docs.length)
      .slice(0, 15);

    // --- temporal bursts (daily volume > mean + 2σ and ≥ 3)
    const perDay = new Map<string, number>();
    for (const d of docs) {
      const k = d.time.toISOString().slice(0, 10);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const counts = [...perDay.values()];
    const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
    const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, counts.length));
    const series = [...perDay].sort().map(([day, count]) => ({ day, count, burst: count >= 3 && count > mean + 2 * sd }));
    // With few days σ is small; also flag the single peak day if it is ≥ 2× the mean.
    if (!series.some((s) => s.burst) && series.length >= 3) {
      const peak = series.reduce((a, b) => (b.count > a.count ? b : a));
      if (peak.count >= 3 && peak.count >= 2 * mean) peak.burst = true;
    }

    // Persist narratives, replacing previous analysis for the case
    await this.db.query('DELETE FROM intelligence.narratives WHERE case_id = $1', [caseId]);
    const touchedE: string[] = [];
    const touchedR: string[] = [];
    for (const cl of claims) {
      const propagation = cl.ordered.map((m) => ({
        observationId: m.doc.id,
        evidenceId: m.doc.evidence_id,
        time: m.doc.time.toISOString(),
        actor: actorOf(m.doc),
        url: m.doc.url,
        text: truncate(m.text, 240),
      }));
      const rep = truncate(cl.c.rep.text, 200);
      const n = this.identity.normalize('NARRATIVE', `Claim: ${truncate(cl.c.rep.text, 90)}`, { discriminator: sha256(rep).slice(0, 12) });
      n.properties = { ...n.properties, kind: 'CLAIM', representative: rep, observations: cl.ordered.length, actors: cl.actors.size };
      const ent = await this.entities.upsert(caseId, n, { confidence: 0.6 });
      touchedE.push(ent.id);
      // Link narrative → the content entities (articles/posts) that carry it.
      const content = await this.db.query<{ id: string }>(
        `SELECT DISTINCT e.id FROM intelligence.entities e WHERE e.case_id = $1 AND e.canonical_type IN ('ARTICLE','URL','DOCUMENT')
         AND e.canonical_key = ANY($2)`,
        [caseId, cl.ordered.flatMap((m) => this.urlKeys(m.doc.url))],
      );
      for (const c of content) {
        const r = await this.entities.relate(caseId, ent.id, 'MENTIONED_IN', c.id, 0.7, { label: 'claim appears in' });
        if (r) touchedR.push(r.id);
      }
      await this.db.query(
        `INSERT INTO intelligence.narratives(case_id, kind, topic, keywords, representative, observation_ids, source_count,
           first_seen, last_seen, propagation, entity_id)
         VALUES ($1,'CLAIM',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          caseId, truncate(cl.c.rep.text, 120), [...new Set([...cl.c.rep.sh].flatMap((s) => s.split(' ')))].slice(0, 10), rep,
          cl.ordered.map((m) => m.doc.id), cl.actors.size, cl.ordered[0].doc.time, cl.ordered[cl.ordered.length - 1].doc.time,
          JSON.stringify(propagation), ent.id,
        ],
      );
    }
    for (const t of topics) {
      const members = t.docs.map((i) => docs[i]).sort((a, b) => a.time.getTime() - b.time.getTime());
      const kw = [...t.terms.keys()].slice(0, 10);
      await this.db.query(
        `INSERT INTO intelligence.narratives(case_id, kind, topic, keywords, representative, observation_ids, source_count,
           first_seen, last_seen, propagation)
         VALUES ($1,'TOPIC',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          caseId, kw.slice(0, 3).join(' · '), kw, truncate(members[0].title ?? members[0].text, 200), members.map((m) => m.id),
          new Set(members.map(actorOf)).size, members[0].time, members[members.length - 1].time,
          JSON.stringify(members.slice(0, 50).map((m) => ({ observationId: m.id, evidenceId: m.evidence_id, time: m.time.toISOString(), actor: actorOf(m), url: m.url, text: truncate(m.title ?? m.text, 200) }))),
        ],
      );
    }
    await this.entities.project(touchedE, touchedR);
    return { documents: docs.length, claims: claims.length, topics: topics.length, bursts: series.filter((s) => s.burst).map((s) => s.day) };
  }

  async overview(caseId: string) {
    const narratives = await this.db.query(
      `SELECT * FROM intelligence.narratives WHERE case_id = $1 ORDER BY kind, source_count DESC, array_length(observation_ids,1) DESC`,
      [caseId],
    );
    const volume = await this.db.query(
      `SELECT to_char(date_trunc('day', COALESCE(published_at, observed_at)), 'YYYY-MM-DD') AS day, count(*)::int AS count
       FROM collection.observations WHERE case_id = $1 AND length(COALESCE(content_text, '')) >= 20
       GROUP BY 1 ORDER BY 1`,
      [caseId],
    );
    const counts = volume.map((v) => v.count);
    const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
    const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, counts.length));
    const peak = Math.max(0, ...counts);
    const series = volume.map((v) => ({
      ...v,
      burst: v.count >= 3 && (v.count > mean + 2 * sd || (counts.length >= 3 && v.count === peak && v.count >= 2 * mean)),
    }));
    // Co-mention network: entities mentioned in the same content item.
    const coMention = await this.db.query(
      `SELECT a.label AS a, a.canonical_type AS a_type, b.label AS b, b.canonical_type AS b_type, count(*)::int AS weight
       FROM intelligence.relationships r1
       JOIN intelligence.relationships r2 ON r2.to_id = r1.to_id AND r2.type = 'MENTIONED_IN' AND r1.from_id < r2.from_id
       JOIN intelligence.entities a ON a.id = r1.from_id AND a.canonical_type IN ('PERSON','ORGANIZATION','LOCATION','SOCIAL_ACCOUNT')
       JOIN intelligence.entities b ON b.id = r2.from_id AND b.canonical_type IN ('PERSON','ORGANIZATION','LOCATION','SOCIAL_ACCOUNT')
       WHERE r1.case_id = $1 AND r1.type = 'MENTIONED_IN'
       GROUP BY 1,2,3,4 HAVING count(*) >= 2 ORDER BY weight DESC LIMIT 40`,
      [caseId],
    );
    // URL-sharing network: accounts sharing the same URL.
    const urlSharing = await this.db.query(
      `SELECT u.label AS url, array_agg(DISTINCT a.label) AS accounts, count(DISTINCT a.id)::int AS n
       FROM intelligence.relationships r
       JOIN intelligence.entities a ON a.id = r.from_id
       JOIN intelligence.entities u ON u.id = r.to_id
       WHERE r.case_id = $1 AND r.type = 'SHARED'
       GROUP BY u.label HAVING count(DISTINCT a.id) >= 2 ORDER BY n DESC LIMIT 20`,
      [caseId],
    );
    // Publishing actors ranked by volume.
    const actors = await this.db.query(
      `SELECT a.label AS actor, a.canonical_type AS type, count(*)::int AS published
       FROM intelligence.relationships r JOIN intelligence.entities a ON a.id = r.from_id
       WHERE r.case_id = $1 AND r.type = 'PUBLISHED' GROUP BY 1,2 ORDER BY published DESC LIMIT 25`,
      [caseId],
    );
    return {
      disclaimer: NarrativeService.DISCLAIMER,
      claims: narratives.filter((n) => n.kind === 'CLAIM'),
      topics: narratives.filter((n) => n.kind === 'TOPIC'),
      volume: series,
      coMention,
      urlSharing,
      actors,
    };
  }
}

@Controller('narratives')
export class NarrativeController {
  constructor(
    private readonly narrative: NarrativeService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    return this.narrative.overview(caseId);
  }

  @Post('analyze')
  @Roles('ADMIN', 'ANALYST')
  async analyze(@CurrentUser() user: AuthUser, @Body() b: { caseId: string }, @RequestId() rid: string) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    const r = await this.narrative.analyze(b.caseId);
    await this.audit.record({ actor: user, action: 'narrative.analyze', objectType: 'case', objectId: b.caseId, caseId: b.caseId, requestId: rid, detail: r });
    return r;
  }
}
