import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import neo4j, { Driver } from 'neo4j-driver';
import { config } from '../config';

export interface GraphNode {
  id: string;
  caseId: string;
  type: string;
  label: string;
  confidence: number;
  status: string;
}
export interface GraphEdge {
  id: string;
  caseId: string;
  from: string;
  to: string;
  type: string;
  confidence: number;
  status: string;
  label?: string | null;
}

const LABEL_RE = /^[A-Z_]+$/;
const toPascal = (t: string) => t.toLowerCase().replace(/(^|_)(\w)/g, (_m, _p, c: string) => c.toUpperCase());

/** Graph projection (Neo4j) for relationship traversal. PostgreSQL stays the source of truth. */
@Injectable()
export class GraphStoreService implements OnModuleDestroy {
  private readonly log = new Logger('Neo4j');
  private readonly driver: Driver = neo4j.driver(
    config.neo4jUrl,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
  );
  available = false;

  async init(): Promise<void> {
    for (let attempt = 1; attempt <= 40; attempt++) {
      try {
        await this.run('CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE');
        await this.run('CREATE INDEX entity_case IF NOT EXISTS FOR (n:Entity) ON (n.caseId)');
        this.available = true;
        return;
      } catch (e) {
        this.log.warn(`Neo4j not ready (${attempt}/40): ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    this.log.error('Neo4j unavailable — graph traversal falls back to PostgreSQL');
  }

  async run(cypher: string, params: Record<string, unknown> = {}) {
    const session = this.driver.session();
    try {
      const res = await session.run(cypher, params);
      return res.records;
    } finally {
      await session.close();
    }
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (!this.available || !nodes.length) return;
    // Group by type so the type label is static in Cypher (types are whitelisted by regex).
    const byType = new Map<string, GraphNode[]>();
    for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
    for (const [type, group] of byType) {
      if (!LABEL_RE.test(type)) continue;
      await this.run(
        `UNWIND $rows AS row
         MERGE (n:Entity {id: row.id})
         SET n:${toPascal(type)}, n.caseId = row.caseId, n.type = row.type, n.label = row.label,
             n.confidence = row.confidence, n.status = row.status`,
        { rows: group },
      ).catch((e) => this.log.warn(`upsertNodes failed: ${e.message}`));
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (!this.available || !edges.length) return;
    const byType = new Map<string, GraphEdge[]>();
    for (const e of edges) byType.set(e.type, [...(byType.get(e.type) ?? []), e]);
    for (const [type, group] of byType) {
      if (!LABEL_RE.test(type)) continue;
      await this.run(
        `UNWIND $rows AS row
         MATCH (a:Entity {id: row.from}), (b:Entity {id: row.to})
         MERGE (a)-[r:${type} {id: row.id}]->(b)
         SET r.caseId = row.caseId, r.confidence = row.confidence, r.status = row.status, r.label = row.label`,
        { rows: group },
      ).catch((e) => this.log.warn(`upsertEdges failed: ${e.message}`));
    }
  }

  async deleteNode(id: string): Promise<void> {
    if (!this.available) return;
    await this.run('MATCH (n:Entity {id: $id}) DETACH DELETE n', { id }).catch(() => undefined);
  }

  async deleteEdge(id: string): Promise<void> {
    if (!this.available) return;
    await this.run('MATCH ()-[r {id: $id}]-() DELETE r', { id }).catch(() => undefined);
  }

  async deleteCase(caseId: string): Promise<void> {
    if (!this.available) return;
    await this.run('MATCH (n:Entity {caseId: $caseId}) DETACH DELETE n', { caseId }).catch(() => undefined);
  }

  /** Variable-depth neighbourhood of an entity; returns ids of nodes and relationships. */
  async neighborhood(id: string, depth: number, limit: number): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
    const d = Math.max(1, Math.min(3, Math.floor(depth)));
    const records = await this.run(
      `MATCH p = (n:Entity {id: $id})-[*1..${d}]-(m:Entity)
       WITH p LIMIT $limit
       UNWIND nodes(p) AS nd
       UNWIND relationships(p) AS rl
       RETURN collect(DISTINCT nd.id) AS nodeIds, collect(DISTINCT rl.id) AS edgeIds`,
      { id, limit: neo4j.int(limit) },
    );
    const r = records[0];
    const nodeIds: string[] = r?.get('nodeIds') ?? [];
    return { nodeIds: nodeIds.length ? nodeIds : [id], edgeIds: r?.get('edgeIds') ?? [] };
  }

  async shortestPath(from: string, to: string): Promise<{ nodeIds: string[]; edgeIds: string[] } | null> {
    const records = await this.run(
      `MATCH (a:Entity {id: $from}), (b:Entity {id: $to}), p = shortestPath((a)-[*..8]-(b))
       RETURN [n IN nodes(p) | n.id] AS nodeIds, [r IN relationships(p) | r.id] AS edgeIds`,
      { from, to },
    );
    if (!records.length) return null;
    return { nodeIds: records[0].get('nodeIds'), edgeIds: records[0].get('edgeIds') };
  }

  async onModuleDestroy() {
    await this.driver.close();
  }
}
