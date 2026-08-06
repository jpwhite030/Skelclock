/**
 * Read models for the four dashboard screens and the worker home screen.
 *
 * Kept as explicit SQL in one file so the shape each screen depends on is
 * obvious and indexable, rather than assembled from a query builder across
 * three components.
 */

import {
  buildSegments,
  currentShift,
  deriveState,
  formatMinutes,
  type ClockState,
} from '@skelclock/core';

import { one, type Db } from './db.js';
import { toStoredEvent } from './ingest.js';

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

// --- worker home ------------------------------------------------------------

export interface WorkerHome {
  employeeId: string;
  employeeName: string;
  workDate: string;
  clockState: ClockState;
  timesheetId: string | null;
  timesheetStatus: string | null;
  assignedJob: {
    id: string;
    jobNumber: string;
    customerName: string | null;
    siteName: string | null;
    siteAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    geofenceRadiusM: number;
    scheduledStart: string | null;
  } | null;
  currentJobId: string | null;
  currentActivityId: string | null;
  minutesWorked: number;
  hoursWorkedLabel: string;
  breakMinutes: number;
  pendingSyncCount: number;
}

export async function getWorkerHome(
  db: Db,
  args: { companyId: string; employeeId: string; workDate: string; now?: Date },
): Promise<WorkerHome> {
  const now = args.now ?? new Date();

  const employee = await one<{ id: string; full_name: string }>(
    db,
    'select id, full_name from employee where id = $1 and company_id = $2',
    [args.employeeId, args.companyId],
  );
  if (!employee) throw new Error('Employee not found');

  const sheet = await one<{ id: string; status: string }>(
    db,
    'select id, status from timesheet where employee_id = $1 and work_date = $2',
    [args.employeeId, args.workDate],
  );

  // 48 hours back so a night shift still shows as running after midnight.
  const { rows: eventRows } = await db.query<Record<string, unknown>>(
    `select id, employee_id, timesheet_id, event_type, device_time, server_time, job_id,
            work_activity_id, latitude, longitude, gps_accuracy_m,
            inside_geofence, distance_from_site_m, outside_reason,
            clock_method, was_offline, is_suggested, voided_at
       from attendance_event
      where employee_id = $1 and voided_at is null and device_time >= $2
      order by device_time asc`,
    [args.employeeId, new Date(now.getTime() - 48 * 3_600_000).toISOString()],
  );
  const windowEvents = eventRows.map(toStoredEvent);
  const clockState = deriveState(windowEvents);

  // Hours are scoped to one timesheet, never to the raw 48-hour lookback that
  // window exists only to catch a night shift, and summing all of it would
  // report this morning's start as fourteen hours because yesterday is in it.
  //
  // When a shift is open we use the timesheet that shift was booked to, which
  // is yesterday's for a night crew and today's for everyone else. When the
  // worker is clocked off we use today's, so a finished day still shows its
  // hours rather than dropping to zero.
  const shift = currentShift(windowEvents);
  const scopeTimesheetId = shift?.timesheetId ?? sheet?.id ?? null;

  const events = scopeTimesheetId
    ? windowEvents.filter((e) => e.timesheetId === scopeTimesheetId)
    : [];

  const { segments, totals } = buildSegments(events, { now });

  const lastLive = [...events].reverse()[0];

  const assignment = await one<{
    job_id: string;
    job_number: string;
    customer_name: string | null;
    site_name: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    geofence_radius_m: number | null;
    scheduled_start: Date | null;
  }>(
    db,
    `select j.id as job_id, j.job_number, j.customer_name,
            s.name as site_name, s.address, s.latitude, s.longitude,
            s.geofence_radius_m, a.scheduled_start
       from assignment a
       join job j on j.id = a.job_id
       left join site s on s.id = j.site_id
      where a.company_id = $1
        and a.work_date = $2
        and (a.employee_id = $3
             or a.crew_id in (select crew_id from crew_member
                               where employee_id = $3 and active))
      order by a.scheduled_start asc nulls last
      limit 1`,
    [args.companyId, args.workDate, args.employeeId],
  );

  const pending = await one<{ count: string }>(
    db,
    `select count(*)::text as count from odoo_sync_job
      where entity_id in (select id from timesheet where employee_id = $1)
        and status in ('pending','running','failed')`,
    [args.employeeId],
  );

  return {
    employeeId: employee.id,
    employeeName: employee.full_name,
    workDate: args.workDate,
    clockState,
    timesheetId: sheet?.id ?? null,
    timesheetStatus: sheet?.status ?? null,
    assignedJob: assignment
      ? {
          id: assignment.job_id,
          jobNumber: assignment.job_number,
          customerName: assignment.customer_name,
          siteName: assignment.site_name,
          siteAddress: assignment.address,
          latitude: assignment.latitude,
          longitude: assignment.longitude,
          geofenceRadiusM: assignment.geofence_radius_m ?? 200,
          scheduledStart: iso(assignment.scheduled_start),
        }
      : null,
    // What they are on *now* comes from the open segment, not the roster —
    // a worker who switched jobs at 9am should not see this morning's job.
    currentJobId: clockState === 'off' ? null : (segments[segments.length - 1]?.jobId ?? lastLive?.jobId ?? null),
    currentActivityId:
      clockState === 'off' ? null : (segments[segments.length - 1]?.workActivityId ?? null),
    minutesWorked: totals.totalPaidMinutes,
    hoursWorkedLabel: formatMinutes(totals.totalPaidMinutes),
    breakMinutes: totals.totalBreakMinutes,
    pendingSyncCount: Number(pending?.count ?? 0),
  };
}

