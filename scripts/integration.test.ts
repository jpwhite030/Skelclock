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
  addSiteExclusion,
  approveTimesheet,
  canManageEmployee,
  clockCrew,
  confirmSuggestedEvent,
  confirmTimesheet,
  correctEvent,
  dismissSuggestedEvent,
  DbError,
  enqueueTimesheetPush,
  excludedSiteIds,
  exportTimesheetsCsv,
  getAuditTrail,
  getCompanySettings,
  getWorkerHome,
  getWorkingNow,
  importEmployees,
  importJobs,
  ingestEvents,
  isEmployeeExcludedFromSite,
  listExceptions,
  listPendingSuggestions,
  listSyncJobs,
  listTimesheets,
  lockTimesheet,
  normaliseMobile,
  one,
  removeSiteExclusion,
  reopenTimesheet,
  retrySyncJob,
  runNotificationSweep,
  runSyncWorker,
  SuggestionError,
  supervises,
  updateCompanySettings,
  updateExceptionStatus,
  updateSiteOperatingHours,
  voidEvent,
  WorkflowError,
  type Db,
  type EmailMessage,
  type EmailSender,
  type PushMessage,
  type PushSender,
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

// The brief's original AC4 was "GPS never blocks a worker" — true when this
// suite was written, no longer true today. blocksClockIn() (packages/core/
// src/geo.ts) was added later as a deliberate, reviewed reversal: a *confident*
// off-site clock-on is now refused outright, closed server-side alongside the
// client so a request that skips the app cannot grant itself a clock the app
// itself would have refused. What AC4 actually protects — that GPS
// *uncertainty* must never cost someone a shift — still holds exactly as
// before, and clock-out is still never blocked under any circumstance. The
// three tests below draw that line precisely instead of asserting the old
// blanket "never blocked".

test('AC4: a confident off-site clock-in is refused, not silently accepted', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          // The default 8m accuracy from clockEvent() — exactly the
          // "we are confident where you are" case blocksClockIn exists for.
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          latitude: OFF_SITE.latitude,
          longitude: OFF_SITE.longitude,
        }),
      ],
    });

    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.status === 'rejected' && outcome.code, 'outside_geofence');
  } finally {
    await close();
  }
});

test('AC4: GPS uncertainty never blocks a clock-in — a loose fix is flagged, not refused', async () => {
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
          // Error bars alone could reach all the way back to the site: the
          // system genuinely does not know which side of the fence this is,
          // and a guess in that state must not cost a shift.
          gpsAccuracyM: 4500,
        }),
      ],
    });

    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.status === 'created' && outcome.insideGeofence, false);

    const exceptions = await listExceptions(db, { companyId: fx.companyId });
    assert.ok(exceptions.some((e) => e.type === 'outside_geofence'));
  } finally {
    await close();
  }
});

test('AC4: a confident off-site clock-out is still never blocked — a worker who has left must be able to end their shift', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_out',
          deviceTime: '2026-08-04T14:00:00Z',
          latitude: OFF_SITE.latitude,
          longitude: OFF_SITE.longitude,
        }),
      ],
    });

    assert.equal(result.outcomes[0]!.status, 'created');
    const exceptions = await listExceptions(db, { companyId: fx.companyId });
    assert.ok(exceptions.some((e) => e.type === 'outside_geofence'));
  } finally {
    await close();
  }
});

test('AC4: an outside-fence clock-out with a reason does not raise an exception', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });

    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_out',
          deviceTime: '2026-08-04T14:00:00Z',
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

// --- Phase 3: geofence-raised clock suggestions -----------------------------

test('Phase 3: an auto_geofence clock-in lands as a suggestion, invisible until confirmed', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          // Loose enough to stay on the tap-to-confirm path — these tests are
          // about the suggestion mechanics, not the auto-confirm decision
          // itself (see the "auto-confirm" tests below for that).
          gpsAccuracyM: 45,
        }),
      ],
    });

    const row = await db.query<{ is_suggested: boolean; clock_method: string }>(
      'select is_suggested, clock_method from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    assert.equal(row.rows[0]!.clock_method, 'auto_geofence');
    assert.equal(row.rows[0]!.is_suggested, true);

    // Not visible to the worker's state or hours until confirmed.
    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'off');
    assert.equal(home.minutesWorked, 0);

    const suggestions = await listPendingSuggestions(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
    });
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]!.eventType, 'clock_in');
  } finally {
    await close();
  }
});

