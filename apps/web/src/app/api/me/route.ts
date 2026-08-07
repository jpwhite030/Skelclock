import { meSchema } from '@skelclock/contracts';

import { authErrorResponse, requireCaller } from '../../../lib/auth';

/**
 * GET /api/me — who this token belongs to.
 *
 * The phone needs the employee id to stamp onto queued events, and it is not
 * the client's to decide: the server resolves it from the app_user row the
 * token maps to. On the Supabase path the id also rides along in the JWT's
 * user_metadata, but the app should not have to care which sign-in it used.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);

    return Response.json(
      meSchema.parse({
        appUserId: caller.appUserId,
        employeeId: caller.employeeId,
        fullName: caller.fullName,
        role: caller.role,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('me failed', error);
    return Response.json({ error: 'Could not load your account.' }, { status: 500 });
  }
}
