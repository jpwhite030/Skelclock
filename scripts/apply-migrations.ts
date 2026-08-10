/**
 * Applies supabase/migrations/*.sql, in order, against whatever DATABASE_URL
 * points at.
 *
 * Unlike scripts/local-db.ts (which re-runs every portable migration into a
 * fresh in-process Postgres on every boot), this is for a real, persistent
 * database: a `_migrations` table records what has already run, so this is
 * safe to run again after a new migration file is added — only the new ones
 * apply. Runs 1000+ migrations too (RLS, auth linkage) — local dev skips
 * those because PGlite has no `auth` schema; a real Supabase project does.
 *
 *   DATABASE_URL=... node --import tsx scripts/apply-migrations.ts
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Connected. Applying migrations from ${MIGRATIONS_DIR}\n`);

  await client.query(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows: already } = await client.query<{ name: string }>('select name from _migrations');
  const appliedNames = new Set(already.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const name of files) {
    if (appliedNames.has(name)) {
      console.log(`  = ${name} (already applied)`);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`  + applied ${name}`);
      ran += 1;
    } catch (error) {
      await client.query('rollback');
      await client.end();
      throw new Error(
        `Migration ${name} failed, rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await client.end();
  console.log(ran > 0 ? `\n${ran} migration(s) applied.` : '\nNothing to do — already up to date.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