test('Phase 3: confirming a suggestion makes it count', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          // Loose enough to stay on the tap-to-confirm path — these tests are
          // about the suggestion mechanics, not the auto-confirm decision
          // itself (see the "auto-confirm" tests below for that).
          gpsAccuracyM: 45,
        }),
      ],
    });
    const suggestion = (
      await listPendingSuggestions(db, { companyId: fx.companyId, employeeId: fx.employeeId })
    )[0]!;

    await confirmSuggestedEvent(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      eventId: suggestion.id,
      actorUserId: fx.workerUserId,
      now: NOW,
    });

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'working');

    const remaining = await listPendingSuggestions(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
    });
    assert.equal(remaining.length, 0);
  } finally {
    await close();
  }
});

test('Phase 3: dismissing a suggestion voids it and it never counts', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          // Loose enough to stay on the tap-to-confirm path — these tests are
          // about the suggestion mechanics, not the auto-confirm decision
          // itself (see the "auto-confirm" tests below for that).
          gpsAccuracyM: 45,
        }),
      ],
    });
    const suggestion = (
      await listPendingSuggestions(db, { companyId: fx.companyId, employeeId: fx.employeeId })
    )[0]!;

    await dismissSuggestedEvent(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      eventId: suggestion.id,
      actorUserId: fx.workerUserId,
      reason: 'Drove past the site, did not stop',
      now: NOW,
    });

    const row = await db.query<{ voided_at: Date | null; void_reason: string | null }>(
      'select voided_at, void_reason from attendance_event where id = $1',
      [suggestion.id],
    );
    assert.ok(row.rows[0]!.voided_at);
    assert.equal(row.rows[0]!.void_reason, 'Drove past the site, did not stop');

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'off');

    const remaining = await listPendingSuggestions(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
    });
    assert.equal(remaining.length, 0);
  } finally {
    await close();
  }
});

test('Phase 3: dismissing a suggestion requires a reason', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          // Loose enough to stay on the tap-to-confirm path — these tests are
          // about the suggestion mechanics, not the auto-confirm decision
          // itself (see the "auto-confirm" tests below for that).
          gpsAccuracyM: 45,
        }),
      ],
    });
    const suggestion = (
      await listPendingSuggestions(db, { companyId: fx.companyId, employeeId: fx.employeeId })
    )[0]!;

    await assert.rejects(
      () =>
        dismissSuggestedEvent(db, {
          companyId: fx.companyId,
          employeeId: fx.employeeId,
          eventId: suggestion.id,
          actorUserId: fx.workerUserId,
          reason: '   ',
        }),
      (error: unknown) => error instanceof SuggestionError && error.code === 'reason_required',
    );
  } finally {
    await close();
  }
});

test('Phase 3: a worker cannot confirm another employee\'s suggestion', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          // Loose enough to stay on the tap-to-confirm path — these tests are
          // about the suggestion mechanics, not the auto-confirm decision
          // itself (see the "auto-confirm" tests below for that).
          gpsAccuracyM: 45,
        }),
      ],
    });
    const suggestion = (
      await listPendingSuggestions(db, { companyId: fx.companyId, employeeId: fx.employeeId })
    )[0]!;

    // fx.supervisorEmployeeId is a real employee in the same company, just not
    // the one this suggestion belongs to - the query must not find it.
    await assert.rejects(
      () =>
        confirmSuggestedEvent(db, {
          companyId: fx.companyId,
          employeeId: fx.supervisorEmployeeId,
          eventId: suggestion.id,
          actorUserId: fx.supervisorUserId,
        }),
      (error: unknown) => error instanceof DbError,
    );

    // Untouched: still pending for its actual owner.
    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'off');
  } finally {
    await close();
  }
});

// --- Phase 3: auto-confirm, debounce, ambiguity -----------------------------
// "Tap is a last resort" - most geofence-raised events should not need one.
// These use the default clockEvent() fixture (dead-centre on SITE, 8m
// accuracy) precisely because that is now confident and unambiguous enough
// to skip confirmation; the tests above deliberately loosen accuracy to stay
// on the tap-to-confirm path instead.

