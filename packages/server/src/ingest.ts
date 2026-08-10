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
  blocksClockIn,
  deriveState,
  evaluateGeofence,
  isValidIdempotencyKey,
  shouldAutoConfirmGeofence,
  type ClockEventInput,
  type StoredAttendanceEvent,
} from '@skelclock/core';

import { one, withTransaction, type Db } from './db.js';
import { checkOperatingHours, getCompanySettings } from './settings.js';
import { isEmployeeExcludedFromSite } from './sites.js';
import { rebuildTimesheet } from './timesheet.js';

/**
 * How close together two auto-geofence triggers of the same type, for the
 * same job, have to land before the second is treated as GPS bounce off a
 * fence edge rather than a second real arrival/departure.
 */
const AUTO_GEOFENCE_DEBOUNCE_MS = 10 * 60_000;

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
  | {
      status: 'created';
      idempotencyKey: string;
      eventId: string;
      timesheetId: string;
      insideGeofence: boolean | null;
      distanceM: number | null;
      autoConfirmed: boolean;
    }
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
  site_id: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number | null;
  operating_hours_start: string | null;
  operating_hours_end: string | null;
}

export async function ingestEvents(db: Db, options: IngestOptions): Promise<IngestResult> {
  const {
    companyId,
    actingUserId = null,
    defaultGeofenceRadiusM = 70,
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

  const priorEvents = await loadRecentEvents(db, employee.id, event.deviceTime);

  // --- debounce (auto-geofence only) ----------------------------------------
  // GPS bouncing right at a fence edge can retrigger the OS region callback
  // several times in a row. Folding into the existing row — rather than
  // creating a second one — is exactly what "duplicate" already means to the
  // queue: silent, no retry, nothing for the worker to dismiss.
  //
  // Checked before the state machine, deliberately: a confident bounce (high
  // accuracy, auto-confirmed) is exactly the case that has already moved the
  // worker's state — orderedLiveEvents does not skip it the way it skips a
  // still-suggested event. Checking the state machine first would reject the
  // bounce as "already clocked in" before this debounce ever ran, turning a
  // fence-edge wobble into a worker-visible error banner nobody caused.
  if (event.clockMethod === 'auto_geofence') {
    const recentSame = priorEvents.find(
      (e) =>
        e.clockMethod === 'auto_geofence' &&
        e.eventType === event.eventType &&
        e.jobId === (event.jobId ?? null) &&
        Math.abs(Date.parse(event.deviceTime) - Date.parse(e.deviceTime)) <=
          AUTO_GEOFENCE_DEBOUNCE_MS,
    );
    if (recentSame) {
      return { status: 'duplicate', idempotencyKey: key, eventId: recentSame.id };
    }
  }

  // --- state machine -------------------------------------------------------
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

  // --- site: unknown-job, hard exclusion, geofence --------------------------
  let insideGeofence: boolean | null = null;
  let distanceM: number | null = null;
  let site: JobSiteRow | null = null;

  if (event.jobId) {
    site = await one<JobSiteRow>(
      db,
      `select j.id as job_id, s.id as site_id, s.latitude, s.longitude,
              s.geofence_radius_m, s.operating_hours_start, s.operating_hours_end
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

    // "They live next door" — a hard stop, every clock method, not just
    // auto-detect. No override: removing the exclusion row is the only way
    // back in, so this never silently defers to a supervisor's own clock.
    if (site.site_id && (await isEmployeeExcludedFromSite(db, { employeeId: employee.id, siteId: site.site_id }))) {
      return {
        status: 'rejected',
        idempotencyKey: key,
        code: 'site_excluded',
        message: 'This employee is not able to clock in at this site.',
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

    // Confidently outside the fence refuses a clock-on — blocksClockIn's own
    // doc comment calls this "the one rule in the system that can stop
    // someone starting work." The phone already refuses to even queue a press
    // that fails this same test (apps/mobile/src/useClock.ts), but the server
    // is the actual trust boundary: a request that skips the app entirely — a
    // scripted client, a modified build — must not be able to grant itself a
    // clock the honest app would have refused. Never gates clock_out, and
    // never applies when a person is deciding on someone else's behalf (crew
    // clock, a missed-time entry) — same reasoning as the operating-hours
    // bypass just below.
    if (
      event.eventType === 'clock_in' &&
      (event.clockMethod === 'manual' || event.clockMethod === 'auto_geofence') &&
      blocksClockIn(result)
    ) {
      return {
        status: 'rejected',
        idempotencyKey: key,
        code: 'outside_geofence',
        message:
          distanceM != null
            ? `You are about ${Math.round(distanceM)}m from the site, and you have to be on site to clock on.`
            : 'You have to be on site to clock on.',
      };
    }
  }

  // --- operating hours -------------------------------------------------------
  // Gates starting a shift, not ending one: refusing a clock-out because a
  // shift ran past closing time would trap a worker clocked in forever. A
  // supervisor/admin clocking someone in deliberately (crew clock, a missed-
  // time entry) bypasses this the same way they already bypass the geofence -
  // they are a person making a decision, not GPS or a clock guessing.
  if (
    event.eventType === 'clock_in' &&
    (event.clockMethod === 'manual' || event.clockMethod === 'auto_geofence')
  ) {
    const hours = await checkOperatingHours(db, {
      companyId,
      deviceTime: event.deviceTime,
      siteHoursStart: site?.operating_hours_start,
      siteHoursEnd: site?.operating_hours_end,
    });
    if (!hours.allowed) {
      return {
        status: 'rejected',
        idempotencyKey: key,
        code: 'outside_operating_hours',
        message: hours.message,
      };
    }
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

      // Phase 3: a geofence-raised event lands as a suggestion unless it is
      // confident and unambiguous enough to skip the tap (see
      // shouldAutoConfirmGeofence) - tap-to-confirm is the fallback, not the
      // default. Either way this is decided from server-computed signals, not
      // anything the client claims, so a tampered client cannot grant itself
      // confirmed status by lying about clockMethod or accuracy.
      const candidateCount = event.candidateJobIds?.length ?? 1;
      const candidateJobIds =
        event.clockMethod === 'auto_geofence' && candidateCount > 1
          ? event.candidateJobIds!
          : null;
      // Minimum dwell is company policy, so it is read here rather than
      // trusted from the phone — the client stamps when it arrived, the server
      // decides whether that was long enough.
      const { geofenceMinDwellMinutes } = await getCompanySettings(tx, companyId);
      const insideSinceMs = event.insideSince ? Date.parse(event.insideSince) : NaN;

      const autoConfirmed =
        event.clockMethod === 'auto_geofence' &&
        shouldAutoConfirmGeofence({
          insideGeofence,
          accuracyM: event.gpsAccuracyM ?? null,
          candidateSiteCount: candidateCount,
          insideSinceMs: Number.isNaN(insideSinceMs) ? null : insideSinceMs,
          // Both device times. An event that sat in the offline queue for six
          // hours must not be credited with six hours of standing on site,
          // which is what using the server clock here would do.
          nowMs: Date.parse(event.deviceTime),
          minimumDwellMinutes: geofenceMinDwellMinutes,
        });
      const isSuggested = event.clockMethod === 'auto_geofence' && !autoConfirmed;

      const inserted = await one<{ id: string }>(
        tx,
        `insert into attendance_event (
           company_id, employee_id, timesheet_id, job_id, work_activity_id,
           event_type, device_time, server_time,
           latitude, longitude, gps_accuracy_m,
           inside_geofence, distance_from_site_m, outside_reason,
           clock_method, was_offline, is_suggested, candidate_job_ids,
           source_device_id, idempotency_key, created_by
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
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
          candidateJobIds,
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
        // Not !isSuggested: that's true for every manual/supervisor/admin
        // clock too, since only an auto_geofence event is ever suggested in
        // the first place. This field means one specific thing — did the
        // server's own GPS confidence check confirm this event without a
        // tap — so it must be exactly the variable that answered that
        // question, not a stand-in that happens to agree only for the one
        // clock method currently reading it.
        autoConfirmed,
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
