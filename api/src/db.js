import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

function getPoolConfig(connectionString) {
  let ssl = undefined;
  let connStr = connectionString;
  try {
    const parsed = new URL(connectionString);
    const hasSslQuery = parsed.searchParams.get('sslmode') === 'require' || parsed.searchParams.get('ssl') === 'true';
    const isRemote = parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'db';
    if (hasSslQuery || isRemote) {
      ssl = { rejectUnauthorized: false };
      parsed.searchParams.delete('sslmode');
      parsed.searchParams.delete('ssl');
      connStr = parsed.toString();
    }
  } catch {
    // If not a standard URL, use raw string
  }
  return {
    connectionString: connStr,
    ssl,
    max: 20,
    idleTimeoutMillis: 30_000,
  };
}

export const pool = new Pool(getPoolConfig(config.databaseUrl));


export const query = (text, params) => pool.query(text, params);

/** Run fn inside a transaction with a dedicated client. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDb(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] waiting for postgres (${i + 1}/${retries})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Database not reachable');
}
