/**
 * Geofence consent.
 *
 * The audit trail behind the in-app notice a worker agrees to before
 * background location tracking starts, and behind withdrawing it. Append-only
 * — the same "never overwrite, always append" rule attendance_event follows —
 * so the office can show consent was given, and when, rather than just a
 * toggle's current position.
 */

import type { Db } from './db.js';

export interface GeofenceConsentInput {
  companyId: string;
  employeeId: string;
  appUserId: string;
  action: 'granted' | 'revoked';
  policyVersion: string;
  deviceId?: string | null;
}

export async function recordGeofenceConsent(db: Db, input: GeofenceConsentInput): Promise<void> {
  await db.query(
    `insert into geofence_consent_event (
       company_id, employee_id, app_user_id, action, policy_version, device_id
     ) values ($1,$2,$3,$4,$5,$6)`,
    [
      input.companyId,
      input.employeeId,
      input.appUserId,
      input.action,
      input.policyVersion,
      input.deviceId ?? null,
    ],
  );
}
