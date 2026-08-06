/**
 * The First Engineering Deliverable from the brief, run end to end.
 *
 *   1. Import one employee from Odoo.
 *   2. Import one job from Odoo.
 *   3. Clock the employee into the job from a phone.
 *   4. Capture time and GPS coordinates.
 *   5. Approve the attendance.
 *   6. Create the correct attendance record in Odoo.
 *   7. Display the successful Odoo sync status.
 *
 * Runs against the mock Odoo and an in-process Postgres by default, so it
 * works on a clean clone with no credentials:
 *
 *     npm run poc
 *
 * Point it at the real thing by filling in .env and running:
 *
 *     ODOO_MODE=live npm run poc
 *
 * Nothing in the flow below changes between the two — that is the point of the
 * adapter layer.
 */

import { newIdempotencyKey } from '@skelclock/core';
import { createOdooAdapter, MockOdooAdapter } from '@skelclock/odoo';
import {
  approveTimesheet,
  confirmTimesheet,
  enqueueTimesheetPush,
  getWorkerHome,
  importEmployees,
  importJobs,
  ingestEvents,
  listSyncJobs,
  listTimesheets,
  runSyncWorker,
  type Db,
} from '@skelclock/server';

import { createLocalDb } from './local-db.js';

// --- presentation -----------------------------------------------------------

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let stepNumber = 0;
const failures: string[] = [];

function step(title: string): void {
  stepNumber += 1;
  console.log(`\n${BOLD}${CYAN}Step ${stepNumber}: ${title}${RESET}`);
}

function ok(message: string): void {
  console.log(`  ${GREEN}✓${RESET} ${message}`);
}

function detail(message: string): void {
  console.log(`    ${DIM}${message}${RESET}`);
}

function check(condition: boolean, message: string): void {
  if (condition) {
    ok(message);
  } else {
    console.log(`  ${RED}✗ ${message}${RESET}`);
    failures.push(message);
  }
}

// --- the run ----------------------------------------------------------------

