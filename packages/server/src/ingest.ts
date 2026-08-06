/**
 * Clock event ingest — the one write path for attendance.
 *
 * Everything lands here: the worker's own taps, a supervisor's crew clock, the
 * offline queue flushing three hours late, and Phase 3's geofence suggestions.
 * Having a single door is what makes the idempotency and audit guarantees
 * possible to reason about.
 *
 * Ordering note: a batch from an offline phone is processed in *device time*
 * order regardless of the order it arrived in, because the state machine only
 * makes sense against the sequence the worker actually performed.
 */

import {
  applyTransition,
  deriveState,
  evaluateGeofence,
  isValidIdempotencyKey,
  type ClockEventInput,
  type StoredAttendanceEvent,
} from '@skelclock/core';

import { one, withTransaction, type Db } from './db.js';
import { rebuildTimesheet } from './timesheet.js';

export interface IngestOptions {
  companyId: string;
  events: readonly ClockEventInput[];
  /** The app_user making the request; null for service-to-service calls. */
  actingUserId?: string | null;
  defaultGeofenceRadiusM?: number;
  /** Overridable for tests. */
  now?: Date;
}

export type IngestOutcome =
  | { status: 'created'; idempotencyKey: string; eventId: string; timesheetId: string; insideGeofence: boolean | null; distanceM: number | null }
  | { status: 'duplicate'; idempotencyKey: string; eventId: string }
  | { status: 'rejected'; idempotencyKey: string; code: string; message: string };

export interface IngestResult {
  outcomes: IngestOutcome[];
  /** Timesheets touched, so the caller can requeue Odoo sync for them. */
  affectedTimesheetIds: string[];
}

interface EmployeeRow {
  id: string;
  company_id: string;
  active: boolean;
  full_name: string;
}

interface JobSiteRow {
  job_id: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number | null;
}

export async function ingestEvents(db: Db, options: IngestOptions): Promise<IngestResult> {
  const {
    companyId,
    actingUserId = null,
    defaultGeofenceRadiusM = 200,
    now = new Date(),
  } = options;

  // Device-time order, so a queue that flushed backwards still replays the
  // worker's real sequence through the state machine.
  const ordered = [...options.events].sort(
    (a, b) => Date.parse(a.deviceTime) - Date.parse(b.deviceTime),
  );

  const outcomes: IngestOutcome[] = [];
  const affected = new Set<string>();

  for (const event of ordered) {
    const outcome = await ingestOne(db, {
      companyId,
      actingUserId,
      defaultGeofenceRadiusM,
      now,
      event,
    });
    outcomes.push(outcome);
    if (outcome.status === 'created') affected.add(outcome.timesheetId);
  }

  // Rebuilt once per timesheet after the whole batch, not once per event: a
  // day's worth of offline events would otherwise rebuild the same day twelve
  // times, and the intermediate states are meaningless anyway.
  for (const timesheetId of affected) {
    await rebuildTimesheet(db, timesheetId, { now, actorUserId: actingUserId });
  }

  return { outcomes, affectedTimesheetIds: [...affected] };
}

