/**
 * Local Postgres for development and tests.
 *
 * PGlite is real Postgres 17 compiled to WASM, so the migrations, triggers,
 * enums and `for update skip locked` all behave exactly as they will on
 * Supabase — without Docker, which this machine does not have.
 *
 * Migrations numbered 1000+ are Supabase-only (they reference auth.users and
 * auth.uid()) and are skipped here.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import type { Db, QueryResult } from '@skelclock/server';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

/** Adapts PGlite to the `Db` interface the service layer expects. */
class PGliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pg.query<T>(text, params as never[]);
    return { rows: result.rows };
  }
}

export interface LocalDb {
  db: Db;
  close: () => Promise<void>;
  raw: PGlite;
}

export async function createLocalDb(): Promise<LocalDb> {
  const pg = await PGlite.create();
  const db = new PGliteDb(pg);

  for (const { name, sql } of await portableMigrations()) {
    try {
      await pg.exec(sql);
    } catch (error) {
      throw new Error(
        `Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { db, close: () => pg.close(), raw: pg };
}

export async function portableMigrations(): Promise<Array<{ name: string; sql: string }>> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const out: Array<{ name: string; sql: string }> = [];
  for (const name of files) {
    // 1001_supabase_rls.sql and friends need the auth schema.
    if (Number.parseInt(name.slice(0, 4), 10) >= 1000) continue;
    out.push({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') });
  }
  return out;
}

// --- fixtures ---------------------------------------------------------------

export interface Fixture {
  companyId: string;
  employeeId: string;
  supervisorEmployeeId: string;
  workerUserId: string;
  supervisorUserId: string;
  adminUserId: string;
  crewId: string;
  jobId: string;
  siteId: string;
  activities: Record<string, string>;
}

/**
 * A company with one crew, one job and one site — enough to exercise every
 * path. Deliberately mirrors the mock Odoo fixtures so the PoC's imported data
 * and this seed describe the same world.
 */
export async function seedFixture(db: Db): Promise<Fixture> {
  const q = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
    const { rows } = await db.query<T>(sql, params);
    return rows[0]!;
  };

  const company = await q<{ id: string }>(
    `insert into company (name, timezone, odoo_id) values ('SkelScaff', 'Australia/Sydney', 1)
     returning id`,
  );

  await db.query('select seed_default_activities($1)', [company.id]);

  const { rows: activityRows } = await db.query<{ id: string; code: string }>(
    'select id, code from work_activity where company_id = $1',
    [company.id],
  );
  const activities = Object.fromEntries(activityRows.map((r) => [r.code, r.id]));

  const supervisor = await q<{ id: string }>(
    `insert into employee (company_id, odoo_id, employee_number, full_name, email, mobile)
     values ($1, 1007, 'SS-101', 'Marcus Ellery', 'marcus@example.com', '+61412555101')
     returning id`,
    [company.id],
  );

  const employee = await q<{ id: string }>(
    `insert into employee (company_id, odoo_id, employee_number, full_name, email, mobile,
                           supervisor_employee_id)
     values ($1, 1042, 'SS-114', 'Dean Whitmore', 'dean.whitmore@example.com',
             '+61412555208', $2)
     returning id`,
    [company.id, supervisor.id],
  );

  const workerUser = await q<{ id: string }>(
    `insert into app_user (company_id, employee_id, email, phone, role)
     values ($1, $2, 'dean.whitmore@example.com', '+61412555208', 'worker') returning id`,
    [company.id, employee.id],
  );
  const supervisorUser = await q<{ id: string }>(
    `insert into app_user (company_id, employee_id, email, phone, role)
     values ($1, $2, 'marcus@example.com', '+61412555101', 'supervisor') returning id`,
    [company.id, supervisor.id],
  );
  const adminUser = await q<{ id: string }>(
    `insert into app_user (company_id, email, role)
     values ($1, 'office@skelscaff.com.au', 'admin') returning id`,
    [company.id],
  );

  const crew = await q<{ id: string }>(
    `insert into crew (company_id, name, supervisor_employee_id)
     values ($1, 'Crew A', $2) returning id`,
    [company.id, supervisor.id],
  );
  await db.query(
    'insert into crew_member (crew_id, employee_id) values ($1,$2), ($1,$3)',
    [crew.id, employee.id, supervisor.id],
  );

  const site = await q<{ id: string }>(
    `insert into site (company_id, name, address, latitude, longitude, geofence_radius_m)
     values ($1, '14 Kembla Street', '14 Kembla Street, Wollongong NSW 2500',
             -34.4248, 150.8931, 200)
     returning id`,
    [company.id],
  );

  const job = await q<{ id: string }>(
    `insert into job (company_id, odoo_model, odoo_id, job_number, customer_name, site_id, status)
     values ($1, 'project.project', 3311, '1032', 'Ridgeline Construction Pty Ltd', $2, 'active')
     returning id`,
    [company.id, site.id],
  );

  return {
    companyId: company.id,
    employeeId: employee.id,
    supervisorEmployeeId: supervisor.id,
    workerUserId: workerUser.id,
    supervisorUserId: supervisorUser.id,
    adminUserId: adminUser.id,
    crewId: crew.id,
    jobId: job.id,
    siteId: site.id,
    activities,
  };
}
