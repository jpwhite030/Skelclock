/**
 * Postgres connection for the web app.
 *
 * A module-level pool, kept on globalThis so Next's dev-mode hot reload does
 * not leak a new pool on every edit until the database refuses connections.
 */

import { Pool, type PoolClient } from 'pg';

import type { Db, PooledDb, QueryResult } from '@skelclock/server';

declare global {
  // eslint-disable-next-line no-var
  var __skelclockPool: Pool | undefined;
}

/**
 * With no DATABASE_URL, fall back to an in-process Postgres seeded with demo
 * data so `npm run dev` works on a clean clone. Never in production — there a
 * missing connection string is a misconfiguration that must fail loudly rather
 * than quietly serve fake numbers to the office.
 */
const useDemoDb = !process.env.DATABASE_URL && process.env.NODE_ENV !== 'production';

function pool(): Pool {
  if (!globalThis.__skelclockPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Copy .env.example to .env and point it at your Supabase database.',
      );
    }

    globalThis.__skelclockPool = new Pool({
      connectionString,
      // Supabase's pooler caps connections; a serverless deploy multiplies
      // instances, so keep each one small.
      max: Number(process.env.PGPOOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalThis.__skelclockPool;
}

class ClientDb implements PooledDb {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query(text, params as never[]);
    return { rows: result.rows as T[] };
  }

  release(): void {
    this.client.release();
  }
}

export const db: Db = {
  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (useDemoDb) {
      const { demoDb } = await import('./demo-db');
      return (await demoDb()).query<T>(text, params);
    }
    const result = await pool().query(text, params as never[]);
    return { rows: result.rows as T[] };
  },

  // Omitted entirely in demo mode: PGlite is a single connection, and
  // withTransaction issues BEGIN/COMMIT directly when connect() is absent.
  ...(useDemoDb
    ? {}
    : {
        async connect(): Promise<PooledDb> {
          return new ClientDb(await pool().connect());
        },
      }),
};