async function ingestOne(
  db: Db,
  ctx: {
    companyId: string;
    actingUserId: string | null;
    defaultGeofenceRadiusM: number;
    now: Date;
    event: ClockEventInput;
  },
): Promise<IngestOutcome> {
  const { companyId, actingUserId, event } = ctx;
  const key = event.idempotencyKey;

  if (!isValidIdempotencyKey(key)) {
    return {
      status: 'rejected',
      idempotencyKey: String(key),
      code: 'invalid_idempotency_key',
      message: 'Event is missing a usable idempotency key.',
    };
  }

  if (Number.isNaN(Date.parse(event.deviceTime))) {
    return {
      status: 'rejected',
      idempotencyKey: key,
      code: 'invalid_device_time',
      message: 'Event has an unreadable device timestamp.',
    };
  }

  // --- replay check --------------------------------------------------------
  // Checked before the transaction so the common case (a retry of an event we
  // already have) costs one indexed lookup and nothing else.
  const existing = await one<{ id: string }>(
    db,
    'select id from attendance_event where company_id = $1 and idempotency_key = $2',
    [companyId, key],
  );
  if (existing) {
    return { status: 'duplicate', idempotencyKey: key, eventId: existing.id };
  }

  const employee = await one<EmployeeRow>(
    db,
    'select id, company_id, active, full_name from employee where id = $1 and company_id = $2',
    [event.employeeId, companyId],
  );
  if (!employee) {
    return {
      status: 'rejected',
      idempotencyKey: key,
      code: 'unknown_employee',
      message: 'No employee matches this record.',
    };
  }
  if (!employee.active) {
    return {
      status: 'rejected',
      idempotencyKey: key,
      code: 'inactive_employee',
      message: `${employee.full_name} is not an active employee.`,
    };
  }

  // --- state machine -------------------------------------------------------
  const priorEvents = await loadRecentEvents(db, employee.id, event.deviceTime);
  const state = deriveState(priorEvents);
  const transition = applyTransition(state, event.eventType);

  if (!transition.ok) {
    return {
      status: 'rejected',
      idempotencyKey: key,
      code: transition.code,
      message: transition.message,
    };
  }

  // --- geofence ------------------------------------------------------------
  let insideGeofence: boolean | null = null;
  let distanceM: number | null = null;

  if (event.jobId) {
    const site = await one<JobSiteRow>(
      db,
      `select j.id as job_id, s.latitude, s.longitude, s.geofence_radius_m
         from job j left join site s on s.id = j.site_id
        where j.id = $1 and j.company_id = $2`,
      [event.jobId, companyId],
    );
    if (!site) {
      return {
        status: 'rejected',
        idempotencyKey: key,
        code: 'unknown_job',
        message: 'That job is not available to this company.',
      };
    }

    const result = evaluateGeofence({
      position:
        event.latitude != null && event.longitude != null
          ? { latitude: event.latitude, longitude: event.longitude }
          : null,
      accuracyM: event.gpsAccuracyM ?? null,
      site:
        site.latitude != null && site.longitude != null
          ? { latitude: site.latitude, longitude: site.longitude }
          : null,
      radiusM: site.geofence_radius_m ?? ctx.defaultGeofenceRadiusM,
    });
    insideGeofence = result.insideGeofence;
    distanceM = result.distanceM;
  }

  // --- write ---------------------------------------------------------------
  return withTransaction(
    db,
    async (tx) => {
      const timesheetId = await resolveTimesheet(tx, {
        companyId,
        employeeId: employee.id,
        event,
        priorEvents,
      });

      // Phase 3: a geofence-raised event lands as a suggestion, not a live
      // clock - keyed purely off clockMethod so the client can't claim
      // confirmed status for itself by lying about this field. Everything
      // downstream (deriveState/orderedLiveEvents) already ignores it until
      // a later update flips this back to false.
      const isSuggested = event.clockMethod === 'auto_geofence';

      const inserted = await one<{ id: string }>(
        tx,
        `insert into attendance_event (
           company_id, employee_id, timesheet_id, job_id, work_activity_id,
           event_type, device_time, server_time,
           latitude, longitude, gps_accuracy_m,
           inside_geofence, distance_from_site_m, outside_reason,
           clock_method, was_offline, is_suggested, source_device_id, idempotency_key, created_by
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
         )
         -- The unique index is the real guard; this makes a racing duplicate
         -- return quietly instead of surfacing a constraint error to a phone
         -- that is simply retrying.
         on conflict (company_id, idempotency_key) do nothing
         returning id`,
        [
          companyId,
          employee.id,
          timesheetId,
          event.jobId ?? null,
          event.workActivityId ?? null,
          event.eventType,
          event.deviceTime,
          ctx.now.toISOString(),
          event.latitude ?? null,
          event.longitude ?? null,
          event.gpsAccuracyM ?? null,
          insideGeofence,
          distanceM,
          event.outsideReason ?? null,
          event.clockMethod,
          event.wasOffline,
          isSuggested,
          event.deviceId ?? null,
          key,
          event.actingUserId ?? actingUserId,
        ],
      );

      if (!inserted) {
        const raced = await one<{ id: string }>(
          tx,
          'select id from attendance_event where company_id = $1 and idempotency_key = $2',
          [companyId, key],
        );
        return {
          status: 'duplicate' as const,
          idempotencyKey: key,
          eventId: raced?.id ?? '',
        };
      }

      // Clocking out straight from a break: write the break_end the worker
      // forgot, at the same instant, so the timeline stays well-formed. Its
      // key is derived from the clock-out's, so a retry cannot double it.
      if (transition.ok && transition.implicitBreakEnd) {
        await tx.query(
          `insert into attendance_event (
             company_id, employee_id, timesheet_id, job_id, work_activity_id,
             event_type, device_time, server_time, clock_method, was_offline,
             is_suggested, source_device_id, idempotency_key, created_by
           ) values ($1,$2,$3,$4,$5,'break_end',$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (company_id, idempotency_key) do nothing`,
          [
            companyId,
            employee.id,
            timesheetId,
            event.jobId ?? null,
            event.workActivityId ?? null,
            event.deviceTime,
            ctx.now.toISOString(),
            event.clockMethod,
            event.wasOffline,
            isSuggested,
            event.deviceId ?? null,
            `${key}.auto-break-end`,
            event.actingUserId ?? actingUserId,
          ],
        );
      }

      return {
        status: 'created' as const,
        idempotencyKey: key,
        eventId: inserted.id,
        timesheetId,
        insideGeofence,
        distanceM,
      };
    },
    {
      actorUserId: event.actingUserId ?? actingUserId,
      reason: event.outsideReason ?? null,
    },
  );
}