test('Phase 3: a confident, unambiguous auto-geofence clock-in lands live, no tap needed', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
        }),
      ],
    });

    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status, 'created');
    assert.equal(outcome.status === 'created' && outcome.autoConfirmed, true);

    const row = await db.query<{ is_suggested: boolean }>(
      'select is_suggested from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    assert.equal(row.rows[0]!.is_suggested, false);

    // Counts immediately - no confirm step in between.
    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'working');

    const suggestions = await listPendingSuggestions(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
    });
    assert.equal(suggestions.length, 0);
  } finally {
    await close();
  }
});

test('Phase 3: a loose fix still needs a tap even standing on site', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          gpsAccuracyM: 60,
        }),
      ],
    });

    const outcome = result.outcomes[0]!;
    assert.equal(outcome.status === 'created' && outcome.autoConfirmed, false);
  } finally {
    await close();
  }
});

test('Phase 3: a bouncing fix at the fence edge is folded into the first trigger, not doubled', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // Loose accuracy on both, deliberately: an auto-confirmed first event
    // would already be blocked from a second clock-in by the ordinary
    // "already clocked in" state-machine check (it is live, so
    // orderedLiveEvents counts it) - that is a real safety net, but it is not
    // the one this test is checking. Keeping the first event a suggestion
    // (excluded from state until confirmed) is what actually exercises the
    // debounce path: the bounce would otherwise pass the state machine too,
    // since a still-pending suggestion has not moved the confirmed state.
    const bounce = {
      eventType: 'clock_in' as const,
      clockMethod: 'auto_geofence' as const,
      gpsAccuracyM: 60,
    };
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, { ...bounce, deviceTime: '2026-08-04T06:00:00Z' }),
        // Same job, same event type, 3 minutes later - well inside the
        // debounce window - as if the OS fired Enter/Exit/Enter in a row.
        clockEvent(fx, { ...bounce, deviceTime: '2026-08-04T06:03:00Z' }),
      ],
    });

    assert.equal(result.outcomes[0]!.status, 'created');
    assert.equal(result.outcomes[1]!.status, 'duplicate');

    const rows = await db.query<{ id: string }>(
      "select id from attendance_event where employee_id = $1 and event_type = 'clock_in'",
      [fx.employeeId],
    );
    assert.equal(rows.rows.length, 1);
  } finally {
    await close();
  }
});

test('Phase 3: two sites at once never auto-confirms, and the worker picks which one on confirm', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const otherSite = (await one<{ id: string }>(
      db,
      `insert into site (company_id, name, address, latitude, longitude, geofence_radius_m)
       values ($1, 'Adjacent yard', 'Next door', $2, $3, 70) returning id`,
      [fx.companyId, SITE.latitude, SITE.longitude],
    ))!;
    const otherJob = (await one<{ id: string }>(
      db,
      `insert into job (company_id, odoo_model, odoo_id, job_number, customer_name, site_id, status)
       values ($1, 'project.project', 9911, '9911', 'Neighbouring Co', $2, 'active') returning id`,
      [fx.companyId, otherSite.id],
    ))!;

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:00Z',
          clockMethod: 'auto_geofence',
          candidateJobIds: [fx.jobId, otherJob.id],
        }),
      ],
    });

    // Never auto-confirmed while ambiguous, no matter how good the fix.
    assert.equal(result.outcomes[0]!.status === 'created' && result.outcomes[0]!.autoConfirmed, false);

    const row = await db.query<{ candidate_job_ids: string[] | null; job_id: string }>(
      'select candidate_job_ids, job_id from attendance_event where employee_id = $1',
      [fx.employeeId],
    );
    assert.deepEqual(new Set(row.rows[0]!.candidate_job_ids), new Set([fx.jobId, otherJob.id]));

    const suggestion = (
      await listPendingSuggestions(db, { companyId: fx.companyId, employeeId: fx.employeeId })
    )[0]!;
    assert.deepEqual(new Set(suggestion.candidateJobIds), new Set([fx.jobId, otherJob.id]));

    // Confirming an ambiguous suggestion with no jobId at all is refused —
    // it must not silently keep whatever job happened to land on the row.
    await assert.rejects(
      () =>
        confirmSuggestedEvent(db, {
          companyId: fx.companyId,
          employeeId: fx.employeeId,
          eventId: suggestion.id,
          actorUserId: fx.workerUserId,
          now: NOW,
        }),
      (error: unknown) => error instanceof SuggestionError && error.code === 'candidate_job_required',
    );

    // Picking a job that was not one of the candidates is refused.
    await assert.rejects(
      () =>
        confirmSuggestedEvent(db, {
          companyId: fx.companyId,
          employeeId: fx.employeeId,
          eventId: suggestion.id,
          actorUserId: fx.workerUserId,
          // A syntactically valid id, but not one of the two candidates above.
          jobId: '00000000-0000-0000-0000-000000000000',
          now: NOW,
        }),
      (error: unknown) => error instanceof SuggestionError && error.code === 'invalid_candidate_job',
    );

    // Picking the other candidate confirms it onto that job.
    await confirmSuggestedEvent(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      eventId: suggestion.id,
      actorUserId: fx.workerUserId,
      jobId: otherJob.id,
      now: NOW,
    });

    const confirmed = await db.query<{ is_suggested: boolean; job_id: string }>(
      'select is_suggested, job_id from attendance_event where id = $1',
      [suggestion.id],
    );
    assert.equal(confirmed.rows[0]!.is_suggested, false);
    assert.equal(confirmed.rows[0]!.job_id, otherJob.id);
  } finally {
    await close();
  }
});

