/**
 * Device check-in.
 *
 * Wires up the `device` table migration 0001 already prepared for this
 * ("Needed for push notifications and for the Phase 3 permission-health
 * check") but that nothing wrote to until now. One row per (app_user,
 * device), upserted on every foreground / permission check — so a stale
 * "granted" from install day can't quietly stand in for a permission the OS
 * downgraded behind the app's back weeks later.
 */

import type { Db } from './db.js';

export interface DeviceCheckinInput {
  appUserId: string;
  deviceId: string;
  platform?: string | null;
  appVersion?: string | null;
  locationPermission?: string | null;
  pushToken?: string | null;
}

export async function checkinDevice(db: Db, input: DeviceCheckinInput): Promise<void> {
  await db.query(
    `insert into device (
       company_id, app_user_id, device_id, platform, app_version,
       location_permission, push_token, last_seen_at
     )
     select u.company_id, $1, $2, $3, $4, $5, $6, now()
       from app_user u where u.id = $1
     on conflict (app_user_id, device_id)
     do update set platform             = excluded.platform,
                   app_version           = excluded.app_version,
                   location_permission   = excluded.location_permission,
                   -- A check-in with no token must not erase a token a
                   -- previous check-in registered — permission prompts race
                   -- app startup, and the sweep needs the last good one.
                   push_token            = coalesce(excluded.push_token, device.push_token),
                   last_seen_at          = now()`,
    [
      input.appUserId,
      input.deviceId,
      input.platform ?? null,
      input.appVersion ?? null,
      input.locationPermission ?? null,
      input.pushToken ?? null,
    ],
  );
}
