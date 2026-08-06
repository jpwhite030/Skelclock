/**
 * Site geofence editing.
 *
 * The office needs to drop or drag a site's pin by hand — Odoo's address text
 * is not always precise enough to place a useful geofence, and `import.ts`
 * only ever sets coordinates when Odoo supplies them (see the GEO_NOTE there).
 * This is the other write path: a human adjusting the point and radius that
 * the mobile geofence in `apps/mobile/src/geofence.ts` actually watches.
 */

import { oneOrFail, type Db } from './db.js';

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteError';
  }
}

export interface SiteSummary {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  jobCount: number;
}

export async function listSites(db: Db, args: { companyId: string }): Promise<SiteSummary[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    geofence_radius_m: number;
    job_count: string;
  }>(
    `select s.id, s.name, s.address, s.latitude, s.longitude, s.geofence_radius_m,
            count(j.id) filter (where j.status in ('active', 'on_hold')) as job_count
       from site s
       left join job j on j.site_id = s.id
      where s.company_id = $1
      group by s.id
      order by s.name`,
    [args.companyId],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
    geofenceRadiusM: r.geofence_radius_m,
    jobCount: Number(r.job_count),
  }));
}

export async function updateSiteLocation(
  db: Db,
  args: {
    companyId: string;
    siteId: string;
    latitude: number;
    longitude: number;
    geofenceRadiusM?: number;
  },
): Promise<{ id: string; latitude: number; longitude: number; geofenceRadiusM: number }> {
  if (!Number.isFinite(args.latitude) || args.latitude < -90 || args.latitude > 90) {
    throw new SiteError('Latitude must be between -90 and 90.');
  }
  if (!Number.isFinite(args.longitude) || args.longitude < -180 || args.longitude > 180) {
    throw new SiteError('Longitude must be between -180 and 180.');
  }
  if (args.geofenceRadiusM !== undefined && !(args.geofenceRadiusM > 0)) {
    throw new SiteError('Geofence radius must be greater than zero.');
  }

  const row = await oneOrFail<{
    id: string;
    latitude: number;
    longitude: number;
    geofence_radius_m: number;
  }>(
    db,
    `update site
        set latitude = $3,
            longitude = $4,
            geofence_radius_m = coalesce($5, geofence_radius_m)
      where id = $1 and company_id = $2
      returning id, latitude, longitude, geofence_radius_m`,
    [args.siteId, args.companyId, args.latitude, args.longitude, args.geofenceRadiusM ?? null],
    'Site',
  );

  return {
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    geofenceRadiusM: row.geofence_radius_m,
  };
}
