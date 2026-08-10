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
  /**
   * Company policy, resolved here for the same reason operating hours are:
   * the phone has to give the same answer the server would. Minutes a worker
   * must stay inside the fence before an automatic arrival is trusted.
   *
   * Optional, defaulting to "rule off", because the phone and the server do
   * not ship together and never will — one goes through App Store review and
   * the other goes out when we press deploy. A required field here means a
   * build that reaches a server older than itself fails to parse the job list
   * at all, and a worker whose job list will not load cannot clock on by any
   * method. Degrading to the behaviour that server already has is the only
   * safe reading of a field it has never heard of.
   */
  geofenceMinDwellMinutes: z.number().optional().default(0),
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