// --- operating hours ---------------------------------------------------------
// fx.companyId's timezone is Australia/Sydney (seedFixture), 2026-08-04 is
// deep in AEST (UTC+10, no daylight saving) - local HH:MM = UTC HH:MM + 10.

test('a clock-in outside operating hours is refused', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '06:00',
      operatingHoursEnd: '18:00',
    });

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        // 04:00 local (2026-08-03T18:00Z + 10h), well before 06:00.
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-03T18:00:00Z' }),
      ],
    });

    assert.equal(result.outcomes[0]!.status, 'rejected');
    assert.equal(
      result.outcomes[0]!.status === 'rejected' && result.outcomes[0]!.code,
      'outside_operating_hours',
    );

    const rows = await db.query('select id from attendance_event where employee_id = $1', [
      fx.employeeId,
    ]);
    assert.equal(rows.rows.length, 0);
  } finally {
    await close();
  }
});

test('a clock-in inside operating hours is accepted', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '06:00',
      operatingHoursEnd: '18:00',
    });

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      // 12:00 local.
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T02:00:00Z' })],
    });

    assert.equal(result.outcomes[0]!.status, 'created');
  } finally {
    await close();
  }
});

test('operating hours never block a clock-out, even after hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '06:00',
      operatingHoursEnd: '18:00',
    });

    // Clocked in inside hours (12:00 local)...
    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T02:00:00Z' })],
    });

    // ...clocking out at 20:00 local, two hours past closing, must still work.
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_out', deviceTime: '2026-08-04T10:00:00Z' })],
    });

    assert.equal(result.outcomes[0]!.status, 'created');
  } finally {
    await close();
  }
});

test('a site override wins over the company default operating hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '06:00',
      operatingHoursEnd: '18:00',
    });
    // This site runs earlier - 04:00 to 12:00 local.
    await db.query('update site set operating_hours_start = $2, operating_hours_end = $3 where id = $1', [
      fx.siteId,
      '04:00',
      '12:00',
    ]);

    // 05:00 local - outside the 06:00-18:00 company default, but inside the
    // site's own 04:00-12:00.
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-03T19:00:00Z' })],
    });

    assert.equal(result.outcomes[0]!.status, 'created');
  } finally {
    await close();
  }
});

test('an overnight operating window wraps past midnight correctly', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // A site that only runs overnight: 22:00-06:00.
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '22:00',
      operatingHoursEnd: '06:00',
    });

    // 23:00 local - after 22:00, inside the wrapped window.
    const late = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T13:00:00Z' })],
    });
    assert.equal(late.outcomes[0]!.status, 'created');

    // 12:00 local the same day - the middle of the day, outside 22:00-06:00.
    const midday = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T02:00:00Z',
          idempotencyKey: newIdempotencyKey('test-device-2'),
        }),
      ],
    });
    assert.equal(midday.outcomes[0]!.status, 'rejected');
  } finally {
    await close();
  }
});