/**
 * Events near this one, for state derivation.
 *
 * The 48-hour lookback covers night shifts and a phone that has been offline
 * overnight, while bounding the damage from a clock-in that was never closed —
 * a three-day-old open shift stops blocking today's clock-in, and the
 * missing_clock_out exception is what surfaces it to the office instead.
 */
async function loadRecentEvents(
  db: Db,
  employeeId: string,
  atIso: string,
): Promise<StoredAttendanceEvent[]> {
  const at = new Date(Date.parse(atIso));
  const from = new Date(at.getTime() - 48 * 3_600_000);

  const { rows } = await db.query<Record<string, unknown>>(
    `select id, employee_id, event_type, device_time, server_time, job_id,
            work_activity_id, latitude, longitude, gps_accuracy_m,
            inside_geofence, distance_from_site_m, outside_reason,
            clock_method, was_offline, is_suggested, voided_at
       from attendance_event
      where employee_id = $1
        and voided_at is null
        and device_time >= $2
        and device_time <= $3
      order by device_time asc`,
    [employeeId, from.toISOString(), at.toISOString()],
  );

  return rows.map(toStoredEvent);
}

export function toStoredEvent(r: Record<string, unknown>): StoredAttendanceEvent {
  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : String(v ?? '');
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    timesheetId: r.timesheet_id ? String(r.timesheet_id) : null,
    eventType: r.event_type as StoredAttendanceEvent['eventType'],
    deviceTime: iso(r.device_time),
    serverTime: iso(r.server_time),
    jobId: r.job_id ? String(r.job_id) : null,
    workActivityId: r.work_activity_id ? String(r.work_activity_id) : null,
    latitude: r.latitude as number | null,
    longitude: r.longitude as number | null,
    gpsAccuracyM: r.gps_accuracy_m as number | null,
    insideGeofence: r.inside_geofence as boolean | null,
    distanceFromSiteM: r.distance_from_site_m as number | null,
    outsideReason: (r.outside_reason as string | null) ?? null,
    clockMethod: r.clock_method as StoredAttendanceEvent['clockMethod'],
    wasOffline: Boolean(r.was_offline),
    isSuggested: Boolean(r.is_suggested),
    voidedAt: r.voided_at ? iso(r.voided_at) : null,
  };
}

/**
 * Which day this event belongs to.
 *
 * A shift belongs to the day it *started*, not the day each event happens to
 * fall on — a night crew clocking out at 00:30 belongs to yesterday's
 * timesheet, and splitting it across two days would break both the hours and
 * the approval. So: if a shift is already open, join it; otherwise open the
 * timesheet for the local calendar date.
 */
async function resolveTimesheet(
  db: Db,
  args: {
    companyId: string;
    employeeId: string;
    event: ClockEventInput;
    priorEvents: readonly StoredAttendanceEvent[];
  },
): Promise<string> {
  const { companyId, employeeId, event, priorEvents } = args;

  if (event.eventType !== 'clock_in') {
    const openShift = [...priorEvents]
      .reverse()
      .find((e) => e.eventType === 'clock_in');
    if (openShift) {
      const row = await one<{ timesheet_id: string | null }>(
        db,
        'select timesheet_id from attendance_event where id = $1',
        [openShift.id],
      );
      if (row?.timesheet_id) return row.timesheet_id;
    }
  }

  const timezone = await companyTimezone(db, companyId);
  const workDate = localDate(event.deviceTime, timezone);

  const existing = await one<{ id: string }>(
    db,
    'select id from timesheet where employee_id = $1 and work_date = $2',
    [employeeId, workDate],
  );
  if (existing) return existing.id;

  const created = await one<{ id: string }>(
    db,
    `insert into timesheet (company_id, employee_id, work_date)
     values ($1, $2, $3)
     on conflict (employee_id, work_date) do update set updated_at = now()
     returning id`,
    [companyId, employeeId, workDate],
  );
  return created!.id;
}

const timezoneCache = new Map<string, string>();

async function companyTimezone(db: Db, companyId: string): Promise<string> {
  const cached = timezoneCache.get(companyId);
  if (cached) return cached;
  const row = await one<{ timezone: string }>(
    db,
    'select timezone from company where id = $1',
    [companyId],
  );
  const tz = row?.timezone ?? 'Australia/Sydney';
  timezoneCache.set(companyId, tz);
  return tz;
}

/** YYYY-MM-DD in the given zone. en-CA is the locale that formats that way. */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.parse(iso)));
}
