import dotenv from 'dotenv';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let envLoaded = false;

type PgGlobal = typeof globalThis & {
  __vocPgPool?: Pool;
};

function loadEnv(): void {
  if (envLoaded) return;

  dotenv.config({ path: '.env.local' });
  dotenv.config();
  envLoaded = true;
}

function getDatabaseUrl(): string | undefined {
  loadEnv();
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
}

function isPostgresConfigured(): boolean {
  return Boolean(getDatabaseUrl());
}

function getPgPool(): Pool {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const globalForPg = globalThis as PgGlobal;
  if (!globalForPg.__vocPgPool) {
    globalForPg.__vocPgPool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  return globalForPg.__vocPgPool;
}

async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  return getPgPool().query<T>(sql, params);
}

async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPgPool().connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { getDatabaseUrl, isPostgresConfigured, getPgPool, query, transaction };