async function main(): Promise<void> {
  const odoo = createOdooAdapter(process.env);
  const { db, close } = await createLocalDb();

  console.log(
    `${BOLD}SkelClock — proof of concept${RESET}\n` +
      `${DIM}Odoo: ${odoo.mode}   Database: PGlite (in-process Postgres 17)${RESET}`,
  );

  try {
    // --- 0. connection ------------------------------------------------------
    step('Connect to Odoo');
    const connection = await odoo.testConnection();
    check(connection.reachable, `Reachable, server version ${connection.serverVersion}`);
    if (!connection.reachable) {
      detail(connection.error ?? 'no error given');
      throw new Error('Cannot continue without Odoo');
    }
    for (const [model, available] of Object.entries(connection.models)) {
      detail(`${available ? '✓' : '·'} ${model}`);
    }

    const companyRows = await db.query<{ id: string }>(
      `insert into company (name, timezone, odoo_id)
       values ('SkelScaff', 'Australia/Sydney', 1) returning id`,
    );
    const companyId = companyRows.rows[0]!.id;
    await db.query('select seed_default_activities($1)', [companyId]);

    // --- 1. import one employee --------------------------------------------
    step('Import one employee from Odoo');
    const employeeImport = await importEmployees(db, odoo, { companyId, limit: 1 });
    const employee = await first<{
      id: string;
      odoo_id: number;
      full_name: string;
      mobile: string | null;
      employee_number: string | null;
    }>(db, 'select id, odoo_id, full_name, mobile, employee_number from employee limit 1');

    check(employeeImport.total >= 1 && employee !== null, 'Employee imported');
    if (!employee) throw new Error('No employee came back from Odoo');
    detail(`${employee.full_name} (#${employee.employee_number ?? '—'})`);
    detail(`Odoo hr.employee id ${employee.odoo_id} stored against the app user`);
    detail(`Mobile normalised to ${employee.mobile}`);

    const userRows = await db.query<{ id: string }>(
      `insert into app_user (company_id, employee_id, email, phone, role)
       values ($1, $2, $3, $4, 'worker') returning id`,
      [companyId, employee.id, null, employee.mobile],
    );
    const workerUserId = userRows.rows[0]!.id;

    const supervisorRows = await db.query<{ id: string }>(
      `insert into app_user (company_id, email, role)
       values ($1, 'supervisor@skelscaff.com.au', 'supervisor') returning id`,
      [companyId],
    );
    const supervisorUserId = supervisorRows.rows[0]!.id;

    // --- 2. import one job --------------------------------------------------
    step('Import one job from Odoo');
    await importJobs(db, odoo, { companyId, limit: 1 });
    const job = await first<{
      id: string;
      odoo_id: number;
      odoo_model: string;
      job_number: string;
      customer_name: string | null;
      site_name: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      geofence_radius_m: number;
    }>(
      db,
      `select j.id, j.odoo_id, j.odoo_model, j.job_number, j.customer_name,
              s.name as site_name, s.address, s.latitude, s.longitude, s.geofence_radius_m
         from job j left join site s on s.id = j.site_id limit 1`,
    );

    check(job !== null, 'Job imported');
    if (!job) throw new Error('No job came back from Odoo');
    detail(`Job ${job.job_number} — ${job.customer_name ?? 'no customer'}`);
    detail(`From ${job.odoo_model} id ${job.odoo_id}`);
    detail(`Site: ${job.site_name ?? '—'}, ${job.address ?? 'no address'}`);
    detail(
      job.latitude != null
        ? `Geofence: ${job.latitude}, ${job.longitude} r=${job.geofence_radius_m}m`
        : 'Geofence: no coordinates in Odoo — see GEO_NOTE in packages/odoo/src/mapping.ts',
    );

    const workDate = '2026-08-04';
    await db.query(
      `insert into assignment (company_id, job_id, employee_id, work_date, scheduled_start)
       values ($1,$2,$3,$4,$5)`,
      [companyId, job.id, employee.id, workDate, '2026-08-03T20:00:00Z'],
    );

    // --- 3 & 4. clock in from a phone, capturing time and GPS ---------------
    step('Clock the employee into the job from a phone');

    // What the device sends. On site, GPS good, online.
    const deviceId = 'poc-pixel-8';
    const clockInKey = newIdempotencyKey(deviceId);
    const onSite =
      job.latitude != null && job.longitude != null
        ? { latitude: job.latitude + 0.0003, longitude: job.longitude + 0.0002 }
        : { latitude: null, longitude: null };

    const clockIn = await ingestEvents(db, {
      companyId,
      actingUserId: workerUserId,
      now: new Date('2026-08-03T20:00:04Z'),
      events: [
        {
          idempotencyKey: clockInKey,
          employeeId: employee.id,
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00+10:00',
          jobId: job.id,
          workActivityId: await activityId(db, companyId, 'ERECT'),
          latitude: onSite.latitude,
          longitude: onSite.longitude,
          gpsAccuracyM: 6.4,
          clockMethod: 'manual',
          wasOffline: false,
          deviceId,
        },
      ],
    });

    const clockInOutcome = clockIn.outcomes[0]!;
    check(clockInOutcome.status === 'created', 'Clock-in accepted');
    const timesheetId = clockIn.affectedTimesheetIds[0]!;

    const home = await getWorkerHome(db, {
      companyId,
      employeeId: employee.id,
      workDate,
      now: new Date('2026-08-03T23:00:00Z'), // 09:00 AEST
    });
    detail(`Worker home screen: ${home.clockState}, job ${home.assignedJob?.jobNumber}`);
    detail(`Hours so far: ${home.hoursWorkedLabel}`);

    step('Capture time and GPS coordinates');
    const stored = await first<{
      device_time: Date;
      server_time: Date;
      latitude: number | null;
      longitude: number | null;
      gps_accuracy_m: number | null;
      inside_geofence: boolean | null;
      distance_from_site_m: number | null;
      clock_method: string;
      was_offline: boolean;
      idempotency_key: string;
    }>(
      db,
      `select device_time, server_time, latitude, longitude, gps_accuracy_m,
              inside_geofence, distance_from_site_m, clock_method, was_offline,
              idempotency_key
         from attendance_event where event_type = 'clock_in' limit 1`,
    );

    check(stored?.device_time != null, 'Device timestamp recorded');
    detail(`Device time: ${stored!.device_time.toISOString()} (what the phone said)`);
    detail(`Server time: ${stored!.server_time.toISOString()} (when we received it)`);
    check(stored!.latitude != null, 'GPS coordinates recorded');
    detail(`Position: ${stored!.latitude}, ${stored!.longitude} ±${stored!.gps_accuracy_m}m`);
    check(stored!.inside_geofence === true, 'Inside the site geofence');
    detail(`Distance from site centre: ${stored!.distance_from_site_m?.toFixed(1)}m`);
    detail(`Method: ${stored!.clock_method}, offline: ${stored!.was_offline}`);
    detail(`Idempotency key: ${stored!.idempotency_key}`);

    // Retry the same event, as a flaky connection would.
    const replay = await ingestEvents(db, {
      companyId,
      actingUserId: workerUserId,
      events: [
        {
          idempotencyKey: clockInKey,
          employeeId: employee.id,
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00+10:00',
          jobId: job.id,
          latitude: onSite.latitude,
          longitude: onSite.longitude,
          gpsAccuracyM: 6.4,
          clockMethod: 'manual',
          wasOffline: false,
          deviceId,
        },
      ],
    });
    check(replay.outcomes[0]!.status === 'duplicate', 'A retried event is deduplicated');

    // Break, then knock off.
    await ingestEvents(db, {
      companyId,
      actingUserId: workerUserId,
      now: new Date('2026-08-04T04:30:00Z'),
      events: [
        {
          idempotencyKey: newIdempotencyKey(deviceId),
          employeeId: employee.id,
          eventType: 'break_start',
          deviceTime: '2026-08-04T09:00:00+10:00',
          jobId: job.id,
          clockMethod: 'manual',
          wasOffline: false,
          deviceId,
        },
        {
          idempotencyKey: newIdempotencyKey(deviceId),
          employeeId: employee.id,
          eventType: 'break_end',
          deviceTime: '2026-08-04T09:30:00+10:00',
          jobId: job.id,
          clockMethod: 'manual',
          wasOffline: false,
          deviceId,
        },
        {
          idempotencyKey: newIdempotencyKey(deviceId),
          employeeId: employee.id,
          eventType: 'clock_out',
          deviceTime: '2026-08-04T14:30:00+10:00',
          jobId: job.id,
          latitude: onSite.latitude,
          longitude: onSite.longitude,
          gpsAccuracyM: 9.1,
          clockMethod: 'manual',
          // Reception dropped before knock-off; this one queued on the device.
          wasOffline: true,
          deviceId,
        },
      ],
    });

    const totals = await first<{
      total_shift_minutes: number;
      total_break_minutes: number;
      total_paid_minutes: number;
    }>(
      db,
      'select total_shift_minutes, total_break_minutes, total_paid_minutes from timesheet where id = $1',
      [timesheetId],
    );
    detail(
      `Day totals — shift ${fmt(totals!.total_shift_minutes)}, ` +
        `unpaid break ${fmt(totals!.total_break_minutes)}, ` +
        `paid ${fmt(totals!.total_paid_minutes)}`,
    );
    // 06:00 to 14:30 is 8h30 on site, less the 30m unpaid break = 8h paid.
    check(totals!.total_shift_minutes === 510, 'Shift time computed as 8h 30m');
    check(totals!.total_break_minutes === 30, 'Unpaid break computed as 30m');
    check(totals!.total_paid_minutes === 480, 'Paid hours computed as 8h 00m');

    // --- 5. approve the attendance ------------------------------------------
    step('Approve the attendance');
    await confirmTimesheet(db, { timesheetId, actorUserId: workerUserId });
    const approved = await approveTimesheet(db, {
      timesheetId,
      actorUserId: supervisorUserId,
    });
    check(approved.status === 'supervisor_approved', 'Supervisor approved the day');

    const ladder = await db.query<{ action: string; from_status: string; to_status: string }>(
      'select action, from_status, to_status from approval where timesheet_id = $1 order by created_at',
      [timesheetId],
    );
    for (const rung of ladder.rows) {
      detail(`${rung.from_status} → ${rung.to_status} (${rung.action})`);
    }

    // --- 6. create the attendance record in Odoo ----------------------------
    step('Create the attendance record in Odoo');
    await enqueueTimesheetPush(db, { companyId, timesheetId });
    const run = await runSyncWorker(db, odoo, { companyId });

    check(run.succeeded === 1 && run.failed === 0, 'Push succeeded');
    if (run.errors.length > 0) {
      for (const e of run.errors) detail(`${RED}${e.error}${RESET}`);
    }

    const links = await db.query<{ block_index: number; odoo_id: number; check_in: Date; check_out: Date }>(
      'select block_index, odoo_id, check_in, check_out from odoo_attendance_link where timesheet_id = $1 order by block_index',
      [timesheetId],
    );
    for (const link of links.rows) {
      detail(
        `hr.attendance id ${link.odoo_id}: ` +
          `${link.check_in.toISOString()} → ${link.check_out.toISOString()}`,
      );
    }
    check(
      links.rows.length === 2,
      'Unpaid break split the day into two records, so Odoo hours equal paid hours',
    );

    if (odoo instanceof MockOdooAdapter) {
      const odooHours = odoo
        .attendanceRecords()
        .reduce(
          (sum, r) =>
            sum + (Date.parse(`${r.check_out}Z`) - Date.parse(`${r.check_in}Z`)) / 3_600_000,
          0,
        );
      const paidHours = totals!.total_paid_minutes / 60;
      check(
        odooHours === paidHours,
        `Odoo worked_hours totals ${odooHours}h, matching our ${paidHours}h paid`,
      );
    }

    // --- 7. display the sync status -----------------------------------------
    step('Display the Odoo sync status');
    const syncJobs = await listSyncJobs(db, { companyId });
    for (const j of syncJobs) {
      const colour = j.status === 'success' ? GREEN : RED;
      console.log(
        `  ${colour}${j.status.toUpperCase()}${RESET} ` +
          `${j.entityType}/${j.operation} — ${j.employeeName} ${j.workDate} ` +
          `${DIM}odoo id ${j.odooRecordId ?? '—'}, attempts ${j.attempts}${RESET}`,
      );
      if (j.lastError) detail(`${RED}${j.lastError}${RESET}`);
    }

    const sheets = await listTimesheets(db, { companyId });
    for (const s of sheets) {
      console.log(
        `  ${s.workDate}  ${s.employeeName}  ${s.paidHoursLabel}  ` +
          `${BOLD}${s.status}${RESET}  ${DIM}jobs ${s.jobNumbers.join(', ')}, ` +
          `odoo ${s.odooIds.join(', ') || '—'}${RESET}`,
      );
    }
    check(sheets[0]?.status === 'synced', 'Timesheet marked synced');

    // --- summary -------------------------------------------------------------
    console.log(
      `\n${BOLD}${failures.length === 0 ? `${GREEN}Proof of concept passed` : `${RED}${failures.length} check(s) failed`}${RESET}`,
    );
    for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
  } finally {
    await close();
  }

  if (failures.length > 0) process.exitCode = 1;
}

// --- helpers ----------------------------------------------------------------

async function first<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0] ?? null;
}

async function activityId(db: Db, companyId: string, code: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    'select id from work_activity where company_id = $1 and code = $2',
    [companyId, code],
  );
  return row?.id ?? null;
}

const fmt = (minutes: number): string =>
  `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

main().catch((error) => {
  console.error(`\n${RED}Proof of concept failed:${RESET}`, error);
  process.exit(1);
});