// --- admin: working now -----------------------------------------------------

export interface WorkingNowRow {
  employeeId: string;
  employeeName: string;
  crewName: string | null;
  jobNumber: string | null;
  siteName: string | null;
  activityName: string | null;
  clockInTime: string | null;
  minutesWorked: number;
  hoursWorkedLabel: string;
  onBreak: boolean;
  locationStatus: 'inside' | 'outside' | 'unknown';
  distanceM: number | null;
  syncStatus: string;
}

export async function getWorkingNow(
  db: Db,
  args: { companyId: string; now?: Date },
): Promise<WorkingNowRow[]> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();

  // Everyone with at least one live event in the window; state is decided in
  // TypeScript by the same state machine the phone uses, so the dashboard can
  // never disagree with what the worker sees.
  const { rows } = await db.query<{
    employee_id: string;
    full_name: string;
    crew_name: string | null;
  }>(
    `select distinct e.id as employee_id, e.full_name,
            (select c.name from crew c
               join crew_member cm on cm.crew_id = c.id and cm.active
              where cm.employee_id = e.id limit 1) as crew_name
       from employee e
       join attendance_event ae on ae.employee_id = e.id
      where e.company_id = $1 and ae.voided_at is null and ae.device_time >= $2`,
    [args.companyId, since],
  );

  const out: WorkingNowRow[] = [];

  for (const r of rows) {
    const { rows: eventRows } = await db.query<Record<string, unknown>>(
      `select id, employee_id, event_type, device_time, server_time, job_id,
              work_activity_id, latitude, longitude, gps_accuracy_m,
              inside_geofence, distance_from_site_m, outside_reason,
              clock_method, was_offline, is_suggested, voided_at
         from attendance_event
        where employee_id = $1 and voided_at is null and device_time >= $2
        order by device_time asc`,
      [r.employee_id, since],
    );
    const windowEvents = eventRows.map(toStoredEvent);
    const state = deriveState(windowEvents);
    if (state === 'off') continue;

    // Only the shift that is actually running. Without this the row shows
    // yesterday's clock-in time and adds yesterday's hours to today's.
    const shift = currentShift(windowEvents);
    if (!shift) continue;

    const { segments, totals } = buildSegments(shift.events, { now });
    const current = segments[segments.length - 1];
    const clockIn = shift.events.find((e) => e.eventType === 'clock_in');

    const job = current?.jobId
      ? await one<{ job_number: string; site_name: string | null }>(
          db,
          `select j.job_number, s.name as site_name
             from job j left join site s on s.id = j.site_id where j.id = $1`,
          [current.jobId],
        )
      : null;

    const activity = current?.workActivityId
      ? await one<{ name: string }>(db, 'select name from work_activity where id = $1', [
          current.workActivityId,
        ])
      : null;

    const sync = await one<{ status: string }>(
      db,
      `select oj.status from odoo_sync_job oj
         join timesheet t on t.id = oj.entity_id
        where t.employee_id = $1
        order by oj.updated_at desc limit 1`,
      [r.employee_id],
    );

    out.push({
      employeeId: r.employee_id,
      employeeName: r.full_name,
      crewName: r.crew_name,
      jobNumber: job?.job_number ?? null,
      siteName: job?.site_name ?? null,
      activityName: activity?.name ?? null,
      clockInTime: clockIn?.deviceTime ?? null,
      minutesWorked: totals.totalPaidMinutes,
      hoursWorkedLabel: formatMinutes(totals.totalPaidMinutes),
      onBreak: state === 'on_break',
      locationStatus:
        clockIn?.insideGeofence === true
          ? 'inside'
          : clockIn?.insideGeofence === false
            ? 'outside'
            : 'unknown',
      distanceM: clockIn?.distanceFromSiteM ?? null,
      syncStatus: sync?.status ?? 'not_queued',
    });
  }

  return out.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

