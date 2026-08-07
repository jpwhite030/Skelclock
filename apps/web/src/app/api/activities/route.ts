import { activitiesResponseSchema } from '@skelclock/contracts';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../lib/auth';

/** GET /api/activities — the work activity / cost code list. */
export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);

    const { rows } = await db.query<{
      id: string;
      code: string;
      name: string;
      is_travel: boolean;
      is_paid: boolean;
    }>(
      `select id, code, name, is_travel, is_paid
         from work_activity
        where company_id = $1 and active
        order by sort_order, name`,
      [caller.companyId],
    );

    return Response.json(
      activitiesResponseSchema.parse(
        rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          isTravel: r.is_travel,
          isPaid: r.is_paid,
        })),
      ),
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('activities failed', error);
    return Response.json({ error: 'Could not load activities.' }, { status: 500 });
  }
}
