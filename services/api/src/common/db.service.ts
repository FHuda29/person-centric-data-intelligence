import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

type Queryable = Pool | PoolClient;

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: 15 });

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T[]> {
    const res = await (client ?? this.pool).query<T>(sql, params as any[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T | null> {
    const rows = await this.query<T>(sql, params, client);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Waits for PostgreSQL and applies pending SQL migrations in lexical order. */
  async migrate(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        break;
      } catch (e) {
        if (attempt >= 30) throw e;
        this.log.warn(`PostgreSQL not ready (${attempt}/30): ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    // Session-level advisory lock must be taken and released on the same connection.
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(424242)');
      await c.query(
        'CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const applied = new Set(
        (await this.query<{ name: string }>('SELECT name FROM public.schema_migrations', [], c)).map((r) => r.name),
      );
      const files = readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        this.log.log(`Applying migration ${file}`);
        try {
          await c.query('BEGIN');
          await c.query(readFileSync(join(config.migrationsDir, file), 'utf8'));
          await c.query('INSERT INTO public.schema_migrations(name) VALUES ($1)', [file]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
      c.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
