/**
 * Phase 3: confirming or dismissing a geofence-raised clock suggestion.
 *
 * `ingest.ts` already writes an `auto_geofence` event with `is_suggested =
 * true`, and `orderedLiveEvents` (packages/core) already excludes it from
 * state/segments/hours. This file is only the two things that happen next:
 * a worker accepts it (flip the flag, it now counts, same row - nothing
 * about it changes because nothing about it was wrong) or a worker rejects
 * it (void it, same as any other correction - never delete an attendance
 * row, per the append-only guarantee in 0002_integrity.sql).
 *
 * Scoped to the caller's own employee_id throughout: this is a worker
 * confirming their own arrival, not a supervisor action, so there is no
 * cross-employee case to support here.
 */

import { pendingSuggestionSchema, type PendingSuggestionDto } from '@skelclock/contracts';

import { one, oneOrFail, withTransaction, type Db } from './db.js';
import type { ExceptionRow } from './queries.js';
import { rebuildTimesheet } from './timesheet.js';

/** How long a geofence suggestion sits unconfirmed before the office is told. */
const STALE_SUGGESTION_HOURS = 24;

export class SuggestionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SuggestionError';
  }
}

export type PendingSuggestion = PendingSuggestionDto;

export async function listPendingSuggestions(
  db: Db,
  args: { companyId: string; employeeId: string },
): Promise<PendingSuggestionDto[]> {
  const { rows } = await db.query<{
    id: string;
    event_type: 'clock_in' | 'clock_out';
    job_id: string | null;
    site_name: string | null;
    device_time: Date | string;
    candidate_job_ids: string[] | null;
  }>(
    `select e.id, e.event_type, e.job_id, s.name as site_name, e.device_time, e.candidate_job_ids
       from attendance_event e
       left join job j on j.id = e.job_id
       left join site s on s.id = j.site_id
      where e.company_id = $1
        and e.employee_id = $2
        and e.is_suggested = true
        and e.voided_at is null
      order by e.device_time asc`,
    [args.companyId, args.employeeId],
  );

  return rows.map((r) =>
    pendingSuggestionSchema.parse({
      id: r.id,
      eventType: r.event_type,
      jobId: r.job_id,
      siteName: r.site_name,
      deviceTime: r.device_time instanceof Date ? r.device_time.toISOString() : String(r.device_time),
      candidateJobIds: r.candidate_job_ids,
    }),
  );
}

interface SuggestedEventRow {
  id: string;
  company_id: string;
  employee_id: string;
  timesheet_id: string | null;
  is_suggested: boolean;
  voided_at: Date | null;
  candidate_job_ids: string[] | null;
}

async function loadOwnSuggestion(
  db: Db,
  args: { companyId: string; employeeId: string; eventId: string },
): Promise<SuggestedEventRow> {
  const row = await oneOrFail<SuggestedEventRow>(
    db,
    `select id, company_id, employee_id, timesheet_id, is_suggested, voided_at, candidate_job_ids
       from attendance_event
      where id = $1 and company_id = $2 and employee_id = $3`,
    [args.eventId, args.companyId, args.employeeId],
    'Suggested event',
  );

  if (row.voided_at) {
    throw new SuggestionError('This suggestion has already been dismissed.', 'already_voided');
  }
  if (!row.is_suggested) {
    throw new SuggestionError('This event is not a pending suggestion.', 'not_a_suggestion');
  }
  return row;
}

/**
 * Worker accepts a suggested event: it now counts, exactly as recorded.
 *
 * jobId is only for the ambiguous case (two sites fired at once, see
 * ingest.ts's candidate_job_ids) — the worker is picking which of the
 * *already-recorded* candidates they meant, not reassigning the event to an
 * arbitrary job. Rejected if it is not one of the stored candidates.
 */
