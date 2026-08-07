/**
 * Approval ladder and corrections.
 *
 * Two rules run through everything here:
 *   * A correction never mutates an event. It voids the original with a reason
 *     and writes a replacement, so the original value survives forever.
 *   * A status only moves along a declared edge. An undeclared jump is a bug,
 *     and it should fail loudly here rather than quietly produce a timesheet
 *     that is "synced" without ever having been approved.
 */

import { newIdempotencyKey, type AttendanceEventType, type TimesheetStatus } from '@skelclock/core';

import { one, oneOrFail, withTransaction, type Db } from './db.js';
import { rebuildTimesheet } from './timesheet.js';

export type { TimesheetStatus };

/**
 * Legal moves.
 *
 * Note that a supervisor may approve straight from `draft`: a worker who has
 * gone home without confirming should not hold up the crew's payroll, and the
 * approval row records that it happened without worker confirmation.
 */
const TRANSITIONS: Record<TimesheetStatus, TimesheetStatus[]> = {
  draft: ['worker_confirmed', 'supervisor_approved'],
  worker_confirmed: ['supervisor_approved', 'draft'],
  supervisor_approved: ['synced', 'draft'],
  synced: ['locked', 'draft'],
  locked: ['draft'],
};

export class WorkflowError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

interface TimesheetRow {
  id: string;
  company_id: string;
  employee_id: string;
  work_date: string;
  status: TimesheetStatus;
  total_paid_minutes: number;
}

export interface TransitionInput {
  timesheetId: string;
  actorUserId: string | null;
  reason?: string | null;
}