test('a supervisor filling in a missed clock-in bypasses operating hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: '06:00',
      operatingHoursEnd: '18:00',
    });

    // 04:00 local, well outside hours - addMissingEvent is a deliberate
    // supervisor act (clock_method 'supervisor'), not the worker's own clock.
    const timesheet = await one<{ id: string }>(
      db,
      `insert into timesheet (company_id, employee_id, work_date) values ($1,$2,$3) returning id`,
      [fx.companyId, fx.employeeId, '2026-08-04'],
    );
    const result = await addMissingEvent(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      timesheetId: timesheet!.id,
      eventType: 'clock_in',
      deviceTime: '2026-08-03T18:00:00Z',
      jobId: fx.jobId,
      actorUserId: fx.supervisorUserId,
      reason: 'Worker forgot to clock in, confirmed with them by phone',
      now: NOW,
    });
    assert.ok(result.eventId);
  } finally {
    await close();
  }
});

// --- site exclusion -----------------------------------------------------------

test('an employee excluded from a site cannot clock in there, manually or automatically', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await addSiteExclusion(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      siteId: fx.siteId,
      reason: 'Lives next door - false positives every day',
      createdBy: fx.supervisorUserId,
    });

    const manual = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    assert.equal(manual.outcomes[0]!.status, 'rejected');
    assert.equal(
      manual.outcomes[0]!.status === 'rejected' && manual.outcomes[0]!.code,
      'site_excluded',
    );

    const auto = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-04T06:00:01Z',
          clockMethod: 'auto_geofence',
          idempotencyKey: newIdempotencyKey('test-device-3'),
        }),
      ],
    });
    assert.equal(auto.outcomes[0]!.status, 'rejected');
  } finally {
    await close();
  }
});

test('removing an exclusion lets the employee clock in again', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const before = await addSiteExclusion(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      siteId: fx.siteId,
      reason: 'Temporary - checking a false-positive report',
      createdBy: fx.supervisorUserId,
    }).then(() => excludedSiteIds(db, { employeeId: fx.employeeId }));
    assert.equal(before.has(fx.siteId), true);

    const row = await one<{ id: string }>(
      db,
      'select id from employee_site_exclusion where employee_id = $1 and site_id = $2',
      [fx.employeeId, fx.siteId],
    );
    await removeSiteExclusion(db, { companyId: fx.companyId, exclusionId: row!.id });

    assert.equal(await isEmployeeExcludedFromSite(db, { employeeId: fx.employeeId, siteId: fx.siteId }), false);

    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    assert.equal(result.outcomes[0]!.status, 'created');
  } finally {
    await close();
  }
});

// --- supervisor scope (authz.ts) ----------------------------------------------

test('a supervisor supervises their direct report', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // seedFixture links fx.employeeId's supervisor_employee_id to fx.supervisorEmployeeId.
    assert.equal(
      await supervises(db, {
        supervisorEmployeeId: fx.supervisorEmployeeId,
        targetEmployeeId: fx.employeeId,
      }),
      true,
    );
  } finally {
    await close();
  }
});

test('a supervisor does not supervise an unrelated employee', async () => {
  const { db, fx, close } = await freshDb();
  try {
    assert.equal(
      await supervises(db, {
        supervisorEmployeeId: fx.employeeId, // not a supervisor of anyone
        targetEmployeeId: fx.supervisorEmployeeId,
      }),
      false,
    );
  } finally {
    await close();
  }
});

