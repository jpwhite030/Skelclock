import { z } from 'zod';

/**
 * POST /api/device — a check-in so the office can eventually tell "auto-detect
 * is on but background location got silently revoked" apart from "working
 * fine". Written on every foreground/permission check, not just install.
 */
export const deviceCheckinRequestSchema = z.object({
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']).nullable().optional(),
  appVersion: z.string().nullable().optional(),
  /** Mirrors Expo's Location.PermissionStatus for the background permission. */
  locationPermission: z.enum(['granted', 'denied', 'undetermined']).nullable().optional(),
});

export const deviceCheckinResponseSchema = z.object({ status: z.literal('ok') });

export type DeviceCheckinRequestDto = z.infer<typeof deviceCheckinRequestSchema>;
export type DeviceCheckinResponseDto = z.infer<typeof deviceCheckinResponseSchema>;
