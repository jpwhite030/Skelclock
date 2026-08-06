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

import { one, oneOrFail, withTransaction, type Db } from './db.js';
import { rebuildTimesheet } from './timesheet.js';

export class SuggestionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SuggestionError';
  }
}

export interface PendingSuggestion {
  id: string;
  eventType: 'clock_in' | 'clock_out';
  jobId: string | null;
  siteName: string | null;
  deviceTime: string;
}

export async function listPendingSuggestions(
  db: Db,
  args: { companyId: string; employeeId: string },
): Promise<PendingSuggestion[]> {
  const { rows } = await db.query<{
    id: string;
    event_type: 'clock_in' | 'clock_out';
    job_id: string | null;
    site_name: string | null;
    device_time: Date | string;
  }>(
    `select e.id, e.event_type, e.job_id, s.name as site_name, e.device_time
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

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    jobId: r.job_id,
    siteName: r.site_name,
    deviceTime: r.device_time instanceof Date ? r.device_time.toISOString() : String(r.device_time),
  }));
}

interface SuggestedEventRow {
  id: string;
  company_id: string;
  employee_id: string;
  timesheet_id: string | null;
  is_suggested: boolean;
  voided_at: Date | null;
}

async function loadOwnSuggestion(
  db: Db,
  args: { companyId: string; employeeId: string; eventId: string },
): Promise<SuggestedEventRow> {
  const row = await oneOrFail<SuggestedEventRow>(
    db,
    `select id, company_id, employee_id, timesheet_id, is_suggested, voided_at
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

/** Worker accepts a suggested event: it now counts, exactly as recorded. */
export async function confirmSuggestedEvent(
  db: Db,
  args: { companyId: string; employeeId: string; eventId: string; actorUserId: string; now?: Date },
): Promise<{ eventId: string; timesheetId: string | null }> {
  const row = await loadOwnSuggestion(db, args);
  const now = args.now ?? new Date();

  await withTransaction(
    db,
    async (tx) => {
      await tx.query('update attendance_event set is_suggested = false where id = $1', [row.id]);
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
