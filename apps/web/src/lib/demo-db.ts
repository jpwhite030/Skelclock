/**
 * Development database.
 *
 * With no DATABASE_URL set, the dashboard boots an in-process Postgres (PGlite,
 * real Postgres 17 in WASM), applies the migrations and seeds a day's worth of
 * SkelScaff activity — so `npm run dev` shows a working dashboard on a clean
 * clone with no Supabase project and no Docker.
 *
 * The seed deliberately drives the *real* service layer — ingestEvents,
 * rebuildTimesheet, approveTimesheet, runSyncWorker — rather than inserting
 * rows by hand. Anything you see on screen was produced by the same code path
 * a real phone would take, so the screens cannot flatter themselves with data
 * the system could not actually generate.
 *
 * Never used in production: db.ts only reaches for this when DATABASE_URL is
 * absent, and refuses to when NODE_ENV is production.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { newIdempotencyKey, type ClockEventInput } from '@skelclock/core';
import { MockOdooAdapter } from '@skelclock/odoo';
import {
  approveTimesheet,
  confirmTimesheet,
  correctEvent,
  enqueueTimesheetPush,
  ingestEvents,
  runSyncWorker,
  type Db,
  type QueryResult,
} from '@skelclock/server';

class PGliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pg.query<T>(text, params as never[]);
    return { rows: result.rows };
  }
  // No connect(): PGlite is a single connection, so withTransaction issues
  // BEGIN/COMMIT directly, which is correct here.
}

declare global {
  // eslint-disable-next-line no-var
  var __skelclockDemoDb: Promise<Db> | undefined;
}

/** One instance per process, survives Next's dev hot reload. */
export function demoDb(): Promise<Db> {
  globalThis.__skelclockDemoDb ??= boot();
  return globalThis.__skelclockDemoDb;
}

async function boot(): Promise<Db> {
  const pg = await PGlite.create();
  const db = new PGliteDb(pg);

  // process.cwd() is apps/web when Next runs.
  const migrationsDir = join(process.cwd(), '..', '..', 'supabase', 'migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const name of files) {
    // 1000+ are Supabase-only: they reference auth.users and auth.uid().
    if (Number.parseInt(name.slice(0, 4), 10) >= 1000) continue;
    await pg.exec(await readFile(join(migrationsDir, name), 'utf8'));
  }

  await seed(db);
  return db;
}

// --- the seed ---------------------------------------------------------------

const CREW_A = [
  { odooId: 1042, number: 'SS-114', name: 'Dean Whitmore', mobile: '+61412555208' },
  { odooId: 1043, number: 'SS-118', name: 'Tobias Renner', mobile: '+61412555209' },
  { odooId: 1044, number: 'SS-121', name: 'Ana Petrovic', mobile: '+61412555210' },
];

const CREW_B = [
  { odooId: 1045, number: 'SS-126', name: 'Mikhail Dvorak', mobile: '+61412555211' },
  { odooId: 1046, number: 'SS-130', name: 'Priya Raghavan', mobile: '+61412555212' },
];

const SITES = [
  {
    jobNumber: '1032',
    customer: 'Ridgeline Construction Pty Ltd',
    site: '14 Kembla Street',
    address: '14 Kembla Street, Wollongong NSW 2500',
    lat: -34.4248,
    lng: 150.8931,
  },
  {
    jobNumber: '1041',
    customer: 'Harbourside Developments',
    site: 'Warrawong yard extension',
    address: '3 Shellharbour Road, Warrawong NSW 2502',
    lat: -34.488,
    lng: 150.893,
  },
  {
    jobNumber: '1047',
    customer: 'BlueScope Maintenance',
    site: 'Port Kembla stack 4',
    address: 'Old Port Road, Port Kembla NSW 2505',
    lat: -34.4796,
    lng: 150.9047,
  },
];

