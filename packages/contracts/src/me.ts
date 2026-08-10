import { z } from 'zod';

/**
 * GET /api/me response. Mirrors apps/web/src/app/api/me/route.ts.
 *
 * Who the bearer token belongs to, as the *server* resolves it. The phone needs
 * the employee id to stamp onto queued events, and it is deliberately not the
 * client's to decide — it comes from the app_user row the token maps to, never
 * from anything the handset asserts about itself.
 */
export const meSchema = z.object({
  appUserId: z.string(),
  employeeId: z.string().nullable(),
  fullName: z.string().nullable(),
  role: z.enum(['worker', 'supervisor', 'admin']),
});

export type MeDto = z.infer<typeof meSchema>;