// --- admin: timesheets ------------------------------------------------------

export interface TimesheetFilter {
  companyId: string;
  from?: string;
  to?: string;
  employeeId?: string;
  crewId?: string;
  jobId?: string;
  status?: string;
  limit?: number;
}

export interface TimesheetRow {
  id: string;
  workDate: string;
  employeeId: string;
  employeeName: string;
  status: string;
  totalShiftMinutes: number;
  totalBreakMinutes: number;
  totalPaidMinutes: number;
  paidHoursLabel: string;
  jobNumbers: string[];
  openExceptions: number;
  syncStatus: string | null;
  odooIds: number[];
}

export async function listTimesheets(
  db: Db,
  filter: TimesheetFilter,
): Promise<TimesheetRow[]> {
  const params: unknown[] = [filter.companyId];
  const where: string[] = ['t.company_id = $1'];

  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (filter.from) add('t.work_date >= $?', filter.from);
  if (filter.to) add('t.work_date <= $?', filter.to);
  if (filter.employeeId) add('t.employee_id = $?', filter.employeeId);
  if (filter.status) add('t.status = $?::timesheet_status', filter.status);
  if (filter.crewId) {
    add(
      't.employee_id in (select employee_id from crew_member where crew_id = $? and active)',
      filter.crewId,
    );
  }
  if (filter.jobId) {
    add('exists (select 1 from time_segment ts where ts.timesheet_id = t.id and ts.job_id = $?)', filter.jobId);
  }

  params.push(filter.limit ?? 200);

  const { rows } = await db.query<{
    id: string;
    work_date: Date | string;
    employee_id: string;
    full_name: string;
    status: string;
    total_shift_minutes: number;
    total_break_minutes: number;
    total_paid_minutes: number;
    job_numbers: string[] | null;
    open_exceptions: string;
    sync_status: string | null;
    odoo_ids: number[] | null;
  }>(
    `select t.id, t.work_date, t.employee_id, e.full_name, t.status,
            t.total_shift_minutes, t.total_break_minutes, t.total_paid_minutes,
            (select array_agg(distinct j.job_number)
               from time_segment ts join job j on j.id = ts.job_id
              where ts.timesheet_id = t.id) as job_numbers,
            (select count(*)::text from attendance_exception ax
              where ax.timesheet_id = t.id and ax.status = 'open') as open_exceptions,
            (select oj.status from odoo_sync_job oj
              where oj.entity_id = t.id order by oj.updated_at desc limit 1) as sync_status,
            (select array_agg(l.odoo_id order by l.block_index)
               from odoo_attendance_link l where l.timesheet_id = t.id) as odoo_ids
       from timesheet t
       join employee e on e.id = t.employee_id
      where ${where.join(' and ')}
      order by t.work_date desc, e.full_name asc
      limit $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    workDate: String(r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : r.work_date),
    employeeId: r.employee_id,
    employeeName: r.full_name,
    status: r.status,
    totalShiftMinutes: r.total_shift_minutes,
    totalBreakMinutes: r.total_break_minutes,
    totalPaidMinutes: r.total_paid_minutes,
    paidHoursLabel: formatMinutes(r.total_paid_minutes),
    jobNumbers: r.job_numbers ?? [],
    openExceptions: Number(r.open_exceptions),
    syncStatus: r.sync_status,
    odooIds: r.odoo_ids ?? [],
  }));
}

// --- admin: exceptions ------------------------------------------------------

export interface ExceptionRow {
  id: string;
  type: string;
  severity: number;
  status: string;
  employeeName: string | null;
  workDate: string | null;
  message: string;
  details: Record<string, unknown>;
  createdAt: string | null;
}

export async function listExceptions(
  db: Db,
  args: { companyId: string; status?: string; limit?: number },
): Promise<ExceptionRow[]> {
  const { rows } = await db.query<{
    id: string;
    exception_type: string;
    severity: number;
    status: string;
    full_name: string | null;
    work_date: Date | string | null;
    details: Record<string, unknown> | string;
    created_at: Date;
  }>(
    `select ax.id, ax.exception_type, ax.severity, ax.status,
            e.full_name, t.work_date, ax.details, ax.created_at
       from attendance_exception ax
       left join employee e on e.id = ax.employee_id
       left join timesheet t on t.id = ax.timesheet_id
      where ax.company_id = $1
        and ($2::exception_status is null or ax.status = $2)
      order by ax.severity asc, ax.created_at desc
      limit $3`,
    [args.companyId, args.status ?? null, args.limit ?? 200],
  );

  return rows.map((r) => {
    const details =
      typeof r.details === 'string'
        ? (JSON.parse(r.details) as Record<string, unknown>)
        : r.details;
    return {
      id: r.id,
      type: r.exception_type,
      severity: r.severity,
      status: r.status,
      employeeName: r.full_name,
      workDate: r.work_date
        ? String(r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : r.work_date)
        : null,
      message: String(details?.message ?? r.exception_type),
      details,
      createdAt: iso(r.created_at),
    };
  });
}

// --- admin: odoo sync -------------------------------------------------------

export interface SyncRow {
  id: string;
  entityType: string;
  entityId: string | null;
  employeeName: string | null;
  workDate: string | null;
  operation: string;
  status: string;
  attempts: number;
  lastError: string | null;
  odooRecordId: number | null;
  nextAttemptAt: string | null;
  updatedAt: string | null;
}

export async function listSyncJobs(
  db: Db,
  args: { companyId: string; status?: string; limit?: number },
): Promise<SyncRow[]> {
  const { rows } = await db.query<{
    id: string;
    entity_type: string;
    entity_id: string | null;
    operation: string;
    status: string;
    attempts: number;
    last_error: string | null;
    odoo_record_id: number | null;
    next_attempt_at: Date;
    updated_at: Date;
    full_name: string | null;
    work_date: Date | string | null;
  }>(
    `select oj.id, oj.entity_type, oj.entity_id, oj.operation, oj.status,
            oj.attempts, oj.last_error, oj.odoo_record_id, oj.next_attempt_at,
            oj.updated_at, e.full_name, t.work_date
       from odoo_sync_job oj
       left join timesheet t on t.id = oj.entity_id
       left join employee e on e.id = t.employee_id
      where oj.company_id = $1
        and ($2::sync_status is null or oj.status = $2)
      order by oj.updated_at desc
      limit $3`,
    [args.companyId, args.status ?? null, args.limit ?? 200],
  );

  return rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    employeeName: r.full_name,
    workDate: r.work_date
      ? String(r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : r.work_date)
      : null,
    operation: r.operation,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    odooRecordId: r.odoo_record_id,
    nextAttemptAt: iso(r.next_attempt_at),
    updatedAt: iso(r.updated_at),
  }));
}

export interface SyncSummary {
  pending: number;
  running: number;
  success: number;
  failed: number;
  dead: number;
}

export async function getSyncSummary(db: Db, companyId: string): Promise<SyncSummary> {
  const { rows } = await db.query<{ status: string; count: string }>(
    `select status, count(*)::text as count from odoo_sync_job
      where company_id = $1 group by status`,
    [companyId],
  );
  const summary: SyncSummary = { pending: 0, running: 0, success: 0, failed: 0, dead: 0 };
  for (const r of rows) {
    if (r.status in summary) summary[r.status as keyof SyncSummary] = Number(r.count);
  }
  return summary;
}

// --- audit ------------------------------------------------------------------

export interface AuditRow {
  id: string;
  action: string;
  tableName: string;
  recordId: string | null;
  reason: string | null;
  actorName: string | null;
  createdAt: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Full history for one attendance record, for a payroll query or a dispute. */
export async function getAuditTrail(
  db: Db,
  args: { companyId: string; recordId?: string; timesheetId?: string; limit?: number },
): Promise<AuditRow[]> {
  const { rows } = await db.query<{
    id: string;
    action: string;
    table_name: string;
    record_id: string | null;
    reason: string | null;
    created_at: Date;
    before_value: Record<string, unknown> | string | null;
    after_value: Record<string, unknown> | string | null;
    actor_name: string | null;
  }>(
    `select a.id, a.action, a.table_name, a.record_id, a.reason, a.created_at,
            a.before_value, a.after_value, e.full_name as actor_name
       from audit_log a
       left join app_user u on u.id = a.actor_user_id
       left join employee e on e.id = u.employee_id
      where a.company_id = $1
        and ($2::uuid is null or a.record_id = $2)
        and ($3::uuid is null or a.record_id = $3
             or (a.table_name = 'attendance_event'
                 and a.record_id in (select id from attendance_event where timesheet_id = $3)))
      order by a.created_at asc
      limit $4`,
    [args.companyId, args.recordId ?? null, args.timesheetId ?? null, args.limit ?? 500],
  );

  const parse = (v: unknown): Record<string, unknown> | null =>
    v == null ? null : typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown>);

  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    tableName: r.table_name,
    recordId: r.record_id,
    reason: r.reason,
    actorName: r.actor_name,
    createdAt: iso(r.created_at),
    before: parse(r.before_value),
    after: parse(r.after_value),
  }));
}
