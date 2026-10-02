import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, RequestId } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ENT_INDEX, OBS_INDEX, SearchIndexService } from '../../common/search-index.service';
import { maskValue } from '../../common/text';
import { AuthUser, PII_TYPES } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';

/** Full-text search over collected content and entities, filterable by case/source/time/entity type (paper §16). */
@Controller('search')
export class SearchController {
  constructor(
    private readonly index: SearchIndexService,
    private readonly db: DbService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async search(
    @CurrentUser() user: AuthUser,
    @RequestId() rid: string,
    @Query('q') q = '',
    @Query('caseId') caseId?: string,
    @Query('source') source?: string,
    @Query('entityType') entityType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('size') size = '25',
  ) {
    let caseIds: string[];
    if (caseId) {
      await this.policy.assertCaseAccess(user, caseId, 'READ');
      caseIds = [caseId];
    } else caseIds = await this.policy.accessibleCaseIds(user);
    await this.audit.record({ actor: user, action: 'search.query', objectType: 'search', caseId: caseId ?? null, requestId: rid, detail: { q, source, entityType, from, to } });
    if (!caseIds.length || !q.trim()) return { engine: 'none', total: 0, content: [], entities: [] };
    const n = Math.min(100, Number(size) || 25);
    if (this.index.available) {
      const range: Record<string, string> = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      const contentFilter: any[] = [{ terms: { case_id: caseIds } }];
      if (source) contentFilter.push({ term: { source_key: source } });
      if (from || to) contentFilter.push({ range: { published_at: range } });
      const content = await this.index.search(OBS_INDEX, {
        size: n,
        query: { bool: { must: [{ simple_query_string: { query: q, fields: ['title^2', 'content'], default_operator: 'and' } }], filter: contentFilter } },
        highlight: { fields: { content: { fragment_size: 180, number_of_fragments: 2 }, title: {} } },
        aggs: { sources: { terms: { field: 'source_key', size: 20 } } },
      });
      const entFilter: any[] = [{ terms: { case_id: caseIds } }];
      if (entityType) entFilter.push({ term: { type: entityType } });
      const ents = await this.index.search(ENT_INDEX, {
        size: n,
        query: { bool: { must: [{ multi_match: { query: q, fields: ['label^3', 'properties_text', 'canonical_key'], fuzziness: 'AUTO' } }], filter: entFilter } },
      });
      return {
        engine: 'opensearch',
        total: content.hits.total?.value ?? 0,
        facets: { sources: content.aggregations?.sources?.buckets ?? [] },
        content: content.hits.hits.map((h: any) => ({ id: h._id, score: h._score, ...h._source, content: undefined, highlight: h.highlight })),
        entities: ents.hits.hits.map((h: any) => ({
          id: h._id,
          score: h._score,
          caseId: h._source.case_id,
          type: h._source.type,
          label: PII_TYPES.has(h._source.type) ? maskValue(h._source.type, h._source.label) : h._source.label,
        })),
      };
    }
    // PostgreSQL fallback
    const like = `%${q}%`;
    const content = await this.db.query(
      `SELECT o.id, o.case_id, o.url, o.title, o.author, o.published_at, o.evidence_id, s.connector_key AS source_key
       FROM collection.observations o JOIN sources.sources s ON s.id = o.source_id
       WHERE o.case_id = ANY($1::uuid[]) AND (o.title ILIKE $2 OR o.content_text ILIKE $2)
         AND ($3::text IS NULL OR s.connector_key = $3)
       ORDER BY o.published_at DESC NULLS LAST LIMIT ${n}`,
      [caseIds, like, source ?? null],
    );
    const ents = await this.db.query(
      `SELECT id, case_id, canonical_type AS type, label FROM intelligence.entities
       WHERE case_id = ANY($1::uuid[]) AND label ILIKE $2 AND ($3::text IS NULL OR canonical_type = $3) LIMIT ${n}`,
      [caseIds, like, entityType ?? null],
    );
    return {
      engine: 'postgres',
      total: content.length,
      content,
      entities: ents.map((e) => ({ ...e, caseId: e.case_id, label: PII_TYPES.has(e.type) ? maskValue(e.type, e.label) : e.label })),
    };
  }
}
