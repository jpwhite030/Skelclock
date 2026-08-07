import { pendingSuggestionsResponseSchema } from '@skelclock/contracts';
import { listPendingSuggestions } from '@skelclock/server';

import { db } from '../../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../../lib/auth';

/**
 * GET /api/events/suggested — this worker's geofence-raised events awaiting
 * confirmation. Phase 3: never authoritative until the worker accepts one.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    if (!caller.employeeId) {
      return Response.json([], { headers: { 'Cache-Control': 'no-store' } });
    }

    const suggestions = await listPendingSuggestions(db, {
      companyId: caller.companyId,
      employeeId: caller.employeeId,
    });

    return Response.json(
      pendingSuggestionsResponseSchema.parse(
        suggestions.map((s) => ({
          id: s.id,
          eventType: s.eventType,
          jobId: s.jobId,
          siteName: s.siteName,
          deviceTime: s.deviceTime,
        })),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('pending suggestions failed', error);
    return Response.json({ error: 'Could not load pending suggestions.' }, { status: 500 });
  }
}