async function moveTo(
  db: Db,
  input: TransitionInput & {
    to: TimesheetStatus;
    action: 'confirm' | 'approve' | 'reject' | 'lock' | 'reopen';
    stampColumn?: string;
    actorColumn?: string;
  },
): Promise<TimesheetRow> {
  const sheet = await oneOrFail<TimesheetRow>(
    db,
    `select id, company_id, employee_id, work_date, status, total_paid_minutes
       from timesheet where id = $1`,
    [input.timesheetId],
    'Timesheet',
  );

  if (sheet.status === input.to) return sheet; // idempotent: already there

  if (!TRANSITIONS[sheet.status].includes(input.to)) {
    throw new WorkflowError(
      `A timesheet that is "${sheet.status}" cannot move to "${input.to}".`,
      'illegal_transition',
    );
  }

  if (input.action === 'reopen' && !input.reason?.trim()) {
    throw new WorkflowError(
      'Reopening a locked timesheet requires a reason.',
      'reason_required',
    );
  }

  return withTransaction(
    db,
    async (tx) => {
      const stamps = input.stampColumn
        ? `, ${input.stampColumn} = now(), ${input.actorColumn} = $3`
        : '';

      const params: unknown[] = [input.timesheetId, input.to];
      if (input.stampColumn) params.push(input.actorUserId);

      const updated = await one<TimesheetRow>(
        tx,
        `update timesheet set status = $2${stamps}
          where id = $1
          returning id, company_id, employee_id, work_date, status, total_paid_minutes`,
        params,
      );

      await tx.query(
        `insert into approval (
           company_id, timesheet_id, action, from_status, to_status, actor_user_id, reason
         ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          sheet.company_id,
          sheet.id,
          input.action,
          sheet.status,
          input.to,
          input.actorUserId,
          input.reason ?? null,
        ],
      );

      return updated!;
    },
    { actorUserId: input.actorUserId, reason: input.reason ?? null },
  );
}

/** Worker taps "these hours are right". */
export const confirmTimesheet = (db: Db, input: TransitionInput) =>
  moveTo(db, {
    ...input,
    to: 'worker_confirmed',
    action: 'confirm',
    stampColumn: 'worker_confirmed_at',
    actorColumn: 'worker_confirmed_by',
  });

/** Supervisor approves the day. This is what makes it eligible for Odoo. */
export const approveTimesheet = (db: Db, input: TransitionInput) =>
  moveTo(db, {
    ...input,
    to: 'supervisor_approved',
    action: 'approve',
    stampColumn: 'supervisor_approved_at',
    actorColumn: 'supervisor_approved_by',
  });

/** Sends it back for fixing. */
export const rejectTimesheet = (db: Db, input: TransitionInput) =>
  moveTo(db, { ...input, to: 'draft', action: 'reject' });

/** Called by the sync worker once Odoo has the record. */
export const markTimesheetSynced = (db: Db, input: TransitionInput) =>
  moveTo(db, { ...input, to: 'synced', action: 'approve' });

export const lockTimesheet = (db: Db, input: TransitionInput) =>
  moveTo(db, {
    ...input,
    to: 'locked',
    action: 'lock',
    stampColumn: 'locked_at',
    actorColumn: 'locked_by',
  });

/** Payroll reopening a locked record. Reason is mandatory, in code and in SQL. */
export const reopenTimesheet = (db: Db, input: TransitionInput) =>
  moveTo(db, { ...input, to: 'draft', action: 'reopen' });

// --- corrections ------------------------------------------------------------

export interface CorrectEventInput {
  eventId: string;
  actorUserId: string;
  reason: string;
  changes: {
    deviceTime?: string;
    jobId?: string | null;
    workActivityId?: string | null;
  };
  now?: Date;
}

export interface CorrectionResult {
  originalEventId: string;
  replacementEventId: string;
  timesheetId: string;
  changedFields: string[];
}

/**
 * Corrects an event by superseding it.
 *
 * The original row stays exactly as the worker's phone recorded it, marked
 * voided with a reason and pointed at its replacement. A correction row is
 * written per changed field carrying the before and after values, which is
 * what acceptance criterion 9 asks for.
 */
export async function correctEvent(
  db: Db,
  input: CorrectEventInput,
): Promise<CorrectionResult> {
  const { eventId, actorUserId, reason, changes, now = new Date() } = input;

  if (!reason?.trim()) {
    throw new WorkflowError('A correction requires a reason.', 'reason_required');
  }

  const original = await oneOrFail<{
    id: string;
    company_id: string;
    employee_id: string;
    timesheet_id: string | null;
    job_id: string | null;
    work_activity_id: string | null;
    event_type: AttendanceEventType;
    device_time: Date | string;
    latitude: number | null;
    longitude: number | null;
    gps_accuracy_m: number | null;
    inside_geofence: boolean | null;
    distance_from_site_m: number | null;
    outside_reason: string | null;
    source_device_id: string | null;
    voided_at: Date | null;
  }>(
    db,
    `select id, company_id, employee_id, timesheet_id, job_id, work_activity_id,
            event_type, device_time, latitude, longitude, gps_accuracy_m,
            inside_geofence, distance_from_site_m, outside_reason,
            source_device_id, voided_at
       from attendance_event where id = $1`,
    [eventId],
    'Attendance event',
  );

  if (original.voided_at) {
    throw new WorkflowError(
      'That event has already been corrected. Correct its replacement instead.',
      'already_voided',
    );
  }

  const timesheetId = original.timesheet_id;
  if (!timesheetId) {
    throw new WorkflowError('Event is not attached to a timesheet.', 'no_timesheet');
  }

  const sheet = await oneOrFail<{ status: TimesheetStatus }>(
    db,
    'select status from timesheet where id = $1',
    [timesheetId],
    'Timesheet',
  );
  if (sheet.status === 'locked') {
    throw new WorkflowError(
      'This timesheet is locked. Reopen it with a reason before correcting.',
      'timesheet_locked',
    );
  }

  const originalDeviceTime =
    original.device_time instanceof Date
      ? original.device_time.toISOString()
      : String(original.device_time);

  const next = {
    deviceTime: changes.deviceTime ?? originalDeviceTime,
    jobId: changes.jobId !== undefined ? changes.jobId : original.job_id,
    workActivityId:
      changes.workActivityId !== undefined
        ? changes.workActivityId
        : original.work_activity_id,
  };

  const changedFields: Array<{ field: string; from: string | null; to: string | null }> = [];
  if (Date.parse(next.deviceTime) !== Date.parse(originalDeviceTime)) {
    changedFields.push({ field: 'device_time', from: originalDeviceTime, to: next.deviceTime });
  }
  if (next.jobId !== original.job_id) {
    changedFields.push({ field: 'job_id', from: original.job_id, to: next.jobId });
  }
  if (next.workActivityId !== original.work_activity_id) {
    changedFields.push({
      field: 'work_activity_id',
      from: original.work_activity_id,
      to: next.workActivityId,
    });
  }

  if (changedFields.length === 0) {
    throw new WorkflowError('Nothing was changed.', 'no_changes');
  }

  return withTransaction(
    db,
    async (tx) => {
      const replacement = await one<{ id: string }>(
        tx,
        `insert into attendance_event (
           company_id, employee_id, timesheet_id, job_id, work_activity_id,
           event_type, device_time, server_time,
           latitude, longitude, gps_accuracy_m, inside_geofence,
           distance_from_site_m, outside_reason,
           clock_method, was_offline, source_device_id, idempotency_key, created_by
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'supervisor',false,$15,$16,$17
         ) returning id`,
        [
          original.company_id,
          original.employee_id,
          timesheetId,
          next.jobId,
          next.workActivityId,
          original.event_type,
          next.deviceTime,
          now.toISOString(),
          // Location carries over from the original: it is where the worker
          // actually was. A corrected *time* does not invent a new position,
          // and blanking it would destroy evidence.
          original.latitude,
          original.longitude,
          original.gps_accuracy_m,
          original.inside_geofence,
          original.distance_from_site_m,
          original.outside_reason,
          original.source_device_id,
          newIdempotencyKey('correction'),
          actorUserId,
        ],
      );

      await tx.query(
        `update attendance_event
            set voided_at = now(), voided_by = $2, void_reason = $3, superseded_by = $4
          where id = $1`,
        [eventId, actorUserId, reason, replacement!.id],
      );

      for (const change of changedFields) {
        await tx.query(
          `insert into correction (
             company_id, timesheet_id, target_table, target_id, field,
             original_value, new_value, reason, status, requested_by, reviewed_by, reviewed_at
           ) values ($1,$2,'attendance_event',$3,$4,$5,$6,$7,'approved',$8,$8,now())`,
          [
            original.company_id,
            timesheetId,
            eventId,
            change.field,
            change.from,
            change.to,
            reason,
            actorUserId,
          ],
        );
      }

      return {
        originalEventId: eventId,
        replacementEventId: replacement!.id,
        timesheetId,
        changedFields: changedFields.map((c) => c.field),
      };
    },
    { actorUserId, reason },
  ).then(async (result) => {
    await rebuildTimesheet(db, timesheetId, { now, actorUserId });
    return result;
  });
}

export interface VoidEventInput {
  eventId: string;
  actorUserId: string;
  reason: string;
  now?: Date;
}

/**
 * Removes an event with no replacement — a supervisor/admin decided it
 * should never have been recorded at all (a duplicate manual entry, a
 * mis-clock nobody wants to "correct" into something else). Same
 * append-only mechanics as a correction, just without the second insert.
 */
export async function voidEvent(
  db: Db,
  input: VoidEventInput,
): Promise<{ eventId: string; timesheetId: string | null }> {
  const { eventId, actorUserId, reason, now = new Date() } = input;

  if (!reason?.trim()) {
    throw new WorkflowError('Voiding an event requires a reason.', 'reason_required');
  }

  const original = await oneOrFail<{
    id: string;
    timesheet_id: string | null;
    voided_at: Date | null;
  }>(
    db,
    'select id, timesheet_id, voided_at from attendance_event where id = $1',
    [eventId],
    'Attendance event',
  );

  if (original.voided_at) {
    throw new WorkflowError('That event has already been corrected or removed.', 'already_voided');
  }

  if (original.timesheet_id) {
    const sheet = await oneOrFail<{ status: TimesheetStatus }>(
      db,
      'select status from timesheet where id = $1',
      [original.timesheet_id],
      'Timesheet',
    );
    if (sheet.status === 'locked') {
      throw new WorkflowError(
        'This timesheet is locked. Reopen it with a reason before removing an event.',
        'timesheet_locked',
      );
    }
  }

  await withTransaction(
    db,
    async (tx) => {
      await tx.query(
        `update attendance_event set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1`,
        [eventId, actorUserId, reason],
      );
    },
    { actorUserId, reason },
  );

  if (original.timesheet_id) {
    await rebuildTimesheet(db, original.timesheet_id, { now, actorUserId });
  }

  return { eventId, timesheetId: original.timesheet_id };
}

export interface AddMissingEventInput {
  companyId: string;
  employeeId: string;
  timesheetId: string;
  eventType: AttendanceEventType;
  deviceTime: string;
  jobId?: string | null;
  workActivityId?: string | null;
  actorUserId: string;
  reason: string;
  now?: Date;
}

/**
 * Supervisor filling in a clock event the worker never made.
 *
 * Written with clock_method 'supervisor' and no GPS, which is exactly how it
 * should look to anyone auditing later: this time was entered by a person, not
 * captured from a device.
 */
export async function addMissingEvent(
  db: Db,
  input: AddMissingEventInput,
): Promise<{ eventId: string }> {
  if (!input.reason?.trim()) {
    throw new WorkflowError('Adding a missing time requires a reason.', 'reason_required');
  }

  const now = input.now ?? new Date();

  return withTransaction(
    db,
    async (tx) => {
      const inserted = await one<{ id: string }>(
        tx,
        `insert into attendance_event (
           company_id, employee_id, timesheet_id, job_id, work_activity_id,
           event_type, device_time, server_time, clock_method, was_offline,
           idempotency_key, created_by, outside_reason
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'supervisor',false,$9,$10,$11)
         returning id`,
        [
          input.companyId,
          input.employeeId,
          input.timesheetId,
          input.jobId ?? null,
          input.workActivityId ?? null,
          input.eventType,
          input.deviceTime,
          now.toISOString(),
          newIdempotencyKey('supervisor'),
          input.actorUserId,
          input.reason,
        ],
      );

      await tx.query(
        `insert into correction (
           company_id, timesheet_id, target_table, target_id, field,
           original_value, new_value, reason, status, requested_by, reviewed_by, reviewed_at
         ) values ($1,$2,'attendance_event',$3,$4,null,$5,$6,'approved',$7,$7,now())`,
        [
          input.companyId,
          input.timesheetId,
          inserted!.id,
          input.eventType,
          input.deviceTime,
          input.reason,
          input.actorUserId,
        ],
      );

      return { eventId: inserted!.id };
    },
    { actorUserId: input.actorUserId, reason: input.reason },
  ).then(async (result) => {
    await rebuildTimesheet(db, input.timesheetId, { now, actorUserId: input.actorUserId });
    return result;
  });
}