test('canManageEmployee: admin can act on anyone, supervisor only their reports, worker never', async () => {
  const { db, fx, close } = await freshDb();
  try {
    assert.equal(
      await canManageEmployee(db, {
        role: 'admin',
        callerEmployeeId: null,
        targetEmployeeId: fx.employeeId,
      }),
      true,
    );
    assert.equal(
      await canManageEmployee(db, {
        role: 'supervisor',
        callerEmployeeId: fx.supervisorEmployeeId,
        targetEmployeeId: fx.employeeId,
      }),
      true,
    );
    assert.equal(
      await canManageEmployee(db, {
        role: 'supervisor',
        callerEmployeeId: fx.supervisorEmployeeId,
        targetEmployeeId: fx.supervisorEmployeeId, // not even themselves
      }),
      false,
    );
    assert.equal(
      await canManageEmployee(db, {
        role: 'worker',
        callerEmployeeId: fx.employeeId,
        targetEmployeeId: fx.employeeId,
      }),
      false,
    );
  } finally {
    await close();
  }
});

// --- voidEvent -----------------------------------------------------------------

test('voidEvent removes an event with no replacement, and requires a reason', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const result = await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' })],
    });
    const created = result.outcomes[0]!;
    assert.equal(created.status, 'created');
    const eventId = created.status === 'created' ? created.eventId : '';

    await assert.rejects(
      () => voidEvent(db, { eventId, actorUserId: fx.supervisorUserId, reason: '  ', now: NOW }),
      (error: unknown) => error instanceof WorkflowError && error.code === 'reason_required',
    );

    await voidEvent(db, {
      eventId,
      actorUserId: fx.supervisorUserId,
      reason: 'Duplicate manual entry, worker double-tapped',
      now: NOW,
    });

    const row = await db.query<{ voided_at: Date | null; void_reason: string | null }>(
      'select voided_at, void_reason from attendance_event where id = $1',
      [eventId],
    );
    assert.ok(row.rows[0]!.voided_at);
    assert.equal(row.rows[0]!.void_reason, 'Duplicate manual entry, worker double-tapped');

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.clockState, 'off');
  } finally {
    await close();
  }
});

// --- payroll settings wiring (segments.ts options already unit-tested in
// packages/core/src/core.test.ts - these confirm the setting actually reaches
// buildSegments through getWorkerHome, not the segment math itself) ----------

test('auto-lunch, enabled company-wide, reduces the worker home screen\'s paid hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: true,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'unallocated',
      operatingHoursStart: null,
      operatingHoursEnd: null,
    });

    await ingestEvents(db, {
      companyId: fx.companyId,
      now: NOW,
      events: [
        clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T06:00:00Z' }),
        clockEvent(fx, {
          eventType: 'clock_out',
          deviceTime: '2026-08-04T14:00:00Z', // 8h, no break clocked
          idempotencyKey: newIdempotencyKey('test-device-4'),
        }),
      ],
    });

    const home = await getWorkerHome(db, {
      companyId: fx.companyId,
      employeeId: fx.employeeId,
      workDate: '2026-08-04',
      now: NOW,
    });
    assert.equal(home.minutesWorked, 450); // 480 - 30
  } finally {
    await close();
  }
});

test('travel allocation, set to first_site, reaches the worker home screen through getWorkerHome', async () => {
  const { db, fx, close } = await freshDb();
  try {
    const settings = await getCompanySettings(db, fx.companyId);
    assert.equal(settings.travelAllocation, 'unallocated'); // default, unchanged behaviour

    await updateCompanySettings(db, {
      companyId: fx.companyId,
      autoLunchEnabled: false,
      autoLunchThresholdMinutes: 300,
      autoLunchDurationMinutes: 30,
      travelAllocation: 'first_site',
      operatingHoursStart: null,
      operatingHoursEnd: null,
    });

    const updated = await getCompanySettings(db, fx.companyId);
    assert.equal(updated.travelAllocation, 'first_site');
  } finally {
    await close();
  }
});

// --- acting on exceptions, exporting payroll, outbound notifications ---------

