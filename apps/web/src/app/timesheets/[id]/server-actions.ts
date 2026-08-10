'use server';

/**
 * Server actions for the timesheet correction screen.
 *
 * Same reasoning as the sites map's actions: a server component page already
 * has the session, so there is no token to ship to the browser. Every action
 * re-derives the target employee from the database row itself — an eventId
 * or timesheetId the client already had access to render — rather than
 * trusting whatever employeeId the form happened to submit, so a supervisor
 * cannot widen their own scope by editing hidden form fields.
 */

import { revalidatePath } from 'next/cache';

import type { AttendanceEventType } from '@skelclock/core';
import {
  addMissingEvent,
  canManageEmployee,
  correctEvent,
  one,
  voidEvent,
  WorkflowError,
} from '@skelclock/server';

import { db } from '../../../lib/db';
import { getDashboardSession } from '../../../lib/session';

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function requireEditAccess(
  targetEmployeeId: string,
): Promise<{ ok: true; actorUserId: string } | { ok: false; result: ActionResult }> {
  const session = await getDashboardSession();
  if (!session || (session.role !== 'admin' && session.role !== 'supervisor')) {
    return { ok: false, result: { ok: false, message: 'You do not have access to edit hours.' } };
  }
  if (!session.appUserId) {
    return { ok: false, result: { ok: false, message: 'Development mode has no user to attribute this to.' } };
  }
  const allowed = await canManageEmployee(db, {
    role: session.role,
    callerEmployeeId: session.employeeId,
    targetEmployeeId,
  });
  if (!allowed) {
    return { ok: false, result: { ok: false, message: 'This employee is not one of your reports.' } };
  }
  return { ok: true, actorUserId: session.appUserId };
}

export async function correctAttendanceEvent(args: {
  eventId: string;
  timesheetId: string;
  deviceTime?: string;
  jobId?: string | null;
  workActivityId?: string | null;
  reason: string;
}): Promise<ActionResult> {
  const owner = await one<{ employee_id: string }>(
    db,
    'select employee_id from attendance_event where id = $1',
    [args.eventId],
  );
  if (!owner) return { ok: false, message: 'Event not found.' };

  const access = await requireEditAccess(owner.employee_id);
  if (!access.ok) return access.result;

  try {
    await correctEvent(db, {
      eventId: args.eventId,
      actorUserId: access.actorUserId,
      reason: args.reason,
      changes: {
        deviceTime: args.deviceTime,
        jobId: args.jobId,
        workActivityId: args.workActivityId,
      },
    });
    revalidatePath(`/timesheets/${args.timesheetId}`);
    return { ok: true, message: 'Corrected.' };
  } catch (error) {
    return { ok: false, message: error instanceof WorkflowError ? error.message : 'Could not correct that event.' };
  }
}

export async function voidAttendanceEvent(args: {
  eventId: string;
  timesheetId: string;
  reason: string;
}): Promise<ActionResult> {
  const owner = await one<{ employee_id: string }>(
    db,
    'select employee_id from attendance_event where id = $1',
    [args.eventId],
  );
  if (!owner) return { ok: false, message: 'Event not found.' };

  const access = await requireEditAccess(owner.employee_id);
  if (!access.ok) return access.result;

  try {
    await voidEvent(db, { eventId: args.eventId, actorUserId: access.actorUserId, reason: args.reason });
    revalidatePath(`/timesheets/${args.timesheetId}`);
    return { ok: true, message: 'Removed.' };
  } catch (error) {
    return { ok: false, message: error instanceof WorkflowError ? error.message : 'Could not remove that event.' };
  }
}

export async function addMissingAttendanceEvent(args: {
  timesheetId: string;
  eventType: AttendanceEventType;
  deviceTime: string;
  jobId?: string | null;
  workActivityId?: string | null;
  reason: string;
}): Promise<ActionResult> {
  const sheet = await one<{ company_id: string; employee_id: string }>(
    db,
    'select company_id, employee_id from timesheet where id = $1',
    [args.timesheetId],
  );
  if (!sheet) return { ok: false, message: 'Timesheet not found.' };

  const access = await requireEditAccess(sheet.employee_id);
  if (!access.ok) return access.result;

  try {
    await addMissingEvent(db, {
      companyId: sheet.company_id,
      employeeId: sheet.employee_id,
      timesheetId: args.timesheetId,
      eventType: args.eventType,
      deviceTime: args.deviceTime,
      jobId: args.jobId,
      workActivityId: args.workActivityId,
      actorUserId: access.actorUserId,
      reason: args.reason,
    });
    revalidatePath(`/timesheets/${args.timesheetId}`);
    return { ok: true, message: 'Added.' };
  } catch (error) {
    return { ok: false, message: error instanceof WorkflowError ? error.message : 'Could not add that event.' };
  }
}
