import { z } from 'zod';

/** GET /api/home response. Mirrors WorkerHome in packages/server/src/queries.ts. */
export const workerHomeSchema = z.object({
  employeeId: z.string(),
  employeeName: z.string(),
  workDate: z.string(),
  clockState: z.enum(['off', 'working', 'on_break']),
  timesheetId: z.string().nullable(),
  timesheetStatus: z.string().nullable(),
  assignedJob: z
    .object({
      id: z.string(),
      jobNumber: z.string(),
      customerName: z.string().nullable(),
      siteName: z.string().nullable(),
      siteAddress: z.string().nullable(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      geofenceRadiusM: z.number(),
      scheduledStart: z.string().nullable(),
    })
    .nullable(),
  currentJobId: z.string().nullable(),
  currentActivityId: z.string().nullable(),
  minutesWorked: z.number(),
  hoursWorkedLabel: z.string(),
  breakMinutes: z.number(),
  /** Minutes deducted by the company's auto-lunch policy — zero when it
   * didn't apply. Shown so a worker's paid figure never shrinks unexplained. */
  autoLunchMinutes: z.number(),
  pendingSyncCount: z.number(),
});

export type WorkerHomeDto = z.infer<typeof workerHomeSchema>;
