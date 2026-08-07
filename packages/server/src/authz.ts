/**
 * Supervisor-scope checks for service-role code.
 *
 * Mirrors app.supervises() / app.can_see_employee() in
 * supabase/migrations/1001_supabase_rls.sql. Those only run when a request
 * goes through Supabase's own client with RLS active; the JSON API and the
 * dashboard's server actions connect via DATABASE_URL directly and bypass
 * RLS entirely, so the same rule has to be re-checked here — RLS on this
 * path is defense in depth, not the actual gate.
 */

import type { UserRole } from '@skelclock/core';

import type { Db } from './db.js';

/** Direct reports (recursively) or a crew this supervisor leads. Excludes self. */
export async function supervises(
  db: Db,
  args: { supervisorEmployeeId: string; targetEmployeeId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ supervises: boolean }>(
    `with recursive reports as (
       select id from employee where supervisor_employee_id = $1
       union
       select e.id from employee e join reports r on e.supervisor_employee_id = r.id
     )
     select (
       exists (select 1 from reports where id = $2)
       or exists (
         select 1 from crew_member cm
         join crew c on c.id = cm.crew_id
         where c.supervisor_employee_id = $1 and cm.employee_id = $2 and cm.active
       )
     ) as supervises`,
    [args.supervisorEmployeeId, args.targetEmployeeId],
  );
  return rows[0]?.supervises ?? false;
}

/**
 * Whether a caller may act on (edit, exclude from a site) a given employee's
 * records. Admin: anyone. Supervisor: their own reports, never themselves —
 * editing your own hours isn't what this path is for. Worker: nobody.
 */
export async function canManageEmployee(
  db: Db,
  args: { role: UserRole; callerEmployeeId: string | null; targetEmployeeId: string },
): Promise<boolean> {
  if (args.role === 'admin') return true;
  if (args.role !== 'supervisor' || !args.callerEmployeeId) return false;
  if (args.callerEmployeeId === args.targetEmployeeId) return false;
  return supervises(db, {
    supervisorEmployeeId: args.callerEmployeeId,
    targetEmployeeId: args.targetEmployeeId,
  });
}
