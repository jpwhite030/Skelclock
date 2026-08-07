import { suggestionActionResponseSchema } from '@skelclock/contracts';
import { DbError, dismissSuggestedEvent, SuggestionError } from '@skelclock/server';

import { db } from '../../../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../../../lib/auth';

/**
 * POST /api/events/:id/reject — worker dismisses a geofence-raised
 * suggestion ("that wasn't me" / arrived and left without actually working).
 * Voided, per the append-only guarantee - never deleted.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    const { id: eventId } = await context.params;

    if (!caller.employeeId) {
      return Response.json(
        { error: 'This login is not linked to an employee record.' },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { reason?: string };

    const result = await dismissSuggestedEvent(db, {
      companyId: caller.companyId,
      employeeId: caller.employeeId,
      eventId,
      actorUserId: caller.appUserId,
      reason: body.reason ?? '',
    });

    return Response.json(
      suggestionActionResponseSchema.parse({ status: 'dismissed', eventId: result.eventId }),
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;

    if (error instanceof SuggestionError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof DbError) {
      return Response.json({ error: 'Suggestion not found.' }, { status: 404 });
    }

    console.error('dismiss suggestion failed', error);
    return Response.json({ error: 'Could not dismiss that suggestion.' }, { status: 500 });
  }
}