async function seed(db: Db): Promise<void> {
  const q = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
    const { rows } = await db.query<T>(sql, params);
    return rows[0]!;
  };

  const company = await q<{ id: string }>(
    `insert into company (name, timezone, odoo_id)
     values ('SkelScaff', 'Australia/Sydney', 1) returning id`,
  );
  const companyId = company.id;
  await db.query('select seed_default_activities($1)', [companyId]);

  const { rows: activityRows } = await db.query<{ id: string; code: string }>(
    'select id, code from work_activity where company_id = $1',
    [companyId],
  );
  const activity = Object.fromEntries(activityRows.map((r) => [r.code, r.id])) as Record<
    string,
    string
  >;

  // --- people --------------------------------------------------------------

  const supervisor = await q<{ id: string }>(
    `insert into employee (company_id, odoo_id, employee_number, full_name, email, mobile)
     values ($1, 1007, 'SS-101', 'Marcus Ellery', 'marcus@skelscaff.com.au', '+61412555101')
     returning id`,
    [companyId],
  );

  const employees: Record<string, string> = {};
  for (const person of [...CREW_A, ...CREW_B]) {
    const row = await q<{ id: string }>(
      `insert into employee (company_id, odoo_id, employee_number, full_name, mobile,
                             supervisor_employee_id)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [companyId, person.odooId, person.number, person.name, person.mobile, supervisor.id],
    );
    employees[person.name] = row.id;
  }

  const supervisorUser = await q<{ id: string }>(
    `insert into app_user (company_id, employee_id, email, role)
     values ($1,$2,'marcus@skelscaff.com.au','supervisor') returning id`,
    [companyId, supervisor.id],
  );
  const adminUser = await q<{ id: string }>(
    `insert into app_user (company_id, email, role)
     values ($1,'office@skelscaff.com.au','admin') returning id`,
    [companyId],
  );
  for (const person of [...CREW_A, ...CREW_B]) {
    await db.query(
      `insert into app_user (company_id, employee_id, phone, role) values ($1,$2,$3,'worker')`,
      [companyId, employees[person.name], person.mobile],
    );
  }

  const crewA = await q<{ id: string }>(
    `insert into crew (company_id, name, supervisor_employee_id) values ($1,'Crew A',$2) returning id`,
    [companyId, supervisor.id],
  );
  const crewB = await q<{ id: string }>(
    `insert into crew (company_id, name, supervisor_employee_id) values ($1,'Crew B',$2) returning id`,
    [companyId, supervisor.id],
  );
  for (const person of CREW_A) {
    await db.query('insert into crew_member (crew_id, employee_id) values ($1,$2)', [
      crewA.id,
      employees[person.name],
    ]);
  }
  for (const person of CREW_B) {
    await db.query('insert into crew_member (crew_id, employee_id) values ($1,$2)', [
      crewB.id,
      employees[person.name],
    ]);
  }

  // --- jobs and sites ------------------------------------------------------

  const jobs: Record<string, { id: string; lat: number; lng: number }> = {};
  let odooJobId = 3311;
  for (const s of SITES) {
    const site = await q<{ id: string }>(
      `insert into site (company_id, name, address, latitude, longitude, geofence_radius_m)
       values ($1,$2,$3,$4,$5,200) returning id`,
      [companyId, s.site, s.address, s.lat, s.lng],
    );
    const job = await q<{ id: string }>(
      `insert into job (company_id, odoo_model, odoo_id, job_number, customer_name, site_id, status)
       values ($1,'project.project',$2,$3,$4,$5,'active') returning id`,
      [companyId, odooJobId++, s.jobNumber, s.customer, site.id],
    );
    jobs[s.jobNumber] = { id: job.id, lat: s.lat, lng: s.lng };
  }

  // --- today ---------------------------------------------------------------

  const now = new Date();
  const today = localDate(now);
  const at = (hours: number, minutes = 0): string => {
    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    return d.toISOString();
  };
  /** Hours before now, for shifts that must look live whatever time you visit. */
  const ago = (hours: number): string => new Date(now.getTime() - hours * 3_600_000).toISOString();

  for (const [crewId, roster, jobNumber] of [
    [crewA.id, CREW_A, '1032'],
    [crewB.id, CREW_B, '1041'],
  ] as const) {
    for (const person of roster) {
      await db.query(
        `insert into assignment (company_id, job_id, employee_id, crew_id, work_date, scheduled_start)
         values ($1,$2,$3,null,$4,$5)`,
        [companyId, jobs[jobNumber]!.id, employees[person.name], today, at(6, 30)],
      );
    }
    void crewId;
  }

  const event = (
    employeeId: string,
    eventType: ClockEventInput['eventType'],
    deviceTime: string,
    options: Partial<ClockEventInput> = {},
  ): ClockEventInput => ({
    idempotencyKey: newIdempotencyKey('demo'),
    employeeId,
    eventType,
    deviceTime,
    jobId: jobs['1032']!.id,
    workActivityId: activity.ERECT!,
    latitude: jobs['1032']!.lat + 0.0002,
    longitude: jobs['1032']!.lng + 0.0002,
    gpsAccuracyM: 7,
    clockMethod: 'manual',
    wasOffline: false,
    deviceId: 'demo',
    ...options,
  });

  // Dean — on the tools, on site, since ~6:30 this morning.
  await ingestEvents(db, {
    companyId,
    events: [event(employees['Dean Whitmore']!, 'clock_in', earlier(now, at(6, 30)))],
    now,
  });

  // Tobias — on a break right now.
  await ingestEvents(db, {
    companyId,
    events: [
      event(employees['Tobias Renner']!, 'clock_in', earlier(now, at(6, 30))),
      event(employees['Tobias Renner']!, 'break_start', ago(0.4)),
    ],
    now,
  });

  // Ana — clocked on 4km from site with no reason given: an open exception,
  // and the case the Working Now screen exists to surface.
  await ingestEvents(db, {
    companyId,
    events: [
      event(employees['Ana Petrovic']!, 'clock_in', earlier(now, at(7, 0)), {
        latitude: jobs['1032']!.lat - 0.036,
        longitude: jobs['1032']!.lng,
        gpsAccuracyM: 12,
      }),
    ],
    now,
  });

  // Mikhail — on the second job, phone had no reception when he started.
  await ingestEvents(db, {
    companyId,
    events: [
      event(employees['Mikhail Dvorak']!, 'clock_in', earlier(now, at(6, 45)), {
        jobId: jobs['1041']!.id,
        workActivityId: activity.DISMANTLE!,
        latitude: jobs['1041']!.lat,
        longitude: jobs['1041']!.lng,
        wasOffline: true,
      }),
    ],
    now,
  });

  // Priya is rostered but has not clocked on — deliberately left absent.

  // --- the past few days ---------------------------------------------------

  const odoo = new MockOdooAdapter();
  const completed: string[] = [];

  for (let daysBack = 1; daysBack <= 5; daysBack += 1) {
    const day = new Date(now.getTime() - daysBack * 86_400_000);
    if (day.getDay() === 0 || day.getDay() === 6) continue; // no weekend work

    const jobNumber = daysBack % 3 === 0 ? '1047' : daysBack % 2 === 0 ? '1041' : '1032';
    const job = jobs[jobNumber]!;

    for (const person of [...CREW_A, ...CREW_B]) {
      // A plausible spread of start and finish times rather than everyone
      // clocking the same minute, which would make the totals look synthetic.
      const startHour = 6 + ((person.odooId + daysBack) % 2) * 0.5;
      const endHour = 14 + ((person.odooId + daysBack) % 3) * 0.5;

      const employeeId = employees[person.name]!;
      const result = await ingestEvents(db, {
        companyId,
        events: [
          event(employeeId, 'clock_in', onDay(day, startHour), {
            jobId: job.id,
            latitude: job.lat,
            longitude: job.lng,
          }),
          event(employeeId, 'break_start', onDay(day, 9)),
          event(employeeId, 'break_end', onDay(day, 9.5)),
          event(employeeId, 'clock_out', onDay(day, endHour), {
            jobId: job.id,
            latitude: job.lat,
            longitude: job.lng,
          }),
        ],
        now: new Date(day.getTime() + 15 * 3_600_000),
      });
      completed.push(...result.affectedTimesheetIds);
    }
  }

  // Approve most of them, leaving the most recent day for the office to do —
  // so the Timesheets screen has something in every status.
  const toApprove = completed.slice(0, Math.max(0, completed.length - 3));
  for (const timesheetId of toApprove) {
    await confirmTimesheet(db, { timesheetId, actorUserId: supervisorUser.id });
    await approveTimesheet(db, { timesheetId, actorUserId: supervisorUser.id });
    await enqueueTimesheetPush(db, { companyId, timesheetId });
  }
  await runSyncWorker(db, odoo, { companyId, limit: 100 });

  // A supervisor correction on one of them, so the audit trail is not empty.
  const correctable = toApprove[0];
  if (correctable) {
    const { rows } = await db.query<{ id: string }>(
      `select id from attendance_event
        where timesheet_id = $1 and event_type = 'clock_in' and voided_at is null limit 1`,
      [correctable],
    );
    if (rows[0]) {
      await correctEvent(db, {
        eventId: rows[0].id,
        actorUserId: supervisorUser.id,
        reason: 'Worker confirmed start was 6:30 — phone clocked on from the ute',
        changes: { deviceTime: shiftMinutes(await deviceTimeOf(db, rows[0].id), 15) },
      }).catch(() => undefined);
    }
  }

  // One push that failed, so the Odoo Sync screen shows a real error and a
  // working Retry button rather than an empty success list.
  const failing = completed[completed.length - 1];
  if (failing) {
    await approveTimesheet(db, { timesheetId: failing, actorUserId: supervisorUser.id }).catch(
      () => undefined,
    );
    await enqueueTimesheetPush(db, { companyId, timesheetId: failing });
    await runSyncWorker(db, new MockOdooAdapter({ failureMode: 'always' }), {
      companyId,
      limit: 1,
    });
  }

  void adminUser;
  void crewB;
}

// --- helpers ----------------------------------------------------------------

function localDate(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/** The earlier of a fixed clock time and now, so shifts never start in the future. */
function earlier(now: Date, iso: string): string {
  return Date.parse(iso) < now.getTime() ? iso : new Date(now.getTime() - 3_600_000).toISOString();
}

function onDay(day: Date, hours: number): string {
  const d = new Date(day);
  d.setHours(Math.floor(hours), Math.round((hours % 1) * 60), 0, 0);
  return d.toISOString();
}

function shiftMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

async function deviceTimeOf(db: Db, eventId: string): Promise<string> {
  const { rows } = await db.query<{ device_time: Date | string }>(
    'select device_time from attendance_event where id = $1',
    [eventId],
  );
  const value = rows[0]!.device_time;
  return value instanceof Date ? value.toISOString() : String(value);
}
