'use server';

/**
 * Server action for the site geofence map.
 *
 * Dragging a pin goes through here rather than the JSON API, same reasoning
 * as the sync screen's actions: a server component page already has the
 * session, so there is no token to ship to the browser.
 */

import { revalidatePath } from 'next/cache';

import { SiteError, updateSiteLocation } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface SaveLocationResult {
  ok: boolean;
  message: string;
}

export async function saveSiteLocation(args: {
  siteId: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
}): Promise<SaveLocationResult> {
  const session = await getDashboardSession();
  if (!session || (session.role !== 'admin' && session.role !== 'supervisor')) {
    return { ok: false, message: 'You do not have access to move site pins.' };
  }

  try {
    await updateSiteLocation(db, { companyId: session.companyId, ...args });
    revalidatePath('/sites');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SiteError ? error.message : 'Could not save the new location.',
    };
  }
}
