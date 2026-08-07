import { confirmSuggestionRequestSchema, suggestionActionResponseSchema } from '@skelclock/contracts';
import { confirmSuggestedEvent, DbError, SuggestionError } from '@skelclock/server';

import { db } from '../../../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../../../lib/auth';

/**
 * POST /api/events/:id/confirm — worker accepts a geofence-raised suggestion.
 * Scoped to the caller's own employee record; there is no supervisor path
 * here, this is a worker confirming their own arrival.
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

    // Body is optional: a plain confirm has nothing to send. jobId is only
    // meaningful when the suggestion was ambiguous (two sites at once).
    const rawBody = await request.json().catch(() => ({}));
    const body = confirmSuggestionRequestSchema.parse(rawBody);

    const result = await confirmSuggestedEvent(db, {
      companyId: caller.companyId,
      employeeId: caller.employeeId,
      eventId,
      actorUserId: caller.appUserId,
      jobId: body.jobId,
    });

    return Response.json(
      suggestionActionResponseSchema.parse({ status: 'confirmed', eventId: result.eventId }),
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

    console.error('confirm suggestion failed', error);
    return Response.json({ error: 'Could not confirm that suggestion.' }, { status: 500 });
  }
}
