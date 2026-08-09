import { z } from 'zod';

/**
 * The supervisor's crew endpoints.
 *
 *   GET  /api/crew        — the crews this caller may clock, with live state
 *   POST /api/crew/clock  — one tap, one event per member
 *
 * A worker gets 403 from both; whether the crew screen is even offered is
 * decided by `role` on the home payload, but the server is the enforcement.
 */

export const crewMemberSchema = z.object({
  employeeId: z.string(),
  fullName: z.string(),
  /** Live, from the same state machine as everything else. */
  clockState: z.enum(['off', 'working', 'on_break']),
  hoursWorkedLabel: z.string().nullable(),
});

export const crewSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(crewMemberSchema),
});

export const crewsResponseSchema = z.array(crewSchema);

export const crewClockRequestSchema = z.object({
  crewId: z.string(),
  eventType: z.enum(['clock_in', 'clock_out']),
  /** Required for clock_in in practice — without it every member lands an
   * unassigned_job exception — but the server does not hard-refuse. */
  jobId: z.string().nullable().optional(),
  /** Members the supervisor unticked — not here today. */
  excludeEmployeeIds: z.array(z.string()).optional(),
  deviceTime: z.string().optional(),
  /** The supervisor's own position stands in for the crew's. */
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  gpsAccuracyM: z.number().nullable().optional(),
  deviceId: z.string().nullable().optional(),
});

export const crewClockResponseSchema = z.object({
  attempted: z.number(),
  succeeded: z.number(),
  skipped: z.number(),
  outcomes: z.array(
    z.object({
      employeeId: z.string(),
      employeeName: z.string(),
      status: z.enum(['created', 'duplicate', 'rejected']),
      /** Present on rejections — "Dean is already clocked in." */
      message: z.string().nullable(),
    }),
  ),
});

export type CrewDto = z.infer<typeof crewSchema>;
export type CrewMemberDto = z.infer<typeof crewMemberSchema>;
export type CrewClockRequestDto = z.infer<typeof crewClockRequestSchema>;
export type CrewClockResponseDto = z.infer<typeof crewClockResponseSchema>;
