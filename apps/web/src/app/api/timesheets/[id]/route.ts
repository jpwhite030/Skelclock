/**
 * POST /api/timesheets/:id — approval-ladder actions.
 *
 * One route rather than five, because the guard rails are identical: resolve
 * the caller, check the action is one their role may perform, then let the
 * workflow layer decide whether the transition itself is legal.
 */

import {
  approveTimesheet,
  confirmTimesheet,
  enqueueTimesheetPush,
  lockTimesheet,
  rejectTimesheet,
  reopenTimesheet,
  WorkflowError,
  one,
} from '@skelclock/server';

import { db } from '../../../../lib/db';
import { authErrorResponse, requireCaller, type Caller } from '../../../../lib/auth';

type Action = 'confirm' | 'approve' | 'reject' | 'lock' | 'reopen';

const PERMITTED: Record<Action, Caller['role'][]> = {
  confirm: ['worker', 'supervisor', 'admin'],
  approve: ['supervisor', 'admin'],
  reject: ['supervisor', 'admin'],
  lock: ['admin'],
  reopen: ['admin'],
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    const { id: timesheetId } = await context.params;

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      reason?: string;
    };
    const action = body.action as Action | undefined;

    if (!action || !(action in PERMITTED)) {
      return Response.json(
        { error: `action must be one of: ${Object.keys(PERMITTED).join(', ')}` },
        { status: 400 },
      );
    }
    if (!PERMITTED[action].includes(caller.role)) {
      return Response.json({ error: 'You do not have access to this.' }, { status: 403 });
    }

    // Scope check: the timesheet must belong to the caller's company, and a
    // worker may only ever confirm their own day.
    const sheet = await one<{ employee_id: string; company_id: string }>(
      db,
      'select employee_id, company_id from timesheet where id = $1',
      [timesheetId],
    );
    if (!sheet || sheet.company_id !== caller.companyId) {
      return Response.json({ error: 'Timesheet not found.' }, { status: 404 });
    }
    if (caller.role === 'worker' && sheet.employee_id !== caller.employeeId) {
      return Response.json({ error: 'You can only confirm your own hours.' }, { status: 403 });
    }

    const input = {
      timesheetId,
      actorUserId: caller.appUserId,
      reason: body.reason ?? null,
    };

    const result = await {
      confirm: confirmTimesheet,
      approve: approveTimesheet,
      reject: rejectTimesheet,
      lock: lockTimesheet,
      reopen: reopenTimesheet,
    }[action](db, input);

    // Approval is what makes a day eligible for Odoo, so queue it now.
    if (action === 'approve') {
      await enqueueTimesheetPush(db, { companyId: caller.companyId, timesheetId });
    }

    return Response.json({ id: result.id, status: result.status });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    // Workflow errors are the user's problem to fix, not a server fault —
    // "you cannot approve a locked timesheet" deserves a readable 409.
    if (error instanceof WorkflowError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }

    console.error('timesheet action failed', error);
    return Response.json({ error: 'Could not update that timesheet.' }, { status: 500 });
  }
}
