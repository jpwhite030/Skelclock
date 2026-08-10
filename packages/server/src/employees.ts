/**
 * The employee list.
 *
 * Read-only, and that is a design decision rather than an unfinished one.
 * Employees are mastered in Odoo (see import.ts) — nothing in SkelClock ever
 * creates one, and a screen with an "Add employee" button would be the second
 * employee list the brief exists to prevent. What this screen is for is
 * answering questions the office actually has: who has never signed in, who is
 * on site right now, whose phone stopped reporting, who reports to whom.
 *
 * Every column here is therefore either from Odoo or from something SkelClock
 * observed. None of it is typed in.
 */

import type { Db } from './db.js';

export type EmployeeAppState =
  /** Has an app_user row and has clocked at least once. */
  | 'active'
  /** Invited — an app_user exists, but they have never clocked anything. */
  | 'never_clocked'
  /** In Odoo, with no app_user at all. Cannot sign in. */
  | 'no_login';

export interface EmployeeRow {
  id: string;
  odooId: number;
  fullName: string;
  employeeNumber: string | null;
  email: string | null;
  mobile: string | null;
  /** Odoo's own flag. False means terminated or archived over there. */
  active: boolean;
  employmentStatus: string;
  crewName: string | null;
  supervisorName: string | null;
  /** From app_user; null when they have no login at all. */
  role: string | null;
  appState: EmployeeAppState;
  /** ISO, or null if they have never clocked anything. */
  lastClockAt: string | null;
  /** Days of attendance in the last fortnight — a cheap "are they working". */
  daysWorkedRecently: number;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * One query rather than a fan-out.
 *
 * getWorkingNow next door runs a per-employee loop because it has to replay
 * the state machine in TypeScript for each one. Nothing here needs that — it
 * is all counting and joining — so it stays a single statement, and the list
 * does not get slower as SkelScaff hires.
 */
export async function listEmployees(
  db: Db,
  args: { companyId: string; now?: Date },
): Promise<EmployeeRow[]> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  const { rows } = await db.query<{
    id: string;
    odoo_id: number;
    full_name: string;
    employee_number: string | null;
    email: string | null;
    mobile: string | null;
    active: boolean;
    employment_status: string;
    crew_name: string | null;
    supervisor_name: string | null;
    role: string | null;
    has_login: boolean;
    last_clock_at: Date | string | null;
    days_recent: string;
  }>(
    `select e.id, e.odoo_id, e.full_name, e.employee_number, e.email, e.mobile,
            e.active, e.employment_status::text as employment_status,
            (select c.name from crew c
               join crew_member cm on cm.crew_id = c.id and cm.active
              where cm.employee_id = e.id limit 1) as crew_name,
            sup.full_name as supervisor_name,
            u.role::text as role,
            (u.id is not null) as has_login,
            (select max(ae.device_time) from attendance_event ae
              where ae.employee_id = e.id and ae.voided_at is null) as last_clock_at,
            (select count(distinct ae.device_time::date) from attendance_event ae
              where ae.employee_id = e.id and ae.voided_at is null
                and ae.device_time >= $2) as days_recent
       from employee e
       left join employee sup on sup.id = e.supervisor_employee_id
       left join app_user u on u.employee_id = e.id and u.active
      where e.company_id = $1
      order by e.active desc, e.full_name`,
    [args.companyId, since],
  );

  return rows.map((r) => {
    const lastClockAt = toIso(r.last_clock_at);
    return {
      id: r.id,
      odooId: r.odoo_id,
      fullName: r.full_name,
      employeeNumber: r.employee_number,
      email: r.email,
      mobile: r.mobile,
      active: r.active,
      employmentStatus: r.employment_status,
      crewName: r.crew_name,
      supervisorName: r.supervisor_name,
      role: r.role,
      appState: !r.has_login ? 'no_login' : lastClockAt ? 'active' : 'never_clocked',
      lastClockAt,
      daysWorkedRecently: Number(r.days_recent),
    };
  });
}
