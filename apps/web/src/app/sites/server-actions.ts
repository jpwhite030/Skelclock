'use server';

/**
 * Server action for the site geofence map.
 *
 * Dragging a pin goes through here rather than the JSON API, same reasoning
 * as the sync screen's actions: a server component page already has the
 * session, so there is no token to ship to the browser.
 */

import { revalidatePath } from 'next/cache';

import {
  addSiteExclusion,
  canManageEmployee,
  removeSiteExclusion,
  SiteError,
  updateSiteLocation,
  updateSiteOperatingHours,
} from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface SaveLocationResult {
  ok: boolean;
  message: string;
}

async function requireSiteEditor(): Promise<
  { ok: true; companyId: string; appUserId: string } | { ok: false; result: SaveLocationResult }
> {
  const session = await getDashboardSession();
  if (!session || (session.role !== 'admin' && session.role !== 'supervisor')) {
    return { ok: false, result: { ok: false, message: 'You do not have access to change sites.' } };
  }
  if (!session.appUserId) {
    return {
      ok: false,
      result: { ok: false, message: 'Development mode has no user to attribute this to.' },
    };
  }
  return { ok: true, companyId: session.companyId, appUserId: session.appUserId };
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

export async function saveSiteHours(args: {
  siteId: string;
  start: string | null;
  end: string | null;
}): Promise<SaveLocationResult> {
  const access = await requireSiteEditor();
  if (!access.ok) return access.result;

  try {
    await updateSiteOperatingHours(db, { companyId: access.companyId, ...args });
    revalidatePath('/sites');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SiteError ? error.message : 'Could not save operating hours.',
    };
  }
}

export async function excludeEmployeeFromSite(args: {
  employeeId: string;
  siteId: string;
  reason: string;
}): Promise<SaveLocationResult> {
  const access = await requireSiteEditor();
  if (!access.ok) return access.result;

  const session = await getDashboardSession();
  const allowed = await canManageEmployee(db, {
    role: session!.role,
    callerEmployeeId: session!.employeeId,
    targetEmployeeId: args.employeeId,
  });
  if (!allowed) {
    return { ok: false, message: 'This employee is not one of your reports.' };
  }

  try {
    await addSiteExclusion(db, { companyId: access.companyId, createdBy: access.appUserId, ...args });
    revalidatePath('/sites');
    return { ok: true, message: 'Excluded.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SiteError ? error.message : 'Could not add the exclusion.',
    };
  }
}

export async function removeExclusion(exclusionId: string): Promise<SaveLocationResult> {
  const access = await requireSiteEditor();
  if (!access.ok) return access.result;

  await removeSiteExclusion(db, { companyId: access.companyId, exclusionId });
  revalidatePath('/sites');
  return { ok: true, message: 'Removed.' };
}
