import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import { config } from '../config';

export const OBS_INDEX = 'pcdi-observations';
export const ENT_INDEX = 'pcdi-entities';

/** Full-text content index (OpenSearch). PostgreSQL remains the system of record. */
@Injectable()
export class SearchIndexService {
  private readonly log = new Logger('OpenSearch');
  readonly client = new Client({ node: config.opensearchUrl });
  available = false;

  async init(): Promise<void> {
    for (let attempt = 1; attempt <= 40; attempt++) {
      try {
        await this.ensureIndex(OBS_INDEX, {
          case_id: { type: 'keyword' },
          source_id: { type: 'keyword' },
          source_key: { type: 'keyword' },
          evidence_id: { type: 'keyword' },
          url: { type: 'keyword' },
          title: { type: 'text' },
          content: { type: 'text' },
          author: { type: 'keyword' },
          published_at: { type: 'date' },
          observed_at: { type: 'date' },
        });
        await this.ensureIndex(ENT_INDEX, {
          case_id: { type: 'keyword' },
          type: { type: 'keyword' },
          label: { type: 'text', fields: { raw: { type: 'keyword' } } },
          canonical_key: { type: 'keyword' },
          properties_text: { type: 'text' },
          first_seen: { type: 'date' },
        });
        this.available = true;
        return;
      } catch (e) {
        this.log.warn(`OpenSearch not ready (${attempt}/40): ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    this.log.error('OpenSearch unavailable — full-text search falls back to PostgreSQL');
  }

  private async ensureIndex(index: string, properties: Record<string, unknown>) {
    const exists = await this.client.indices.exists({ index });
    if (!(exists as any).body) {
      await this.client.indices.create({
        index,
        body: { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties } } as any,
      });
    }
  }

  async indexDoc(index: string, id: string, doc: Record<string, unknown>): Promise<void> {
    if (!this.available) return;
    try {
      await this.client.index({ index, id, body: doc as any });
    } catch (e) {
      this.log.warn(`index ${index}/${id} failed: ${e.message}`);
    }
  }

  async deleteDoc(index: string, id: string): Promise<void> {
    if (!this.available) return;
    await this.client.delete({ index, id }).catch(() => undefined);
  }

  async search(index: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.client.search({ index, body: body as any });
    return (res as any).body;
  }

  async deleteByCase(caseId: string): Promise<void> {
    if (!this.available) return;
    for (const index of [OBS_INDEX, ENT_INDEX]) {
      await this.client
        .deleteByQuery({ index, body: { query: { term: { case_id: caseId } } } as any })
        .catch((e) => this.log.warn(`purge ${index} failed: ${e.message}`));
    }
  }
}
