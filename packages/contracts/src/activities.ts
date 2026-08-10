import { z } from 'zod';

/** GET /api/activities response entries. Mirrors apps/web/src/app/api/activities/route.ts. */
export const activitySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  isTravel: z.boolean(),
  isPaid: z.boolean(),
});

export const activitiesResponseSchema = z.array(activitySchema);

export type ActivityDto = z.infer<typeof activitySchema>;
