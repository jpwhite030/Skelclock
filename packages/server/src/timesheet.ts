/**
 * Timesheet rebuild.
 *
 * Segments, totals and exceptions are all *derived*. Nothing here is a source
 * of truth — the attendance events are — so rebuilding is always safe and is
 * the only way any of it gets written. That means a bug fixed in the segment
 * builder can be applied to historical days by re-running this, without
 * anybody hand-editing payroll data.
 */

import {
  buildSegments,
  detectExceptions,
  type DetectedException,
  type TimeSegment,
  type WorkActivityRef,
} from '@skelclock/core';

import { one, withTransaction, type Db } from './db.js';
import { toStoredEvent } from './ingest.js';

export interface RebuildOptions {
  now?: Date;
  longShiftHours?: number;
  actorUserId?: string | null;
  /** Suppresses "missing clock-out" until the day is genuinely over. */
  dayIsClosed?: boolean;
}

export interface RebuildResult {
  timesheetId: string;
  segments: TimeSegment[];
  totals: { totalShiftMinutes: number; totalBreakMinutes: number; totalPaidMinutes: number };
  exceptions: DetectedException[];
  hasOpenShift: boolean;
}

export async function rebuildTimesheet(
  db: Db,
  timesheetId: string,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const { now = new Date(), longShiftHours = 14 } = options;

  const sheet = await one<{
    id: string;
    company_id: string;
    employee_id: string;
    work_date: string | Date;
    status: string;
  }>(
    db,
    'select id, company_id, employee_id, work_date, status from timesheet where id = $1',
    [timesheetId],
  );
  if (!sheet) throw new Error(`Timesheet ${timesheetId} not found`);

  const activities = await loadActivities(db, sheet.company_id);

  const { rows: eventRows } = await db.query<Record<string, unknown>>(
    `select id, employee_id, event_type, device_time, server_time, job_id,
            work_activity_id, latitude, longitude, gps_accuracy_m,
            inside_geofence, distance_from_site_m, outside_reason,
            clock_method, was_offline, is_suggested, voided_at
       from attendance_event
      where timesheet_id = $1 and voided_at is null
      order by device_time asc`,
    [timesheetId],
  );
  const events = eventRows.map(toStoredEvent);

  const { segments, totals, hasOpenShift } = buildSegments(events, {
    activities,
    now,
  });

  // Drivers return `date` columns as Date objects or as strings depending on
  // the client; normalise before doing anything calendar-shaped with it.
  const workDate =
    sheet.work_date instanceof Date
      ? sheet.work_date.toISOString().slice(0, 10)
      : String(sheet.work_date).slice(0, 10);

  const dayIsClosed = options.dayIsClosed ?? isDayClosed(workDate, now);

  const neighbouring = await loadNeighbouringSegments(
    db,
    sheet.employee_id,
    workDate,
    timesheetId,
  );

  const exceptions = detectExceptions({
    events,
    segments,
    hasOpenShift,
    longShiftHours,
    neighbouringSegments: neighbouring,
    dayIsClosed,
  });

  await withTransaction(
    db,
    async (tx) => {
      // A locked timesheet's totals are frozen (migration 0002 enforces it),
      // so recompute the view but leave the stored numbers alone.
      if (sheet.status !== 'locked') {
        await tx.query('delete from time_segment where timesheet_id = $1', [timesheetId]);

        for (const s of segments) {
          await tx.query(
            `insert into time_segment (
               company_id, timesheet_id, employee_id, job_id, work_activity_id,
               segment_type, start_time, end_time, minutes, is_paid,
               start_event_id, end_event_id
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              sheet.company_id,
              timesheetId,
              sheet.employee_id,
              s.jobId,
              s.workActivityId,
              s.segmentType,
              s.startTime,
              s.endTime,
              s.minutes,
              s.isPaid,
              s.startEventId,
              s.endEventId,
            ],
          );
        }

        await tx.query(
          `update timesheet
              set total_shift_minutes = $2,
                  total_break_minutes = $3,
                  total_paid_minutes  = $4
            where id = $1`,
          [
            timesheetId,
            totals.totalShiftMinutes,
            totals.totalBreakMinutes,
            totals.totalPaidMinutes,
          ],
        );
      }

      await syncExceptions(tx, {
        companyId: sheet.company_id,
        employeeId: sheet.employee_id,
        timesheetId,
        exceptions,
      });
    },
    { actorUserId: options.actorUserId ?? null, reason: 'timesheet rebuild' },
  );

  return { timesheetId, segments, totals, exceptions, hasOpenShift };
}

/**
 * Reconciles the exception list for a day.
 *
 * Upsert rather than delete-and-reinsert, so that an exception the office has
 * already acknowledged does not pop back onto the queue every time the day is
 * rebuilt. Exceptions that no longer apply are auto-resolved with a note
 * instead of vanishing, because "why did that disappear?" is a support call.
 */
async function syncExceptions(
  db: Db,
  args: {
    companyId: string;
    employeeId: string;
    timesheetId: string;
    exceptions: readonly DetectedException[];
  },
): Promise<void> {
  const { companyId, employeeId, timesheetId, exceptions } = args;

  for (const ex of exceptions) {
    await db.query(
      `insert into attendance_exception (
         company_id, employee_id, timesheet_id, attendance_event_id,
         exception_type, severity, details, status
       ) values ($1,$2,$3,$4,$5,$6,$7,'open')
       on conflict (company_id, timesheet_id, exception_type, attendance_event_id)
       do update set details = excluded.details,
                     severity = excluded.severity,
                     -- Re-opens an auto-resolved exception that has come back,
                     -- but never overrides a human's acknowledgement.
                     status = case
                       when attendance_exception.status = 'resolved'
                            and attendance_exception.resolved_by is null
                       then 'open'
                       else attendance_exception.status
                     end`,
      [
        companyId,
        employeeId,
        timesheetId,
        ex.attendanceEventId ?? null,
        ex.type,
        ex.severity,
        JSON.stringify({ ...ex.details, message: ex.message }),
      ],
    );
  }

  // Passed as a delimited string rather than an array parameter: an empty JS
  // array does not serialise to a Postgres array literal on every driver, and
  // "no exceptions detected" is the common case that must clear the list.
  const stillApplies = exceptions.map((e) => e.type).join(',');
  await db.query(
    `update attendance_exception
        set status = 'resolved',
            resolved_at = now(),
            resolution_note = 'No longer detected after rebuild'
      where timesheet_id = $1
        and status = 'open'
        and not (exception_type::text = any(string_to_array($2, ',')))`,
    [timesheetId, stillApplies],
  );
}

async function loadActivities(
  db: Db,
  companyId: string,
): Promise<Map<string, WorkActivityRef>> {
  const { rows } = await db.query<{
    id: string;
    code: string;
    name: string;
    is_travel: boolean;
    is_paid: boolean;
  }>(
    'select id, code, name, is_travel, is_paid from work_activity where company_id = $1',
    [companyId],
  );

  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, code: r.code, name: r.name, isTravel: r.is_travel, isPaid: r.is_paid },
    ]),
  );
}

/** Segments from the days either side, for cross-midnight overlap detection. */
async function loadNeighbouringSegments(
  db: Db,
  employeeId: string,
  workDate: string,
  excludeTimesheetId: string,
): Promise<TimeSegment[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select ts.job_id, ts.work_activity_id, ts.segment_type, ts.start_time,
            ts.end_time, ts.minutes, ts.is_paid
       from time_segment ts
       join timesheet t on t.id = ts.timesheet_id
      where t.employee_id = $1
        and t.id <> $2
        and t.work_date between ($3::date - 1) and ($3::date + 1)`,
    [employeeId, excludeTimesheetId, workDate],
  );

  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : String(v ?? '');

  return rows.map((r) => ({
    jobId: r.job_id ? String(r.job_id) : null,
    workActivityId: r.work_activity_id ? String(r.work_activity_id) : null,
    segmentType: r.segment_type as TimeSegment['segmentType'],
    startTime: iso(r.start_time),
    endTime: r.end_time ? iso(r.end_time) : null,
    minutes: r.minutes as number | null,
    isPaid: Boolean(r.is_paid),
    startEventId: null,
    endEventId: null,
  }));
}

/**
 * A day counts as closed six hours after midnight following it — late enough
 * that a night shift finishing at 3am has had its clock-out, early enough that
 * the office sees yesterday's missing clock-outs when they start work.
 */
function isDayClosed(workDate: string, now: Date): boolean {
  const cutoff = Date.parse(`${workDate}T00:00:00Z`) + 30 * 3_600_000;
  return now.getTime() > cutoff;
}
