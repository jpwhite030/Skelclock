/**
 * Jobs, as the office thinks about them.
 *
 * A job in Odoo is a number and a customer. What nobody could see from
 * SkelClock was whether it is a job anyone is actually *on* — whether it has a
 * site, whether that site has a pin, whether hours have been booked to it this
 * fortnight, and whether it is quietly running with nobody assigned.
 *
 * Everything below is either mastered in Odoo or observed here. Same rule as
 * employees.ts: nothing on this screen is typed in, because a second job list
 * is exactly what the Odoo integration exists to prevent.
 */

import type { Db } from './db.js';

export type ProjectHealth =
  /** Live and being worked. */
  | 'working'
  /** Live, has a fence, nobody has booked time in a fortnight. */
  | 'idle'
  /** Live, but the site has no pin — no fence, so no automatic clock-on. */
  | 'no_pin'
  /** Live with no site record at all. Cannot be geofenced or reported on. */
  | 'no_site'
  /** Odoo says it is done or paused. */
  | 'closed';

export interface ProjectCard {
  id: string;
  jobNumber: string;
  customerName: string | null;
  status: string;
  startsOn: string | null;
  endsOn: string | null;

  siteId: string | null;
  siteName: string | null;
  siteAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;

  /** Distinct people who booked time here in the last fortnight. */
  peopleRecently: number;
  /** Distinct days with any attendance in the last fortnight. */
  daysRecently: number;
  /** Paid minutes booked to this job in the last fortnight. */
  minutesRecently: number;
  lastActivityAt: string | null;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Health is derived, never stored — same reasoning as the site statuses on the
 * map. `onSiteNow` comes from the caller because "who is on shift" is decided
 * by the state machine in TypeScript (see getWorkingNow), and a second SQL
 * implementation of that would be free to disagree with the Working now sheet.
 */
export function projectHealth(card: ProjectCard, onSiteNow: number): ProjectHealth {
  if (card.status !== 'active') return 'closed';
  if (onSiteNow > 0) return 'working';
  if (!card.siteId) return 'no_site';
  if (card.latitude == null || card.longitude == null) return 'no_pin';
  return card.daysRecently > 0 ? 'working' : 'idle';
}

export async function listProjects(
  db: Db,
  args: { companyId: string; now?: Date },
): Promise<ProjectCard[]> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  const { rows } = await db.query<{
    id: string;
    job_number: string;
    customer_name: string | null;
    status: string;
    starts_on: Date | string | null;
    ends_on: Date | string | null;
    site_id: string | null;
    site_name: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    geofence_radius_m: number | null;
    people_recent: string;
    days_recent: string;
    minutes_recent: string | null;
    last_activity_at: Date | string | null;
  }>(
    // Time is counted from time_segment rather than from raw events: a segment
    // is what the payroll rules already decided a shift was worth, so this
    // agrees with the timesheet instead of re-deriving it and disagreeing.
    `select j.id, j.job_number, j.customer_name, j.status::text as status,
            j.starts_on, j.ends_on,
            s.id as site_id, s.name as site_name, s.address,
            s.latitude, s.longitude, s.geofence_radius_m,
            (select count(distinct ae.employee_id) from attendance_event ae
              where ae.job_id = j.id and ae.voided_at is null
                and ae.device_time >= $2) as people_recent,
            (select count(distinct ae.device_time::date) from attendance_event ae
              where ae.job_id = j.id and ae.voided_at is null
                and ae.device_time >= $2) as days_recent,
            (select coalesce(sum(ts.minutes), 0) from time_segment ts
              where ts.job_id = j.id and ts.is_paid and ts.start_time >= $2) as minutes_recent,
            (select max(ae.device_time) from attendance_event ae
              where ae.job_id = j.id and ae.voided_at is null) as last_activity_at
       from job j
       left join site s on s.id = j.site_id
      where j.company_id = $1 and j.archived_at is null
      order by j.status, j.job_number`,
    [args.companyId, since],
  );

  return rows.map((r) => ({
    id: r.id,
    jobNumber: r.job_number,
    customerName: r.customer_name,
    status: r.status,
    startsOn: toIso(r.starts_on)?.slice(0, 10) ?? null,
    endsOn: toIso(r.ends_on)?.slice(0, 10) ?? null,
    siteId: r.site_id,
    siteName: r.site_name,
    siteAddress: r.address,
    latitude: r.latitude,
    longitude: r.longitude,
    geofenceRadiusM: r.geofence_radius_m,
    peopleRecently: Number(r.people_recent),
    daysRecently: Number(r.days_recent),
    minutesRecently: Number(r.minutes_recent ?? 0),
    lastActivityAt: toIso(r.last_activity_at),
  }));
}