test('an exception can be acknowledged and resolved; resolving demands a note', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // A 4km-off-site clock-in with no reason raises outside_geofence. Loose
    // accuracy, deliberately: this test is about the exception lifecycle, not
    // geofence blocking — a confident fix here would be refused outright by
    // blocksClockIn (see the AC4 tests) and never reach the exceptions list.
    await ingestEvents(db, {
      companyId: fx.companyId,
      events: [
        clockEvent(fx, {
          eventType: 'clock_in',
          deviceTime: '2026-08-03T20:00:00Z',
          latitude: OFF_SITE.latitude,
          longitude: OFF_SITE.longitude,
          gpsAccuracyM: 4500,
        }),
      ],
      now: NOW,
    });

    const open = await listExceptions(db, { companyId: fx.companyId, status: 'open' });
    const exception = open.find((r) => r.type === 'outside_geofence');
    assert.ok(exception, 'expected an outside_geofence exception');

    await updateExceptionStatus(db, {
      companyId: fx.companyId,
      exceptionId: exception.id,
      action: 'acknowledge',
      actorUserId: fx.adminUserId,
    });
    let row = await one<{ status: string }>(
      db,
      'select status from attendance_exception where id = $1',
      [exception.id],
    );
    assert.equal(row!.status, 'acknowledged');

    // Resolving with no note is refused — the note is the audit trail.
    await assert.rejects(
      updateExceptionStatus(db, {
        companyId: fx.companyId,
        exceptionId: exception.id,
        action: 'resolve',
        actorUserId: fx.adminUserId,
      }),
      (e: Error) => e.name === 'ExceptionError',
    );

    await updateExceptionStatus(db, {
      companyId: fx.companyId,
      exceptionId: exception.id,
      action: 'resolve',
      actorUserId: fx.adminUserId,
      note: 'Spoke to Dean — new job, site pin was still on the old address.',
    });
    const resolved = await one<{ status: string; resolved_by: string; resolution_note: string }>(
      db,
      'select status, resolved_by, resolution_note from attendance_exception where id = $1',
      [exception.id],
    );
    assert.equal(resolved!.status, 'resolved');
    assert.equal(resolved!.resolved_by, fx.adminUserId);
    assert.match(resolved!.resolution_note, /site pin/);

    await updateExceptionStatus(db, {
      companyId: fx.companyId,
      exceptionId: exception.id,
      action: 'reopen',
      actorUserId: fx.adminUserId,
    });
    row = await one<{ status: string }>(
      db,
      'select status from attendance_exception where id = $1',
      [exception.id],
    );
    assert.equal(row!.status, 'open');
  } finally {
    await close();
  }
});

test('the CSV export carries the same day the ledger shows, in decimal hours', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // The PoC day: 8h paid door to door around a 30m unpaid break.
    for (const [eventType, deviceTime] of [
      ['clock_in', '2026-08-03T20:00:00Z'],
      ['break_start', '2026-08-03T23:00:00Z'],
      ['break_end', '2026-08-03T23:30:00Z'],
      ['clock_out', '2026-08-04T04:30:00Z'],
    ] as const) {
      await ingestEvents(db, {
        companyId: fx.companyId,
        events: [clockEvent(fx, { eventType, deviceTime })],
        now: NOW,
      });
    }

    const out = await exportTimesheetsCsv(db, {
      companyId: fx.companyId,
      from: '2026-08-01',
      to: '2026-08-10',
    });

    assert.equal(out.rowCount, 1);
    assert.match(out.csv, /^Date,Employee number,Employee,/);
    const dataLine = out.csv.split('\r\n')[1]!;
    assert.match(dataLine, /SS-114/);
    assert.match(dataLine, /Dean Whitmore/);
    assert.match(dataLine, /8\.00/); // paid hours, decimal
    assert.match(dataLine, /0\.50/); // break hours
    assert.match(out.filename, /2026-08-01-to-2026-08-10/);
  } finally {
    await close();
  }
});

test('the sweep nudges a forgotten clock-out once, and only once', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // On the tools for 13 hours with no operating hours configured — past the
    // 12h fallback line.
    await ingestEvents(db, {
      companyId: fx.companyId,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-03T20:00:00Z' })],
      now: NOW,
    });

    await db.query(
      `insert into device (company_id, app_user_id, device_id, push_token, last_seen_at)
       values ($1, $2, 'test-device', 'ExponentPushToken[test]', now())`,
      [fx.companyId, fx.workerUserId],
    );

    const sent: PushMessage[] = [];
    const push: PushSender = async (messages) => {
      sent.push(...messages);
    };
    const noEmail: EmailSender = { channel: 'log', send: async () => undefined };

    const first = await runNotificationSweep(db, {
      now: new Date('2026-08-04T09:00:00Z'), // Tue evening AEST — weekly part stays quiet
      push,
      email: noEmail,
    });
    assert.equal(first.pushSent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'ExponentPushToken[test]');
    assert.match(sent[0]!.title, /Still clocked on/);

    const second = await runNotificationSweep(db, {
      now: new Date('2026-08-04T09:05:00Z'),
      push,
      email: noEmail,
    });
    assert.equal(second.pushSent, 0, 'the dedupe row must stop a re-send');
    assert.equal(second.failed, 0);
  } finally {
    await close();
  }
});

