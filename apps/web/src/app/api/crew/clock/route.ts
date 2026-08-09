/**
 * POST /api/crew/clock — one tap from a supervisor, one event per member.
 *
 * Authorisation is per-crew, not just per-role: a supervisor may only clock
 * a crew they actually lead. Everything downstream (state machine per
 * member, site exclusions, idempotency) is the ordinary ingest pipeline —
 * clockCrew is a fan-out, not a bypass, which is why one member being
 * already clocked in cannot fail the other five.
 */

import { crewClockRequestSchema, crewClockResponseSchema } from '@skelclock/contracts';
import { clockCrew, one } from '@skelclock/server';

import { db } from '../../../../lib/db';
import { authErrorResponse, requireCaller, requireRole } from '../../../../lib/auth';

export async function POST(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    requireRole(caller, 'supervisor', 'admin');

    const body = crewClockRequestSchema.parse(await request.json());

    const crew = await one<{ id: string; supervisor_employee_id: string | null }>(
      db,
      'select id, supervisor_employee_id from crew where id = $1 and company_id = $2 and active',
      [body.crewId, caller.companyId],
    );
    if (!crew) {
      return Response.json({ error: 'That crew is not available.' }, { status: 404 });
    }
    if (caller.role !== 'admin' && crew.supervisor_employee_id !== caller.employeeId) {
      return Response.json({ error: 'This is not one of your crews.' }, { status: 403 });
    }

    const result = await clockCrew(db, {
      companyId: caller.companyId,
      crewId: body.crewId,
      eventType: body.eventType,
      actorUserId: caller.appUserId,
      deviceTime: body.deviceTime,
      jobId: body.jobId ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      gpsAccuracyM: body.gpsAccuracyM ?? null,
      excludeEmployeeIds: body.excludeEmployeeIds,
      deviceId: body.deviceId ?? null,
    });

    return Response.json(
      crewClockResponseSchema.parse({
        attempted: result.attempted,
        succeeded: result.succeeded,
        skipped: result.skipped,
        outcomes: result.outcomes.map((o) => ({
          employeeId: o.employeeId,
          employeeName: o.employeeName,
          status: o.outcome.status,
          message: o.outcome.status === 'rejected' ? o.outcome.message : null,
        })),
      }),
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof Error && error.name === 'ZodError') {
      return Response.json({ error: 'Malformed crew clock request.' }, { status: 400 });
    }
    console.error('crew clock failed', error);
    return Response.json({ error: 'Could not clock the crew.' }, { status: 500 });
  }
}
