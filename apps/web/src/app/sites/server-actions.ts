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
  createSite as createSiteRecord,
  geocode,
  removeSiteExclusion,
  reverseNsw,
  SiteError,
  updateSiteLocation,
  updateSiteOperatingHours,
  type GeocodeCandidate,
} from '@skelclock/server';

export type { GeocodeCandidate } from '@skelclock/server';

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

// --- add a site by address ---------------------------------------------------

/**
 * Address search, for the "add a site" panel.
 *
 * The lookup itself lives in packages/server/src/geocode.ts, along with the
 * long explanation of why it asks the NSW address register before it asks
 * OpenStreetMap. This is only the session check and the shape the client sees.
 *
 * `near` is the map centre. It is not a nicety: street names repeat across
 * NSW, and without it a search for a Wollongong street can hand back a match
 * in Sydney. See the ranking notes in geocode.ts.
 */
export async function geocodeAddress(
  query: string,
  near?: { latitude: number; longitude: number },
): Promise<GeocodeCandidate[]> {
  const session = await getDashboardSession();
  if (!session) return [];
  return geocode(query, { limit: 8, near });
}

/**
 * What is actually at the pin.
 *
 * Dragging is the office correcting the search, and until now the correction
 * only moved the coordinates — the site kept the address string that was
 * typed. So a pin dragged two doors up still read "63 Kembla Street", and
 * every screen downstream, every timesheet and every export believed it.
 *
 * Now the drag reports the nearest property in the NSW register, and the panel
 * offers it. Empty outside NSW, or on open ground with nothing within 80m, in
 * which case the typed address stands.
 */
export async function addressAtPin(args: {
  latitude: number;
  longitude: number;
}): Promise<GeocodeCandidate | null> {
  const session = await getDashboardSession();
  if (!session) return null;
  const nearest = await reverseNsw(args.latitude, args.longitude, 80);
  return nearest[0] ?? null;
}

export interface CreateSiteResult extends SaveLocationResult {
  siteId?: string;
}

export async function createSite(args: {
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
  hoursStart: string | null;
  hoursEnd: string | null;
}): Promise<CreateSiteResult> {
  const access = await requireSiteEditor();
  if (!access.ok) return access.result;

  try {
    const site = await createSiteRecord(db, {
      companyId: access.companyId,
      name: args.name,
      address: args.address,
      latitude: args.latitude,
      longitude: args.longitude,
      geofenceRadiusM: args.geofenceRadiusM,
      operatingHoursStart: args.hoursStart,
      operatingHoursEnd: args.hoursEnd,
    });
    revalidatePath('/sites');
    return { ok: true, message: `${site.name} created.`, siteId: site.id };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SiteError ? error.message : 'Could not create the site.',
    };
  }
}
