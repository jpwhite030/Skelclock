import { workerHomeSchema } from '@skelclock/contracts';
import { getWorkerHome } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../lib/auth';

/** GET /api/home?date=YYYY-MM-DD — the worker's own day. */
export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    if (!caller.employeeId) {
      return Response.json(
        { error: 'This login is not linked to an employee record.' },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD.' }, { status: 400 });
    }

    const home = await getWorkerHome(db, {
      companyId: caller.companyId,
      employeeId: caller.employeeId,
      workDate: date,
    });

    return Response.json(workerHomeSchema.parse({ ...home, role: caller.role }), {
      // Never cached: this is live shift state.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('home failed', error);
    return Response.json({ error: 'Could not load your day.' }, { status: 500 });
  }
}
