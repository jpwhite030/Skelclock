import { z } from 'zod';

/**
 * These mirror the string unions in packages/core/src/types.ts
 * (AttendanceEventType, ClockMethod). Not imported from core directly — zod
 * needs literal arrays, core only exports the erased TS type — but the two
 * must be kept in sync by hand.
 */
export const attendanceEventTypeSchema = z.enum([
  'clock_in',
  'clock_out',
  'break_start',
  'break_end',
  'job_change',
  'activity_change',
]);

export const clockMethodSchema = z.enum(['manual', 'auto_geofence', 'supervisor', 'admin']);

/**
 * POST /api/events request: one queued event as the phone submits it.
 * Mirrors ClockEventInput in packages/core/src/types.ts minus the
 * server-assigned actingUserId.
 */
export const clockEventClientSchema = z.object({
  idempotencyKey: z.string(),
  employeeId: z.string().nullable().optional(),
  eventType: attendanceEventTypeSchema,
  deviceTime: z.string(),
  jobId: z.string().nullable().optional(),
  workActivityId: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  gpsAccuracyM: z.number().nullable().optional(),
  outsideReason: z.string().nullable().optional(),
  clockMethod: clockMethodSchema,
  wasOffline: z.boolean(),
  deviceId: z.string().nullable().optional(),
  /** Auto-geofence only: every assigned job whose fence the fix fell inside. */
  candidateJobIds: z.array(z.string()).nullable().optional(),
  /** Auto-geofence only: when the phone first saw itself inside this fence.
   * Optional so an older build keeps working — it just never satisfies the
   * minimum-dwell rule and falls back to tap-to-confirm. */
  insideSince: z.string().nullable().optional(),
});

export const ingestRequestSchema = z.object({
  events: z.array(clockEventClientSchema),
});

/**
 * POST /api/events response: one outcome per submitted event, keyed by
 * idempotency key. Mirrors the wire shape apps/web/src/app/api/events/route.ts
 * maps IngestOutcome down to — deliberately narrower than the server-internal
 * IngestOutcome (no eventId/timesheetId leaves the server).
 */
export const ingestOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('created'),
    idempotencyKey: z.string(),
    insideGeofence: z.boolean().nullable(),
    distanceM: z.number().nullable(),
    /**
     * False only for an auto_geofence event that still needs a tap — every
     * other clock (manual, or a confident-enough auto_geofence one) is true.
     * Lets a caller that just submitted one event — e.g. the geofence task —
     * pick "you're clocked in" copy over "confirm your clock" without a
     * second round trip.
     */
    autoConfirmed: z.boolean(),
  }),
  z.object({
    status: z.literal('duplicate'),
    idempotencyKey: z.string(),
  }),
  z.object({
    status: z.literal('rejected'),
    idempotencyKey: z.string(),
    code: z.string(),
    message: z.string(),
  }),
]);

export const ingestResponseSchema = z.object({
  outcomes: z.array(ingestOutcomeSchema),
});

export type ClockEventClientInput = z.infer<typeof clockEventClientSchema>;
export type IngestOutcomeDto = z.infer<typeof ingestOutcomeSchema>;
export type IngestResponseDto = z.infer<typeof ingestResponseSchema>;