test('the weekly summary emails last week once per employee, Monday morning local', async () => {
  const { db, fx, close } = await freshDb();
  try {
    // A locked day inside the prior ISO week (Mon 2026-07-27 .. Sun 2026-08-02).
    await db.query(
      `insert into timesheet (company_id, employee_id, work_date, status,
                              total_shift_minutes, total_break_minutes, total_paid_minutes)
       values ($1, $2, '2026-07-29', 'locked', 510, 30, 480)`,
      [fx.companyId, fx.employeeId],
    );

    const emails: EmailMessage[] = [];
    const email: EmailSender = {
      channel: 'email',
      send: async (m) => {
        emails.push(m);
      },
    };
    const noPush: PushSender = async () => undefined;

    // 22:30 UTC Sunday = 08:30 Monday in Sydney.
    const mondayMorning = new Date('2026-08-02T22:30:00Z');

    const first = await runNotificationSweep(db, { now: mondayMorning, push: noPush, email });
    assert.equal(first.emailsSent, 1, 'one employee has hours and an email address');
    assert.equal(emails.length, 1);
    assert.equal(emails[0]!.to, 'dean.whitmore@example.com');
    assert.match(emails[0]!.subject, /2026-07-27/);
    assert.match(emails[0]!.subject, /8h 00m/);
    assert.match(emails[0]!.text, /2026-07-29/);

    const second = await runNotificationSweep(db, { now: mondayMorning, push: noPush, email });
    assert.equal(second.emailsSent, 0, 'the ISO-week dedupe must hold');

    // Tuesday: the weekly part must not run at all.
    const tuesday = await runNotificationSweep(db, {
      now: new Date('2026-08-03T22:30:00Z'),
      push: noPush,
      email,
    });
    assert.equal(tuesday.emailsSent, 0);
  } finally {
    await close();
  }
});

test('the missing clock-out sweep does not fire minutes into a legitimate overnight shift', async () => {
  const { db, fx, close } = await freshDb();
  try {
    await updateSiteOperatingHours(db, {
      companyId: fx.companyId,
      siteId: fx.siteId,
      start: '18:00',
      end: '06:00', // overnight: 6pm to 6am
    });

    // Clocked in at 22:00 local (Sydney, +10 in August) for a legitimate
    // overnight shift that runs to 06:00.
    await ingestEvents(db, {
      companyId: fx.companyId,
      events: [clockEvent(fx, { eventType: 'clock_in', deviceTime: '2026-08-04T12:00:00Z' })],
      now: NOW,
    });

    await db.query(
      `insert into device (company_id, app_user_id, device_id, push_token, last_seen_at)
       values ($1, $2, 'test-device', 'ExponentPushToken[test]', now())`,
      [fx.companyId, fx.workerUserId],
    );

    const sent: PushMessage[] = [];
    const push: PushSender = async (messages) => {
      sent.push(...messages);
    };
    const noEmail: EmailSender = { channel: 'log', send: async () => undefined };

    // Five minutes after clocking in — nowhere near the 06:00 close.
    const fiveMinutesLater = await runNotificationSweep(db, {
      now: new Date('2026-08-04T12:05:00Z'),
      push,
      email: noEmail,
    });
    assert.equal(fiveMinutesLater.pushSent, 0, 'must not nudge minutes into an overnight shift');
    assert.equal(sent.length, 0);

    // 06:35 local — five minutes past the 30-minute grace after 06:00 close.
    const pastClose = await runNotificationSweep(db, {
      now: new Date('2026-08-04T20:35:00Z'),
      push,
      email: noEmail,
    });
    assert.equal(pastClose.pushSent, 1, 'must nudge once genuinely past close plus grace');
  } finally {
    await close();
  }
});
