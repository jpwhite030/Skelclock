/**
 * GET /api/crew — the crews this caller may clock, with each member's live
 * state.
 *
 * A supervisor sees the crews they lead; an admin sees every crew. Live
 * state comes from getWorkingNow — the same state machine as every other
 * screen — so the crew sheet can never disagree with the wall board.
 */

import { crewsResponseSchema } from '@skelclock/contracts';
import { getWorkingNow } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller, requireRole } from '../../../lib/auth';

export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    requireRole(caller, 'supervisor', 'admin');

    const { rows: crews } = await db.query<{ id: string; name: string }>(
      `select id, name from crew
        where company_id = $1 and active
          and ($2::uuid is null or supervisor_employee_id = $2)
        order by name`,
      [caller.companyId, caller.role === 'admin' ? null : caller.employeeId],
    );

    const working = new Map(
      (await getWorkingNow(db, { companyId: caller.companyId })).map((r) => [r.employeeId, r]),
    );

    const out = [];
    for (const crew of crews) {
      const { rows: members } = await db.query<{ employee_id: string; full_name: string }>(
        `select cm.employee_id, e.full_name
           from crew_member cm
           join employee e on e.id = cm.employee_id
          where cm.crew_id = $1 and cm.active and e.active
          order by e.full_name`,
        [crew.id],
      );

      out.push({
        id: crew.id,
        name: crew.name,
        members: members.map((m) => {
          const live = working.get(m.employee_id);
          return {
            employeeId: m.employee_id,
            fullName: m.full_name,
            clockState: live ? (live.onBreak ? ('on_break' as const) : ('working' as const)) : ('off' as const),
            hoursWorkedLabel: live?.hoursWorkedLabel ?? null,
          };
        }),
      });
    }

    return Response.json(crewsResponseSchema.parse(out), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('crew list failed', error);
    return Response.json({ error: 'Could not load your crews.' }, { status: 500 });
  }
}
