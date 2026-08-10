/**
 * Site geofence editing.
 *
 * The office needs to drop or drag a site's pin by hand — Odoo's address text
 * is not always precise enough to place a useful geofence, and `import.ts`
 * only ever sets coordinates when Odoo supplies them (see the GEO_NOTE there).
 * This is the other write path: a human adjusting the point and radius that
 * the mobile geofence in `apps/mobile/src/geofence.ts` actually watches.
 */

import { one, oneOrFail, type Db } from './db.js';

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
  /** Overrides the company default when set — see settings.ts. */
  operatingHoursStart: string | null;
  operatingHoursEnd: string | null;
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
    operating_hours_start: string | null;
    operating_hours_end: string | null;
  }>(
    `select s.id, s.name, s.address, s.latitude, s.longitude, s.geofence_radius_m,
            s.operating_hours_start, s.operating_hours_end,
            count(j.id) filter (where j.status in ('active', 'on_hold')) as job_count
       from site s
       left join job j on j.site_id = s.id and j.archived_at is null
      where s.company_id = $1 and s.archived_at is null
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
    operatingHoursStart: r.operating_hours_start,
    operatingHoursEnd: r.operating_hours_end,
  }));
}

/** "HH:MM" from a <input type="time">; null on both clears the override
 * (the site then follows the company default, or no restriction at all). */
export async function updateSiteOperatingHours(
  db: Db,
  args: { companyId: string; siteId: string; start: string | null; end: string | null },
): Promise<void> {
  if ((args.start == null) !== (args.end == null)) {
    throw new SiteError('Operating hours need both a start and an end, or neither.');
  }
  await oneOrFail<{ id: string }>(
    db,
    `update site set operating_hours_start = $3, operating_hours_end = $4
      where id = $1 and company_id = $2
      returning id`,
    [args.siteId, args.companyId, args.start, args.end],
    'Site',
  );
}

// --- employee site exclusions ("lock this employee out of this site") -----

export interface SiteExclusion {
  id: string;
  employeeId: string;
  employeeName: string;
  siteId: string;
  siteName: string;
  reason: string;
  createdAt: string;
}

export async function listSiteExclusions(
  db: Db,
  args: { companyId: string },
): Promise<SiteExclusion[]> {
  const { rows } = await db.query<{
    id: string;
    employee_id: string;
    full_name: string;
    site_id: string;
    name: string;
    reason: string;
    created_at: Date | string;
  }>(
    `select x.id, x.employee_id, e.full_name, x.site_id, s.name, x.reason, x.created_at
       from employee_site_exclusion x
       join employee e on e.id = x.employee_id
       join site s on s.id = x.site_id
      where x.company_id = $1 and x.removed_at is null
      order by e.full_name, s.name`,
    [args.companyId],
  );

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.full_name,
    siteId: r.site_id,
    siteName: r.name,
    reason: r.reason,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/**
 * A hard lockout, not a suggestion — ingestEvents refuses every clock method
 * at this site for this employee while the row exists (see ingest.ts). Reuses
 * a still-present row rather than erroring on a re-add, so re-excluding
 * after a mistaken removal just updates the reason.
 */
export async function addSiteExclusion(
  db: Db,
  args: { companyId: string; employeeId: string; siteId: string; reason: string; createdBy: string },
): Promise<void> {
  if (!args.reason?.trim()) {
    throw new SiteError('A reason is required to exclude an employee from a site.');
  }
  await db.query(
    // The arbiter has to name the index's own WHERE clause. Uniqueness applies
    // to live exclusions only (migration 0008), so that predicate is part of
    // the index's identity and Postgres cannot infer it without being told.
    `insert into employee_site_exclusion (company_id, employee_id, site_id, reason, created_by)
     values ($1,$2,$3,$4,$5)
     on conflict (employee_id, site_id) where removed_at is null
     do update set reason = excluded.reason, created_by = excluded.created_by, created_at = now()`,
    [args.companyId, args.employeeId, args.siteId, args.reason, args.createdBy],
  );
}

/**
 * Lift a lockout.
 *
 * Marked removed rather than deleted. "We banned them from this site, then we
 * un-banned them" is exactly the sort of thing that gets argued about months
 * later, and the row is the only record that it happened — a DELETE here threw
 * away the reason, who set it, and when, leaving nothing to show the decision
 * was ever made.
 *
 * Already-removed rows are left alone, so a double click does not rewrite the
 * date the lockout was actually lifted.
 */
export async function removeSiteExclusion(
  db: Db,
  args: { companyId: string; exclusionId: string; removedBy?: string | null },
): Promise<void> {
  await db.query(
    `update employee_site_exclusion
        set removed_at = now(), removed_by = $3
      where id = $1 and company_id = $2 and removed_at is null`,
    [args.exclusionId, args.companyId, args.removedBy ?? null],
  );
}

/** Used by ingest.ts before a clock is ever written, and by /api/jobs to
 * keep an excluded site off the list a worker's phone even offers. */
export async function isEmployeeExcludedFromSite(
  db: Db,
  args: { employeeId: string; siteId: string },
): Promise<boolean> {
  const row = await one<{ id: string }>(
    db,
    `select id from employee_site_exclusion
      where employee_id = $1 and site_id = $2 and removed_at is null`,
    [args.employeeId, args.siteId],
  );
  return row != null;
}

/**
 * All site ids this employee is locked out of, for filtering a job list in one
 * query.
 *
 * `removed_at is null` is the whole correctness of this function since 0008
 * made lifting a lockout a soft delete. Without it a lockout that was lifted
 * keeps hiding the site forever, and the office has no way to tell — the
 * exclusion no longer appears on any screen, so the only symptom is a worker
 * who cannot see a job nobody has excluded them from.
 */
export async function excludedSiteIds(db: Db, args: { employeeId: string }): Promise<Set<string>> {
  const { rows } = await db.query<{ site_id: string }>(
    `select site_id from employee_site_exclusion
      where employee_id = $1 and removed_at is null`,
    [args.employeeId],
  );
  return new Set(rows.map((r) => r.site_id));
}

/**
 * A site created by hand from the office, rather than arriving with a job
 * import — the address-search flow on SHT 04 geocodes an address, drops a
 * pin, and this is what turns that draft into a real site.
 */
export async function createSite(
  db: Db,
  args: {
    companyId: string;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    geofenceRadiusM: number;
    operatingHoursStart: string | null;
    operatingHoursEnd: string | null;
  },
): Promise<SiteSummary> {
  if (!args.name.trim()) {
    throw new SiteError('A site name is required.');
  }
  if (!Number.isFinite(args.latitude) || args.latitude < -90 || args.latitude > 90) {
    throw new SiteError('Latitude must be between -90 and 90.');
  }
  if (!Number.isFinite(args.longitude) || args.longitude < -180 || args.longitude > 180) {
    throw new SiteError('Longitude must be between -180 and 180.');
  }
  if (!(args.geofenceRadiusM > 0)) {
    throw new SiteError('Geofence radius must be greater than zero.');
  }
  if ((args.operatingHoursStart == null) !== (args.operatingHoursEnd == null)) {
    throw new SiteError('Operating hours need both a start and an end, or neither.');
  }

  const row = await oneOrFail<{
    id: string;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    geofence_radius_m: number;
    operating_hours_start: string | null;
    operating_hours_end: string | null;
  }>(
    db,
    `insert into site (company_id, name, address, latitude, longitude, geofence_radius_m,
                        operating_hours_start, operating_hours_end)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id, name, address, latitude, longitude, geofence_radius_m,
               operating_hours_start, operating_hours_end`,
    [
      args.companyId,
      args.name.trim(),
      args.address,
      args.latitude,
      args.longitude,
      args.geofenceRadiusM,
      args.operatingHoursStart,
      args.operatingHoursEnd,
    ],
    'Site',
  );

  return {
    id: row.id,
    name: row.name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    geofenceRadiusM: row.geofence_radius_m,
    jobCount: 0,
    operatingHoursStart: row.operating_hours_start,
    operatingHoursEnd: row.operating_hours_end,
  };
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

// --- one site, in full -------------------------------------------------------

export interface SiteDetailJob {
  id: string;
  jobNumber: string;
  customerName: string | null;
  status: string;
}

export interface SiteDetailExclusion {
  id: string;
  employeeName: string;
  reason: string;
  createdAt: string;
}

export interface SiteDetail extends SiteSummary {
  jobs: SiteDetailJob[];
  exclusions: SiteDetailExclusion[];
  /** Distinct people with attendance here in the last fortnight. */
  peopleRecently: number;
  /** Distinct days with attendance here in the last fortnight. */
  daysRecently: number;
  /** Paid minutes booked to this site's jobs in the last fortnight. */
  minutesRecently: number;
  lastActivityAt: string | null;
}

/**
 * Everything about one site on one screen.
 *
 * The list view answers "where are my sites"; this answers "what is going on
 * at this one", which is a different question and was previously only
 * answerable by cross-referencing three screens. Null when the id is not this
 * company's — the company check is the tenancy boundary, not decoration.
 */
export async function getSiteDetail(
  db: Db,
  args: { companyId: string; siteId: string; now?: Date },
): Promise<SiteDetail | null> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  const site = await one<{
    id: string;
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    geofence_radius_m: number;
    operating_hours_start: string | null;
    operating_hours_end: string | null;
    job_count: string;
    people_recent: string;
    days_recent: string;
    minutes_recent: string | null;
    last_activity_at: Date | string | null;
  }>(
    db,
    `select s.id, s.name, s.address, s.latitude, s.longitude, s.geofence_radius_m,
            s.operating_hours_start, s.operating_hours_end,
            (select count(*) from job j
              where j.site_id = s.id and j.status = 'active') as job_count,
            (select count(distinct ae.employee_id) from attendance_event ae
               join job j on j.id = ae.job_id
              where j.site_id = s.id and ae.voided_at is null
                and ae.device_time >= $3) as people_recent,
            (select count(distinct ae.device_time::date) from attendance_event ae
               join job j on j.id = ae.job_id
              where j.site_id = s.id and ae.voided_at is null
                and ae.device_time >= $3) as days_recent,
            (select coalesce(sum(ts.minutes), 0) from time_segment ts
               join job j on j.id = ts.job_id
              where j.site_id = s.id and ts.is_paid and ts.start_time >= $3) as minutes_recent,
            (select max(ae.device_time) from attendance_event ae
               join job j on j.id = ae.job_id
              where j.site_id = s.id and ae.voided_at is null) as last_activity_at
       from site s
      where s.id = $1 and s.company_id = $2 and s.archived_at is null`,
    [args.siteId, args.companyId, since],
  );
  if (!site) return null;

  const { rows: jobs } = await db.query<{
    id: string;
    job_number: string;
    customer_name: string | null;
    status: string;
  }>(
    `select id, job_number, customer_name, status::text as status
       from job where site_id = $1 and archived_at is null
      order by status, job_number`,
    [args.siteId],
  );

  const { rows: exclusions } = await db.query<{
    id: string;
    full_name: string;
    reason: string;
    created_at: Date | string;
  }>(
    `select x.id, e.full_name, x.reason, x.created_at
       from employee_site_exclusion x
       join employee e on e.id = x.employee_id
      where x.site_id = $1 and x.removed_at is null
      order by e.full_name`,
    [args.siteId],
  );

  const lastActivityAt =
    site.last_activity_at instanceof Date
      ? site.last_activity_at.toISOString()
      : site.last_activity_at
        ? String(site.last_activity_at)
        : null;

  return {
    id: site.id,
    name: site.name,
    address: site.address,
    latitude: site.latitude,
    longitude: site.longitude,
    geofenceRadiusM: site.geofence_radius_m,
    jobCount: Number(site.job_count),
    operatingHoursStart: site.operating_hours_start,
    operatingHoursEnd: site.operating_hours_end,
    jobs: jobs.map((j) => ({
      id: j.id,
      jobNumber: j.job_number,
      customerName: j.customer_name,
      status: j.status,
    })),
    exclusions: exclusions.map((x) => ({
      id: x.id,
      employeeName: x.full_name,
      reason: x.reason,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
    })),
    peopleRecently: Number(site.people_recent),
    daysRecently: Number(site.days_recent),
    minutesRecently: Number(site.minutes_recent ?? 0),
    lastActivityAt,
  };
}
