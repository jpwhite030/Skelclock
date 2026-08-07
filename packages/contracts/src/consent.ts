import { z } from 'zod';

/**
 * Bumped whenever the notice text a worker sees before enabling auto-detect
 * changes materially. A worker who already consented under an older version
 * is asked again — geofence.ts on mobile checks this before trusting a
 * locally-stored "already agreed" flag.
 */
export const GEOFENCE_CONSENT_POLICY_VERSION = '2026-08-07';

/**
 * POST /api/geofence-consent — the audit trail behind the in-app notice a
 * worker agrees to (or later withdraws) before background location tracking
 * starts. Append-only server-side: see geofence_consent_event in
 * supabase/migrations/0005_geofence_v2.sql.
 */
export const geofenceConsentRequestSchema = z.object({
  action: z.enum(['granted', 'revoked']),
  policyVersion: z.string(),
  deviceId: z.string().nullable().optional(),
});

export const geofenceConsentResponseSchema = z.object({ status: z.literal('ok') });

export type GeofenceConsentRequestDto = z.infer<typeof geofenceConsentRequestSchema>;
export type GeofenceConsentResponseDto = z.infer<typeof geofenceConsentResponseSchema>;
