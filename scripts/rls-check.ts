/**
 * Applies every migration, including the Supabase-only 1000+ ones, and asserts
 * that row-level security is actually on where it is supposed to be.
 *
 * Nothing else covers this. scripts/local-db.ts and the demo database both stop
 * at 0999 because PGlite has no `auth` schema, so the entire RLS layer — the
 * thing standing between one company's attendance and another's — has never had
 * a test run against it. This stubs the two pieces of Supabase that 1001 needs
 * (auth.users to point a foreign key at, auth.uid() for the predicates) and
 * runs the real files.
 *
 * It also re-applies the last file to prove re-running is safe, because that is
 * exactly what happens when someone reruns `npm run db:migrate` after a partial
 * failure.
 *
 *   npm run rls:check
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'supabase', 'migrations');

/**
 * Tables holding attendance, identity or consent. Every one of these must have
 * RLS on and at least one policy: a table with RLS on and no policy denies
 * everything, and a table with policies but RLS off enforces nothing.
 */
const MUST_BE_PROTECTED = [
  'company',
  'employee',
  'app_user',
  'attendance_event',
  'timesheet',
  'time_segment',
  'device',
  'geofence_consent_event',
  'employee_site_exclusion',
];

async function main(): Promise<void> {
  const pg = await PGlite.create();

  await pg.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$;
  `);

  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const name of files) {
    try {
      await pg.exec(await readFile(join(DIR, name), 'utf8'));
      console.log(`  ok    ${name}`);
    } catch (e) {
      console.error(`  FAIL  ${name}\n        ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Re-run only the files that claim to tolerate it, marked with `-- idempotent`
  // in their header. Most migrations are not re-runnable and do not need to be —
  // apply-migrations.ts records filenames and never runs one twice. The ones
  // that say they are safe get held to it, because a half-applied migration
  // followed by a re-run of `npm run db:migrate` is a real Tuesday.
  for (const name of files) {
    const sql = await readFile(join(DIR, name), 'utf8');
    if (!/^--\s*idempotent\b/m.test(sql)) continue;
    try {
      await pg.exec(sql);
      console.log(`  ok    ${name} re-applied cleanly`);
    } catch (e) {
      console.error(`  FAIL  ${name} claims to be idempotent but is not`);
      console.error(`        ${(e as Error).message}`);
      process.exit(1);
    }
  }

  const { rows } = await pg.query<{ relname: string; rls: boolean; policies: number }>(
    `select c.relname,
            c.relrowsecurity as rls,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );

  const byName = new Map(rows.map((r) => [r.relname, r]));
  const failures: string[] = [];

  console.log('\n  table                          rls    policies');
  for (const name of MUST_BE_PROTECTED) {
    const row = byName.get(name);
    if (!row) {
      failures.push(`${name}: table does not exist`);
      continue;
    }
    console.log(`  ${name.padEnd(30)} ${String(row.rls).padEnd(6)} ${row.policies}`);
    if (!row.rls) failures.push(`${name}: row-level security is OFF`);
    else if (row.policies === 0) failures.push(`${name}: RLS on but no policies — denies everything`);
  }

  if (failures.length) {
    console.error(`\nFAIL\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  console.log(`\nAll ${MUST_BE_PROTECTED.length} protected tables have RLS on, with policies.`);
}

void main();
