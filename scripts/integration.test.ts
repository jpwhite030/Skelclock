/**
 * Integration tests — the service layer against real Postgres.
 *
 * Each numbered block maps to one of the MVP acceptance criteria in the brief.
 * They run on PGlite, which is Postgres 17, so the triggers and constraints
 * being asserted are the same ones that will run on Supabase.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newIdempotencyKey, type ClockEventInput } from '@skelclock/core';
import { MockOdooAdapter, DEMO_EMPLOYEE, DEMO_JOB } from '@skelclock/odoo';
import {
  addMissingEvent,
  approveTimesheet,
  clockCrew,
  confirmTimesheet,
  correctEvent,
  enqueueTimesheetPush,
  getAuditTrail,
  getWorkerHome,
  getWorkingNow,
  importEmployees,
  importJobs,
  ingestEvents,
  listExceptions,
  listSyncJobs,
  listTimesheets,
  lockTimesheet,
  normaliseMobile,
  reopenTimesheet,
  retrySyncJob,
  runSyncWorker,
  type Db,
} from '@skelclock/server';

import { createLocalDb, seedFixture, type Fixture } from './local-db.js';

// --- harness ----------------------------------------------------------------

async function freshDb(): Promise<{ db: Db; fx: Fixture; close: () => Promise<void> }> {
  const { db, close } = await createLocalDb();
  const fx = await seedFixture(db);
  return { db, fx, close };
}

const SITE = { latitude: -34.4248, longitude: 150.8931 }; // inside the fence
const OFF_SITE = { latitude: -34.4600, longitude: 150.8931 }; // ~4km away

function clockEvent(
  fx: Fixture,
  overrides: Partial<ClockEventInput> & Pick<ClockEventInput, 'eventType' | 'deviceTime'>,
): ClockEventInput {
  return {
    idempotencyKey: newIdempotencyKey('test-device'),
    employeeId: fx.employeeId,
    jobId: fx.jobId,
    workActivityId: fx.activities.ERECT!,
    latitude: SITE.latitude,
    longitude: SITE.longitude,
    gpsAccuracyM: 8,
    clockMethod: 'manual',
    wasOffline: false,
    deviceId: 'test-device',
    ...overrides,
  };
}

const NOW = new Date('2026-08-04T09:00:00Z');

// --- 1. employees and jobs sync from Odoo -----------------------------------

test('AC1: employees and jobs import from Odoo and keep their Odoo ids', async () => {
  const { db, close } = await createLocalDb();
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into company (name, timezone) values ('SkelScaff', 'Australia/Sydney') returning id`,
    );
    const companyId = rows[0]!.id;
    const odoo = new MockOdooAdapter();

    const employees = await importEmployees(db, odoo, { companyId });
    assert.equal(employees.created, 1);

    const jobs = await importJobs(db, odoo, { companyId });
    assert.equal(jobs.created, 1);

    const employee = await db.query<{ odoo_id: number; full_name: string; mobile: string }>(
      'select odoo_id, full_name, mobile from employee where company_id = $1',
      [companyId],
    );
    assert.equal(employee.rows[0]!.odoo_id, DEMO_EMPLOYEE.odooId);
    assert.equal(employee.rows[0]!.full_name, DEMO_EMPLOYEE.fullName);

    const job = await db.query<{ odoo_id: number; job_number: string; latitude: number }>(
      `select j.odoo_id, j.job_number, s.latitude
         from job j join site s on s.id = j.site_id where j.company_id = $1`,
      [companyId],
    );
    assert.equal(job.rows[0]!.odoo_id, DEMO_JOB.odooId);
    assert.equal(job.rows[0]!.job_number, '1032');
    assert.equal(job.rows[0]!.latitude, DEMO_JOB.latitude);
  } finally {
    await close();
  }
});

test('AC1: re-importing updates in place rather than creating a second employee', async () => {
  const { db, close } = await createLocalDb();
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into company (name) values ('SkelScaff') returning id`,
    );
    const companyId = rows[0]!.id;
    const odoo = new MockOdooAdapter();

    await importEmployees(db, odoo, { companyId });
    const second = await importEmployees(db, odoo, { companyId });

    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);

    const count = await db.query<{ count: string }>(
      'select count(*)::text as count from employee where company_id = $1',
      [companyId],
    );
    assert.equal(count.rows[0]!.count, '1');
  } finally {
    await close();
  }
});

test('AC1: Australian mobile numbers normalise so OTP login can match them', () => {
  assert.equal(normaliseMobile('0412 555 208'), '+61412555208');
  assert.equal(normaliseMobile('+61 412 555 208'), '+61412555208');
  assert.equal(normaliseMobile('61412555208'), '+61412555208');
  assert.equal(normaliseMobile('412555208'), '+61412555208');
  assert.equal(normaliseMobile(null), null);
  assert.equal(normaliseMobile(''), null);
});

// --- 2. a worker can clock in and out online --------------------------------

test('AC2: a full day online produces the right segments and paid hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      actingUserId: fx.workerUserId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'break_start', deviceTime: '2026-08-04T09:00:00Z' }),
        clockEvent(fx, { eventType: 'break_end', deviceTime: '2026-08-04T09:30:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });

    assert.equal(result.outcomes.filter((o) => o.status === 'created').length, 4);
    assert.equal(result.affectedTimesheetIds.length, 1);

    const sheet = await db.query<{
      total_shift_minutes: number;
      total_break_minutes: number;
      total_paid_minutes: number;
      status: string;
    }>(
      'select total_shift_minutes, total_break_minutes, total_paid_minutes, status from timesheet where id = $1',
      [result.affectedTimesheetIds[0]],
    );

    assert.equal(sheet.rows[0]!.total_shift_minutes, 480);
    assert.equal(sheet.rows[0]!.total_break_minutes, 30);
    assert.equal(sheet.rows[0]!.total_paid_minutes, 450);
    assert.equal(sheet.rows[0]!.status, 'draft');
  } finally {
    await close();
  }
});

test('AC2: the worker home screen shows job, state and live hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await db.query(
      `insert into assignment (company_id, job_id, employee_id, work_date, scheduled_start)
       values ($1,$2,$3,'2026-08-04','2026-08-04T06:00:00Z')`,
      [fx.companyId, fx.jobId, fx.employeeId],
    );

    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });

    assert.equal(home.clockState, 'working');
    assert.equal(home.assignedJob?.jobNumber, '1032');
    assert.equal(home.assignedJob?.siteAddress, '14 Kembla Street, Wollongong NSW 2500');
    assert.equal(home.minutesWorked, 180);
    assert.equal(home.hoursWorkedLabel, '3h 00m');
    assert.equal(home.currentJobId, fx.jobId);
  } finally {
    await close();
  }
});

// --- 3. a worker can clock in and out offline -------------------------------

test('AC3: an offline day syncs later and keeps the original device times', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // The phone had no reception all day and flushes at 15:00 — and the queue
    // comes back out of order, which is the case that breaks naive ingest.
    const syncedAt = new Date('2026-08-04T15:00:00Z');

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: syncedAt,
      events: [
        clockEvent(fx, {
          eventType: 'clock_out',
          deviceTime: '2026-08-04T14:00:00Z',
          wasOffline: true,
        }),
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          wasOffline: true,
        }),
      ],
    });

    assert.equal(result.outcomes.every((o) => o.status === 'created'), true);

    const events = await db.query<{ event_type: string; device_time: Date; server_time: Date }>(
      `select event_type, device_time, server_time from attendance_event
        where employee_id = $1 order by device_time`,
      [fx.employeeId],
    );

    assert.equal(events.rows[0]!.event_type, 'clock_in');
    assert.equal(events.rows[0]!.device_time.toISOString(), '2026-08-04T06:00:00.000Z');
    // The device time is the worker's; the server time records when it landed.
    assert.equal(events.rows[0]!.server_time.toISOString(), syncedAt.toISOString());

    const sheet = await db.query<{ total_paid_minutes: number }>(
      'select total_paid_minutes from timesheet where id = $1',
      [result.affectedTimesheetIds[0]],
    );
    assert.equal(sheet.rows[0]!.total_paid_minutes, 480);
  } finally {
    await close();
  }
});

test('AC3: offline events raise an informational exception, not a blocking one', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T15:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z', wasOffline: true }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z', wasOffline: true }),
      ],
    });

    const exceptions = await listExceptions(db, { companyId: fx.companyId });
    const offline = exceptions.find((e) => e.type === 'offline_event');
    assert.ok(offline);
    assert.equal(offline!.severity, 3);
    assert.equal(offline!.details.count, 2);
  } finally {
    await close();
  }
});

// --- 4. GPS and geofence status are saved -----------------------------------

test('AC4: an inside-fence clock records the distance and the verdict', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.status === 'created' && outcome.insideGeofence, true);

    const row = await db.query<{
      latitude: number;
      longitude: number;
      gps_accuracy_m: number;
      inside_geofence: boolean;
      distance_from_site_m: number;
    }>(
      `select latitude, longitude, gps_accuracy_m, inside_geofence, distance_from_site_m
         from attendance_event where employee_id = $1`,
      [fx.employeeId],
    );

    assert.equal(row.rows[0]!.latitude, SITE.latitude);
    assert.equal(row.rows[0]!.gps_accuracy_m, 8);
    assert.equal(row.rows[0]!.inside_geofence, true);
    assert.ok(row.rows[0]!.distance_from_site_m < 5);
  } finally {
    await close();
  }
});

test('AC4: an outside-fence clock is accepted, flagged, and never blocked', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          latitude: OFF_SITE.latitude,
          longitude: OFF_SITE.longitude,
        }),
      ],
    });

    // The clock is never refused — that is the explicit instruction in the brief.
    assert.equal(result.outcomes[0]!.status, 'created');
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status === 'created' && outcome.insideGeofence, false);
    assert.ok(outcome.status === 'created' && outcome.distanceM! > 3000);

    const exceptions = await listExceptions(db, { companyId: fx.companyId });
    assert.ok(exceptions.some((e) => e.type === 'outside_geofence'));
  } finally {
    await close();
  }
});

test('AC4: an outside-fence clock with a reason does not raise an exception', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          latitude: OFF_SITE.latitude,
          longitude: OFF_SITE.longitude,
          outsideReason: 'Gate locked, parked in the overflow yard up the road',
        }),
      ],
    });

    const exceptions = await listExceptions(db, { companyId: fx.companyId });
    assert.equal(exceptions.some((e) => e.type === 'outside_geofence'), false);
  } finally {
    await close();
  }
});

// --- 5. a supervisor can correct and approve hours --------------------------

test('AC5: a correction preserves the original value and writes an audit trail', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    const clockIn = await db.query<{ id: string }>(
      `select id from attendance_event
        where employee_id = $1 and event_type = 'clock_in'`,
      [fx.employeeId],
    );

    // Worker actually started at 06:30; the phone was in the ute at 06:00.
    const correction = await correctEvent(db, {
      eventId: clockIn.rows[0]!.id,
      actorUserId: fx.supervisorUserId,
      reason: 'Worker confirmed start was 6:30, phone clocked in from the ute',
      changes: { deviceTime: '2026-08-04T06:30:00Z' },
    });

    assert.deepEqual(correction.changedFields, ['device_time']);

    // The original survives, voided, pointing at its replacement.
    const original = await db.query<{
      voided_at: Date | null;
      void_reason: string;
      superseded_by: string;
      device_time: Date;
    }>(
      'select voided_at, void_reason, superseded_by, device_time from attendance_event where id = $1',
      [clockIn.rows[0]!.id],
    );
    assert.ok(original.rows[0]!.voided_at);
    assert.equal(original.rows[0]!.device_time.toISOString(), '2026-08-04T06:00:00.000Z');
    assert.equal(original.rows[0]!.superseded_by, correction.replacementEventId);

    // The correction row carries before and after.
    const corrections = await db.query<{
      field: string;
      original_value: string;
      new_value: string;
      reason: string;
    }>('select field, original_value, new_value, reason from correction where timesheet_id = $1', [
      timesheetId,
    ]);
    assert.equal(corrections.rows[0]!.field, 'device_time');
    assert.ok(corrections.rows[0]!.original_value.startsWith('2026-08-04T06:00'));
    assert.ok(corrections.rows[0]!.new_value.startsWith('2026-08-04T06:30'));

    // Hours are recomputed: 8h becomes 7.5h.
    const sheet = await db.query<{ total_paid_minutes: number }>(
      'select total_paid_minutes from timesheet where id = $1',
      [timesheetId],
    );
    assert.equal(sheet.rows[0]!.total_paid_minutes, 450);

    const audit = await getAuditTrail(db, { companyId: fx.companyId, timesheetId });
    assert.ok(audit.some((a) => a.reason?.includes('phone clocked in from the ute')));
  } finally {
    await close();
  }
});

test('AC5: a correction requires a reason', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const event = await db.query<{ id: string }>(
      'select id from attendance_event where employee_id = $1',
      [fx.employeeId],
    );

    await assert.rejects(
      () =>
        correctEvent(db, {
          eventId: event.rows[0]!.id,
          actorUserId: fx.supervisorUserId,
          reason: '   ',
          changes: { deviceTime: '2026-08-04T06:30:00Z' },
        }),
      /requires a reason/,
    );
  } finally {
    await close();
  }
});

test('AC5: a supervisor can add a clock-out the worker never made', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-05T09:00:00Z'),
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    let exceptions = await listExceptions(db, { companyId: fx.companyId, status: 'open' });
    assert.ok(exceptions.some((e) => e.type === 'missing_clock_out'));

    await addMissingEvent(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      timesheetId,
      eventType: 'clock_out',
      deviceTime: '2026-08-04T14:00:00Z',
      actorUserId: fx.supervisorUserId,
      reason: 'Phone went flat, crew knocked off at 2pm',
      now: new Date('2026-08-05T09:00:00Z'),
    });

    const sheet = await db.query<{ total_paid_minutes: number }>(
      'select total_paid_minutes from timesheet where id = $1',
      [timesheetId],
    );
    assert.equal(sheet.rows[0]!.total_paid_minutes, 480);

    // The exception clears itself once the day makes sense again.
    exceptions = await listExceptions(db, { companyId: fx.companyId, status: 'open' });
    assert.equal(exceptions.some((e) => e.type === 'missing_clock_out'), false);
  } finally {
    await close();
  }
});

test('AC5: the approval ladder only moves along declared edges', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    await confirmTimesheet(db, { timesheetId, actorUserId: fx.workerUserId });
    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });

    // Cannot jump straight to locked from approved.
    await assert.rejects(
      () => lockTimesheet(db, { timesheetId, actorUserId: fx.adminUserId }),
      /cannot move to "locked"/,
    );

    const approvals = await db.query<{ action: string; from_status: string; to_status: string }>(
      'select action, from_status, to_status from approval where timesheet_id = $1 order by created_at',
      [timesheetId],
    );
    assert.equal(approvals.rows[0]!.action, 'confirm');
    assert.equal(approvals.rows[1]!.to_status, 'supervisor_approved');
  } finally {
    await close();
  }
});

test('AC5: reopening a locked timesheet demands a reason', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;
    const odoo = new MockOdooAdapter();

    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });
    await lockTimesheet(db, { timesheetId, actorUserId: fx.adminUserId });

    await assert.rejects(
      () => reopenTimesheet(db, { timesheetId, actorUserId: fx.adminUserId }),
      /requires a reason/,
    );

    const reopened = await reopenTimesheet(db, {
      timesheetId,
      actorUserId: fx.adminUserId,
      reason: 'Payroll query — worker disputes Thursday hours',
    });
    assert.equal(reopened.status, 'draft');
  } finally {
    await close();
  }
});

// --- 6. approved hours sync into Odoo ---------------------------------------

test('AC6: an approved day reaches Odoo and the timesheet becomes synced', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter();

    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'break_start', deviceTime: '2026-08-04T09:00:00Z' }),
        clockEvent(fx, { eventType: 'break_end', deviceTime: '2026-08-04T09:30:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });

    const run = await runSyncWorker(db, odoo, { companyId: fx.companyId });
    assert.equal(run.succeeded, 1);
    assert.equal(run.failed, 0);

    // The unpaid break splits the day, so Odoo's hours equal our paid hours.
    const records = odoo.attendanceRecords();
    assert.equal(records.length, 2);
    const odooHours = records.reduce(
      (sum, r) =>
        sum + (Date.parse(`${r.check_out}Z`) - Date.parse(`${r.check_in}Z`)) / 3_600_000,
      0,
    );
    assert.equal(odooHours, 7.5);

    const sheet = await db.query<{ status: string }>(
      'select status from timesheet where id = $1',
      [timesheetId],
    );
    assert.equal(sheet.rows[0]!.status, 'synced');
  } finally {
    await close();
  }
});

test('AC6: an unapproved day is refused by the sync worker', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter();
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });

    await enqueueTimesheetPush(db, {
      companyId: fx.companyId,
      timesheetId: ingest.affectedTimesheetIds[0]!,
    });
    const run = await runSyncWorker(db, odoo, { companyId: fx.companyId });

    assert.equal(run.failed, 1);
    assert.match(run.errors[0]!.error, /only approved days/);
    assert.equal(odoo.attendanceCount(), 0);
  } finally {
    await close();
  }
});

test('AC6: a correction after sync updates the Odoo record instead of adding one', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter();
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });
    assert.equal(odoo.attendanceCount(), 1);

    // Supervisor fixes the start time, re-approves, re-syncs.
    const clockIn = await db.query<{ id: string }>(
      `select id from attendance_event
        where employee_id = $1 and event_type = 'clock_in' and voided_at is null`,
      [fx.employeeId],
    );
    await correctEvent(db, {
      eventId: clockIn.rows[0]!.id,
      actorUserId: fx.supervisorUserId,
      reason: 'Start was 6:30',
      changes: { deviceTime: '2026-08-04T06:30:00Z' },
    });

    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });

    // Still exactly one record in Odoo, now with the corrected time.
    const records = odoo.attendanceRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.check_in, '2026-08-04 06:30:00');
  } finally {
    await close();
  }
});

test('AC6: a day that shrinks from two Odoo records to one removes the spare', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter();
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'break_start', deviceTime: '2026-08-04T09:00:00Z' }),
        clockEvent(fx, { eventType: 'break_end', deviceTime: '2026-08-04T09:30:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });
    assert.equal(odoo.attendanceCount(), 2);

    // The break was recorded in error — void both break events.
    const breaks = await db.query<{ id: string }>(
      `select id from attendance_event
        where employee_id = $1 and event_type in ('break_start','break_end')`,
      [fx.employeeId],
    );
    for (const b of breaks.rows) {
      await db.query(
        `update attendance_event set voided_at = now(), void_reason = 'Break not taken' where id = $1`,
        [b.id],
      );
    }
    const { rebuildTimesheet } = await import('@skelclock/server');
    await rebuildTimesheet(db, timesheetId, { now: new Date('2026-08-04T15:00:00Z') });

    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });

    const records = odoo.attendanceRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.check_in, '2026-08-04 06:00:00');
    assert.equal(records[0]!.check_out, '2026-08-04 14:00:00');
  } finally {
    await close();
  }
});

// --- 7. failed syncs can be seen and retried --------------------------------

test('AC7: a failed sync is visible with its error and succeeds on retry', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter({ failureMode: 'first_n', failCount: 1 });
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });

    const firstRun = await runSyncWorker(db, odoo, { companyId: fx.companyId });
    assert.equal(firstRun.failed, 1);

    // The office sees it, with an error they can read.
    let jobs = await listSyncJobs(db, { companyId: fx.companyId });
    assert.equal(jobs[0]!.status, 'failed');
    assert.match(jobs[0]!.lastError!, /not allowed to modify hr\.attendance/);
    assert.equal(jobs[0]!.employeeName, 'Dean Whitmore');

    // And an exception is raised so it cannot be missed.
    const exceptions = await listExceptions(db, { companyId: fx.companyId, status: 'open' });
    assert.ok(exceptions.some((e) => e.type === 'odoo_sync_failure'));

    // Retry button.
    await retrySyncJob(db, jobs[0]!.id);
    const secondRun = await runSyncWorker(db, odoo, { companyId: fx.companyId });
    assert.equal(secondRun.succeeded, 1);

    jobs = await listSyncJobs(db, { companyId: fx.companyId });
    assert.equal(jobs[0]!.status, 'success');
    assert.equal(jobs[0]!.lastError, null);
    assert.ok(jobs[0]!.odooRecordId! > 0);
    assert.equal(odoo.attendanceCount(), 1);
  } finally {
    await close();
  }
});

test('AC7: a permanently failing sync goes dead rather than retrying forever', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter({ failureMode: 'always' });
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;
    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });

    // Drive it past max_attempts, ignoring the backoff clock.
    for (let i = 0; i < 9; i += 1) {
      await db.query(
        `update odoo_sync_job set next_attempt_at = now() where entity_id = $1`,
        [timesheetId],
      );
      await runSyncWorker(db, odoo, { companyId: fx.companyId });
    }

    const jobs = await listSyncJobs(db, { companyId: fx.companyId });
    assert.equal(jobs[0]!.status, 'dead');
    assert.equal(jobs[0]!.attempts, 8);

    // Dead is not deleted: the record is still owed to payroll and the Retry
    // button still works.
    await retrySyncJob(db, jobs[0]!.id);
    const revived = await listSyncJobs(db, { companyId: fx.companyId });
    assert.equal(revived[0]!.status, 'pending');
  } finally {
    await close();
  }
});

// --- 8. duplicate attendance records are prevented --------------------------

test('AC8: replaying the same event ten times creates one row', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const event = clockEvent(fx, {
      eventType: 'clock_in',
      deviceTime: '2026-08-04T06:00:00Z',
    });

    const outcomes = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await ingestEvents(db, {
        companyId: fx.companyId,
        now: NOW,
        events: [event],
      });
      outcomes.push(result.outcomes[0]!);
    }

    assert.equal(outcomes.filter((o) => o.status === 'created').length, 1);
    assert.equal(outcomes.filter((o) => o.status === 'duplicate').length, 9);

    const count = await db.query<{ count: string }>(
      'select count(*)::text as count from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    assert.equal(count.rows[0]!.count, '1');
  } finally {
    await close();
  }
});

test('AC8: a double-tapped clock-in is rejected even with a fresh key', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const first = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    assert.equal(first.outcomes[0]!.status, 'created');

    // Different idempotency key — a genuine second press, not a retry.
    const second = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:05Z' })],
    });

    const outcome = second.outcomes[0]!;
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.status === 'rejected' && outcome.code, 'already_clocked_in');

    const count = await db.query<{ count: string }>(
      'select count(*)::text as count from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    assert.equal(count.rows[0]!.count, '1');
  } finally {
    await close();
  }
});

test('AC8: enqueueing the same push twice does not create two sync jobs', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;

    const a = await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    const b = await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    assert.equal(a, b);

    const jobs = await listSyncJobs(db, { companyId: fx.companyId });
    assert.equal(jobs.length, 1);
  } finally {
    await close();
  }
});

// --- 9. audit trail and immutability ----------------------------------------

test('AC9: attendance events cannot be edited in place, even by raw SQL', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const event = await db.query<{ id: string }>(
      'select id from attendance_event where employee_id = $1',
      [fx.employeeId],
    );

    await assert.rejects(
      () =>
        db.query('update attendance_event set device_time = $2 where id = $1', [
          event.rows[0]!.id,
          '2026-08-04T05:00:00Z',
        ]),
      /is immutable/,
    );
  } finally {
    await close();
  }
});

test('AC9: attendance events cannot be deleted, only voided', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    await assert.rejects(
      () => db.query('delete from attendance_event where employee_id = $1', [fx.employeeId]),
      /cannot be deleted/,
    );
  } finally {
    await close();
  }
});

test('AC9: a void without a reason is refused by the database', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const event = await db.query<{ id: string }>(
      'select id from attendance_event where employee_id = $1',
      [fx.employeeId],
    );

    await assert.rejects(
      () =>
        db.query('update attendance_event set voided_at = now() where id = $1', [
          event.rows[0]!.id,
        ]),
      /void_reason/,
    );
  } finally {
    await close();
  }
});

test('AC9: a voided event cannot be un-voided', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const event = await db.query<{ id: string }>(
      'select id from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    await db.query(
      `update attendance_event set voided_at = now(), void_reason = 'test' where id = $1`,
      [event.rows[0]!.id],
    );

    await assert.rejects(
      () =>
        db.query('update attendance_event set voided_at = null where id = $1', [
          event.rows[0]!.id,
        ]),
      /cannot be un-voided/,
    );
  } finally {
    await close();
  }
});

test('AC9: every attendance write lands in the audit log with its actor', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      actingUserId: fx.workerUserId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const audit = await getAuditTrail(db, {
      companyId: fx.companyId,
      timesheetId: ingest.affectedTimesheetIds[0]!,
    });

    const insert = audit.find((a) => a.tableName === 'attendance_event' && a.action === 'insert');
    assert.ok(insert, 'expected an insert audit row for the attendance event');
    assert.equal(insert!.actorName, 'Dean Whitmore');
    assert.equal(insert!.before, null);
    assert.equal((insert!.after as { event_type: string }).event_type, 'clock_in');
  } finally {
    await close();
  }
});

// --- crew clocking ----------------------------------------------------------

test('crew clocking creates a separate record per employee', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await clockCrew(db, {
      companyId: fx.companyId,
      crewId: fx.crewId,
      eventType: 'clock_in',
      actorUserId: fx.supervisorUserId,
      deviceTime: '2026-08-04T06:00:00Z',
      jobId: fx.jobId,
      workActivityId: fx.activities.ERECT!,
      latitude: SITE.latitude,
      longitude: SITE.longitude,
      gpsAccuracyM: 10,
      now: NOW,
    });

    assert.equal(result.attempted, 2);
    assert.equal(result.succeeded, 2);

    const rows = await db.query<{ employee_id: string; clock_method: string }>(
      'select employee_id, clock_method from attendance_event',
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(new Set(rows.rows.map((r) => r.employee_id)).size, 2);
    assert.ok(rows.rows.every((r) => r.clock_method === 'supervisor'));

    // Two timesheets, one each.
    const sheets = await db.query<{ count: string }>(
      'select count(*)::text as count from timesheet',
    );
    assert.equal(sheets.rows[0]!.count, '2');
  } finally {
    await close();
  }
});

test('an absent worker removed before confirming is not clocked in', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await clockCrew(db, {
      companyId: fx.companyId,
      crewId: fx.crewId,
      eventType: 'clock_in',
      actorUserId: fx.supervisorUserId,
      deviceTime: '2026-08-04T06:00:00Z',
      jobId: fx.jobId,
      excludeEmployeeIds: [fx.employeeId],
      now: NOW,
    });

    assert.equal(result.attempted, 1);
    assert.equal(result.skipped, 1);

    const rows = await db.query<{ employee_id: string }>(
      'select employee_id from attendance_event',
    );
    assert.equal(rows.rows.length, 1);
    assert.notEqual(rows.rows[0]!.employee_id, fx.employeeId);
  } finally {
    await close();
  }
});

test('one crew member already clocked in does not fail the rest', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T05:45:00Z' })],
    });

    const result = await clockCrew(db, {
      companyId: fx.companyId,
      crewId: fx.crewId,
      eventType: 'clock_in',
      actorUserId: fx.supervisorUserId,
      deviceTime: '2026-08-04T06:00:00Z',
      jobId: fx.jobId,
      now: NOW,
    });

    assert.equal(result.attempted, 2);
    assert.equal(result.succeeded, 1);

    const rejected = result.outcomes.find((o) => o.outcome.status === 'rejected');
    assert.equal(rejected?.employeeName, 'Dean Whitmore');
  } finally {
    await close();
  }
});

// --- dashboards -------------------------------------------------------------

test('the Working Now view shows who is on site and where', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const rows = await getWorkingNow(db, { companyId: fx.companyId, now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.employeeName, 'Dean Whitmore');
    assert.equal(rows[0]!.crewName, 'Crew A');
    assert.equal(rows[0]!.jobNumber, '1032');
    assert.equal(rows[0]!.activityName, 'Erect');
    assert.equal(rows[0]!.locationStatus, 'inside');
    assert.equal(rows[0]!.hoursWorkedLabel, '3h 00m');
    assert.equal(rows[0]!.onBreak, false);
  } finally {
    await close();
  }
});

test('Working Now shows today\'s hours only, not yesterday\'s as well', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // Yesterday: a full eight-hour shift, finished.
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-03T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-03T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-03T14:00:00Z' }),
      ],
    });

    // Today: clocked on three hours ago and still going.
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const rows = await getWorkingNow(db, { companyId: fx.companyId, now: NOW });
    assert.equal(rows.length, 1);
    // Yesterday's 8h must not be added on, and the clock-in shown must be
    // today's — the 48h lookback exists for night shifts, not for this.
    assert.equal(rows[0]!.hoursWorkedLabel, '3h 00m');
    assert.equal(rows[0]!.clockInTime, '2026-08-04T06:00:00.000Z');

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.minutesWorked, 180);
  } finally {
    await close();
  }
});

test('a finished day still shows its hours after clock-out', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: new Date('2026-08-04T15:00:00Z'),
    });

    assert.equal(home.clockState, 'off');
    assert.equal(home.hoursWorkedLabel, '8h 00m');
  } finally {
    await close();
  }
});

test('a worker who has clocked out drops off Working Now', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });

    const rows = await getWorkingNow(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:30:00Z'),
    });
    assert.equal(rows.length, 0);
  } finally {
    await close();
  }
});

test('the timesheet list filters and reports Odoo ids', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const odoo = new MockOdooAdapter();
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:00:00Z'),
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:00:00Z' }),
      ],
    });
    const timesheetId = ingest.affectedTimesheetIds[0]!;
    await approveTimesheet(db, { timesheetId, actorUserId: fx.supervisorUserId });
    await enqueueTimesheetPush(db, { companyId: fx.companyId, timesheetId });
    await runSyncWorker(db, odoo, { companyId: fx.companyId });

    const all = await listTimesheets(db, { companyId: fx.companyId });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.paidHoursLabel, '8h 00m');
    assert.deepEqual(all[0]!.jobNumbers, ['1032']);
    assert.equal(all[0]!.status, 'synced');
    assert.equal(all[0]!.odooIds.length, 1);

    const byJob = await listTimesheets(db, { companyId: fx.companyId, jobId: fx.jobId });
    assert.equal(byJob.length, 1);

    const byStatus = await listTimesheets(db, { companyId: fx.companyId, status: 'draft' });
    assert.equal(byStatus.length, 0);

    const byCrew = await listTimesheets(db, { companyId: fx.companyId, crewId: fx.crewId });
    assert.equal(byCrew.length, 1);
  } finally {
    await close();
  }
});

// --- job and activity switching ---------------------------------------------

test('the brief\'s worked example survives a round trip through the database', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // Second job to move to at 9:30.
    const site2 = await db.query<{ id: string }>(
      `insert into site (company_id, name, latitude, longitude, geofence_radius_m)
       values ($1, 'Warrawong yard', -34.4880, 150.8930, 250) returning id`,
      [fx.companyId],
    );
    const job2 = await db.query<{ id: string }>(
      `insert into job (company_id, odoo_model, odoo_id, job_number, site_id, status)
       values ($1, 'project.project', 3312, '1041', $2, 'active') returning id`,
      [fx.companyId, site2.rows[0]!.id],
    );

    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-04T14:30:00+10:00'),
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:30:00+10:00',
          workActivityId: fx.activities.ERECT!,
        }),
        clockEvent(fx, {
          eventType: 'job_change',
          deviceTime: '2026-08-04T09:00:00+10:00',
          jobId: null,
          workActivityId: fx.activities.TRAVEL!,
        }),
        clockEvent(fx, {
          eventType: 'job_change',
          deviceTime: '2026-08-04T09:30:00+10:00',
          jobId: job2.rows[0]!.id,
          workActivityId: fx.activities.MODIFY!,
        }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T14:30:00+10:00' }),
      ],
    });

    const segments = await db.query<{
      segment_type: string;
      minutes: number;
      job_number: string | null;
      activity: string | null;
    }>(
      `select ts.segment_type, ts.minutes, j.job_number, wa.name as activity
         from time_segment ts
         left join job j on j.id = ts.job_id
         left join work_activity wa on wa.id = ts.work_activity_id
        where ts.timesheet_id = $1 order by ts.start_time`,
      [ingest.affectedTimesheetIds[0]],
    );

    assert.equal(segments.rows.length, 3);
    assert.deepEqual(
      segments.rows.map((r) => [r.segment_type, r.minutes, r.job_number, r.activity]),
      [
        ['work', 150, '1032', 'Erect'],
        ['travel', 30, null, 'Travel'],
        ['work', 300, '1041', 'Modify'],
      ],
    );
  } finally {
    await close();
  }
});

test('a night shift crossing midnight stays on one timesheet', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const ingest = await ingestEvents(db, {
      companyId: fx.companyId,
      now: new Date('2026-08-05T04:00:00Z'),
      events: [
        // 20:00 AEST on the 4th through 04:00 on the 5th.
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T20:00:00+10:00' }),
        clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-05T04:00:00+10:00' }),
      ],
    });

    assert.equal(ingest.affectedTimesheetIds.length, 1);

    const sheets = await db.query<{ work_date: Date; total_paid_minutes: number }>(
      'select work_date, total_paid_minutes from timesheet where employee_id = $1',
      [fx.employeeId],
    );
    assert.equal(sheets.rows.length, 1);
    assert.equal(sheets.rows[0]!.work_date.toISOString().slice(0, 10), '2026-08-04');
    assert.equal(sheets.rows[0]!.total_paid_minutes, 480);
  } finally {
    await close();
  }
});
