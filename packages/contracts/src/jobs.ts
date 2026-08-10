import { z } from 'zod';

/** GET /api/jobs response entries. Mirrors apps/web/src/app/api/jobs/route.ts. */
export const jobSchema = z.object({
  id: z.string(),
  jobNumber: z.string(),
  customerName: z.string().nullable(),
  siteName: z.string().nullable(),
  siteAddress: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  geofenceRadiusM: z.number(),
  /** Company policy, resolved here for the same reason operating hours are:
   * the phone has to give the same answer the server would. Minutes a worker
   * must stay inside the fence before an automatic arrival is trusted. */
  geofenceMinDwellMinutes: z.number(),
  /**
   * Already resolved server-side: the site's own override when it has one,
   * else the company default, else null for no restriction. "HH:MM:SS",
   * local to the site. Lets the phone refuse an out-of-hours clock-on at
   * press time instead of a whole offline day dying at sync.
   */
  operatingHoursStart: z.string().nullable(),
  operatingHoursEnd: z.string().nullable(),
});

export const jobsResponseSchema = z.array(jobSchema);

export type JobDto = z.infer<typeof jobSchema>;
