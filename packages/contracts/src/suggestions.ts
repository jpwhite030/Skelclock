import { z } from 'zod';

/**
 * GET /api/events/suggested response entries — geofence-raised clock events
 * awaiting the worker's confirmation. Mirrors PendingSuggestion in
 * packages/server/src/suggestions.ts.
 */
export const pendingSuggestionSchema = z.object({
  id: z.string(),
  eventType: z.enum(['clock_in', 'clock_out']),
  jobId: z.string().nullable(),
  siteName: z.string().nullable(),
  deviceTime: z.string(),
  /**
   * Present when the fix that raised this suggestion fell inside more than
   * one assigned job's fence at once. jobId is one of these, picked
   * arbitrarily — the confirm UI should offer all of them rather than
   * trusting that one.
   */
  candidateJobIds: z.array(z.string()).nullable(),
});

export const pendingSuggestionsResponseSchema = z.array(pendingSuggestionSchema);

/** POST /api/events/:id/confirm request — jobId only needed to resolve an ambiguous (multi-site) suggestion. */
export const confirmSuggestionRequestSchema = z.object({
  jobId: z.string().optional(),
});

/** POST /api/events/:id/confirm and /reject responses. */
export const suggestionActionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('confirmed'), eventId: z.string() }),
  z.object({ status: z.literal('dismissed'), eventId: z.string() }),
]);

export type PendingSuggestionDto = z.infer<typeof pendingSuggestionSchema>;
export type ConfirmSuggestionRequestDto = z.infer<typeof confirmSuggestionRequestSchema>;
export type SuggestionActionResponseDto = z.infer<typeof suggestionActionResponseSchema>;
