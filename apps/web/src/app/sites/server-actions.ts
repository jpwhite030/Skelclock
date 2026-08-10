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

// --- add a site by address ---------------------------------------------------

export interface GeocodeResult {
  label: string;
  latitude: number;
  longitude: number;
  /**
   * How exact this pin is.
   *
   *   address   the geocoder matched a street number — the pin is the property
   *   street    it matched the road only, and the pin is somewhere along it,
   *             which can be hundreds of metres from the site
   *   area      a suburb or locality centroid; useful only as a starting view
   *
   * This matters more here than in most address searches. OpenStreetMap's
   * Australian house-number coverage is patchy — "200 Crown Street Wollongong"
   * resolves to the building, while every number on Kembla Street falls back
   * to the road, because nobody has mapped that street's numbers. The search
   * gives no sign of the difference, so a street-centroid pin looks exactly
   * like an exact one, and with a default 70m fence around it the workers who
   * turn up get refused their clock-on.
   */
  precision: 'address' | 'street' | 'area';
}

/**
 * Server-side on purpose: Nominatim's usage policy requires a descriptive
 * User-Agent identifying the calling application, and a browser's own fetch
 * cannot set that header itself — only a server-side request can.
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult[]> {
  const session = await getDashboardSession();
  if (!session) return [];

  const q = query.trim();
  if (q.length < 3) return [];

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '8');
  // Without this the response carries no house_number, so an exact match and a
  // road centroid are indistinguishable — which is the whole problem.
  url.searchParams.set('addressdetails', '1');
  // SkelScaff's own sites are all AU — narrows an ambiguous street name to
  // the right country instead of the top global match.
  url.searchParams.set('countrycodes', 'au');

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'SkelClock/1.0 (site setup; matt@skelscaff.com.au)' },
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  const results = (await response.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    address?: { house_number?: string; road?: string };
  }>;

  const mapped: GeocodeResult[] = results.map((r) => ({
    label: r.display_name,
    latitude: Number(r.lat),
    longitude: Number(r.lon),
    precision: r.address?.house_number ? 'address' : r.address?.road ? 'street' : 'area',
  }));

  // Exact addresses first. Nominatim ranks by its own relevance, which happily
  // puts a road in the wrong suburb above a matching street number — searching
  // "14 Kembla Street Wollongong" returns Port Kembla and Balgownie before
  // Wollongong. Someone scanning a list picks the top one.
  const rank = { address: 0, street: 1, area: 2 } as const;
  return mapped.sort((a, b) => rank[a.precision] - rank[b.precision]);
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