export async function confirmSuggestedEvent(
  db: Db,
  args: {
    companyId: string;
    employeeId: string;
    eventId: string;
    actorUserId: string;
    jobId?: string | null;
    now?: Date;
  },
): Promise<{ eventId: string; timesheetId: string | null }> {
  const row = await loadOwnSuggestion(db, args);
  const now = args.now ?? new Date();

  if (args.jobId && !(row.candidate_job_ids ?? []).includes(args.jobId)) {
    throw new SuggestionError(
      'That job was not one of the sites this arrival matched.',
      'invalid_candidate_job',
    );
  }

  await withTransaction(
    db,
    async (tx) => {
      if (args.jobId) {
        await tx.query(
          'update attendance_event set is_suggested = false, job_id = $2, candidate_job_ids = null where id = $1',
          [row.id, args.jobId],
        );
      } else {
        await tx.query('update attendance_event set is_suggested = false where id = $1', [row.id]);
      }
    },
    { actorUserId: args.actorUserId, reason: 'Worker confirmed geofence suggestion' },
  );

  if (row.timesheet_id) {
    await rebuildTimesheet(db, row.timesheet_id, { now, actorUserId: args.actorUserId });
  }

  return { eventId: row.id, timesheetId: row.timesheet_id };
}

/** Worker rejects a suggested event: voided, same as any other correction - never deleted. */
export async function dismissSuggestedEvent(
  db: Db,
  args: {
    companyId: string;
    employeeId: string;
    eventId: string;
    actorUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ eventId: string }> {
  if (!args.reason?.trim()) {
    throw new SuggestionError('Dismissing a suggestion requires a reason.', 'reason_required');
  }

  const row = await loadOwnSuggestion(db, args);
  const now = args.now ?? new Date();

  await withTransaction(
    db,
    async (tx) => {
      await tx.query(
        `update attendance_event
            set voided_at = now(), voided_by = $2, void_reason = $3
          where id = $1`,
        [row.id, args.actorUserId, args.reason],
      );
    },
    { actorUserId: args.actorUserId, reason: args.reason },
  );

  if (row.timesheet_id) {
    await rebuildTimesheet(db, row.timesheet_id, { now, actorUserId: args.actorUserId });
  }

  return { eventId: row.id };
}

/**
 * Company-wide, for the office: geofence suggestions nobody has confirmed or
 * dismissed in a while.
 *
 * Computed live rather than through detectExceptions/attendance_exception —
 * that pipeline only re-runs when a timesheet is rebuilt, which a suggestion
 * sitting untouched will never trigger on its own. A worker who swipes away
 * the notification and never reopens the app would otherwise leave a day
 * quietly short with nobody told, which is exactly the silence the rest of
 * this exceptions list exists to prevent.
 */
export async function listStaleSuggestions(
  db: Db,
  args: { companyId: string; olderThanHours?: number },
): Promise<ExceptionRow[]> {
  const hours = args.olderThanHours ?? STALE_SUGGESTION_HOURS;

  const { rows } = await db.query<{
    id: string;
    full_name: string | null;
    work_date: Date | string | null;
    event_type: 'clock_in' | 'clock_out';
    device_time: Date | string;
    site_name: string | null;
  }>(
    `select e.id, emp.full_name, t.work_date, e.event_type, e.device_time, s.name as site_name
       from attendance_event e
       join employee emp on emp.id = e.employee_id
       left join timesheet t on t.id = e.timesheet_id
       left join job j on j.id = e.job_id
       left join site s on s.id = j.site_id
      where e.company_id = $1
        and e.is_suggested = true
        and e.voided_at is null
        and e.device_time < now() - ($2::text || ' hours')::interval
      order by e.device_time asc`,
    [args.companyId, String(hours)],
  );

  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

  return rows.map((r): ExceptionRow => {
    const deviceTime = iso(r.device_time);
    const hoursSince = Math.max(0, Math.round((Date.now() - Date.parse(deviceTime)) / 3_600_000));
    const action = r.event_type === 'clock_in' ? 'arrival' : 'departure';
    const workDate = r.work_date
      ? r.work_date instanceof Date
        ? r.work_date.toISOString().slice(0, 10)
        : String(r.work_date).slice(0, 10)
      : null;

    return {
      id: r.id,
      type: 'stale_suggestion',
      severity: 2,
      status: 'open',
      employeeName: r.full_name,
      workDate,
      message: `A geofence-suggested ${action}${r.site_name ? ` at ${r.site_name}` : ''} from ${hoursSince}h ago is still unconfirmed.`,
      details: { deviceTime, hoursSince, eventType: r.event_type },
      createdAt: deviceTime,
    };
  });
}
