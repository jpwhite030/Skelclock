import { z } from 'zod';

/** Mirrors TimesheetStatus in packages/core/src/types.ts — see the note in events.ts. */
export const timesheetStatusSchema = z.enum([
  'draft',
  'worker_confirmed',
  'supervisor_approved',
  'synced',
  'locked',
]);

/** POST /api/timesheets/:id response (confirm/approve/reject/lock/reopen). */
export const timesheetActionResponseSchema = z.object({
  id: z.string(),
  status: timesheetStatusSchema,
});

export type TimesheetActionResponseDto = z.infer<typeof timesheetActionResponseSchema>;
