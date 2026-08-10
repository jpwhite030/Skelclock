/**
 * Who can do what, and who decided.
 *
 * Roles existed as a column and two read functions (authz.ts). Nothing ever
 * wrote them, so the only way to make an admin was direct SQL, and there was
 * no record that it had happened.
 *
 * The rule, set out in migration 0009: Odoo seeds, a human decides, and a
 * human's decision is permanent. Odoo already carries the org chart —
 * hr.employee.parent_id arrives as supervisor_employee_id — so a company
 * should not re-enter its own management structure here. But a SkelClock role
 * is not an employment fact: "admin" means "can change payroll policy for the
 * whole company", which is nothing Odoo models and nothing an import should
 * ever be able to grant.
 *
 * Every write here goes through the audit trigger 0009 attaches to app_user,
 * so a role change leaves the same before/after pair, actor and reason that an
 * edited timesheet does.
 */

import type { UserRole } from '@skelclock/core';

import { one, withTransaction, type Db } from './db.js';

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleError';
  }
}

/** Which of the two decided the current value. A sync never touches 'manual'. */
export type RoleSource = 'odoo' | 'manual';

export interface RoleAssignment {
  appUserId: string;
  employeeId: string | null;
  fullName: string | null;
  email: string | null;
  role: UserRole;
  roleSource: RoleSource;
  roleSetAt: string | null;
  roleSetByName: string | null;
}

/**
 * Change somebody's role.
 *
 * Always marks the result 'manual'. Choosing a role by hand is exactly the
 * decision the sync must not undo — including choosing to set someone back to
 * worker, which is otherwise indistinguishable from never having been touched.
 */
export async function setUserRole(
  db: Db,
  args: {
    companyId: string;
    /** The app_user being changed, not the employee. */
    targetAppUserId: string;
    role: UserRole;
    actorUserId: string;
    reason: string;
  },
): Promise<void> {
  if (!args.reason?.trim()) {
    throw new RoleError('A reason is required to change a role.');
  }

  await withTransaction(
    db,
    async (tx) => {
      const target = await one<{ id: string; role: UserRole }>(
        tx,
        'select id, role from app_user where id = $1 and company_id = $2 and active',
        [args.targetAppUserId, args.companyId],
      );
      if (!target) throw new RoleError('That user is not in this company.');
      if (target.role === args.role) return;

      /*
       * The lock-out guard.
       *
       * A company with no admin cannot change payroll policy, cannot approve a
       * timesheet, and — worst — cannot promote anybody back, because that is
       * an admin action. The only way out is direct SQL against production,
       * which is the exact hole this module exists to close.
       *
       * The admin ROWS are locked and counted here, rather than asking
       * Postgres for a count with FOR UPDATE — that combination is rejected
       * outright ("FOR UPDATE is not allowed with aggregate functions"), and an
       * unlocked count would let two admins demote each other simultaneously,
       * each seeing the other and both succeeding. Locking the rows is what
       * makes the second transaction wait and then find nobody left.
       */
      if (target.role === 'admin' && args.role !== 'admin') {
        const { rows: admins } = await tx.query<{ id: string }>(
          `select id from app_user
            where company_id = $1 and role = 'admin' and active
            for update`,
          [args.companyId],
        );
        const others = admins.filter((a) => a.id !== args.targetAppUserId);
        if (others.length === 0) {
          throw new RoleError(
            'This is the only admin left. Make somebody else an admin first, or the company locks itself out.',
          );
        }
      }

      await tx.query(
        `update app_user
            set role = $3, role_source = 'manual',
                role_set_at = now(), role_set_by = $4, updated_at = now()
          where id = $1 and company_id = $2`,
        [args.targetAppUserId, args.companyId, args.role, args.actorUserId],
      );
    },
    { actorUserId: args.actorUserId, reason: args.reason },
  );
}

export interface RoleSyncResult {
  /** Promoted to supervisor because Odoo says they have reports. */
  promoted: number;
  /** Demoted to worker because Odoo says they no longer do. */
  demoted: number;
  /** Left alone because a human had set them. */
  skippedManual: number;
  considered: number;
}

/**
 * Derive roles from the Odoo org chart.
 *
 * Someone with at least one active direct report is a supervisor; someone with
 * none is a worker. That is the whole rule, and it uses data the employee
 * import already brings in — no new Odoo field, no mapping decision, nothing
 * for the office to configure.
 *
 * Two things it deliberately will not do:
 *
 *   * It never grants or removes admin. Admin is company-wide payroll
 *     authority and Odoo has no concept that means that; an import being able
 *     to hand it out is a bad idea whichever field you pick.
 *   * It never touches a row whose role_source is 'manual'. A person who
 *     chose a role outranks the org chart, permanently, and that includes the
 *     admins set by hand before any of this existed.
 */
export async function syncRolesFromOdoo(
  db: Db,
  args: { companyId: string; actorUserId?: string | null },
): Promise<RoleSyncResult> {
  const result: RoleSyncResult = { promoted: 0, demoted: 0, skippedManual: 0, considered: 0 };

  await withTransaction(
    db,
    async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        role: UserRole;
        role_source: RoleSource;
        report_count: string;
      }>(
        `select u.id, u.role, u.role_source,
                (select count(*) from employee r
                  where r.supervisor_employee_id = u.employee_id and r.active) as report_count
           from app_user u
          where u.company_id = $1 and u.active and u.employee_id is not null`,
        [args.companyId],
      );

      for (const row of rows) {
        result.considered += 1;

        if (row.role_source === 'manual') {
          result.skippedManual += 1;
          continue;
        }
        // Admin is never derived, and never taken away by a sync either.
        if (row.role === 'admin') continue;

        const shouldBe: UserRole = Number(row.report_count) > 0 ? 'supervisor' : 'worker';
        if (shouldBe === row.role) continue;

        await tx.query(
          `update app_user
              set role = $2, role_source = 'odoo', role_set_at = now(),
                  role_set_by = null, updated_at = now()
            where id = $1`,
          [row.id, shouldBe],
        );

        if (shouldBe === 'supervisor') result.promoted += 1;
        else result.demoted += 1;
      }
    },
    { actorUserId: args.actorUserId ?? null, reason: 'role sync from the Odoo org chart' },
  );

  return result;
}

/** Everyone with a login, and where their role came from. */
export async function listRoleAssignments(
  db: Db,
  args: { companyId: string },
): Promise<RoleAssignment[]> {
  const { rows } = await db.query<{
    id: string;
    employee_id: string | null;
    full_name: string | null;
    email: string | null;
    role: UserRole;
    role_source: RoleSource;
    role_set_at: Date | string | null;
    set_by_name: string | null;
  }>(
    `select u.id, u.employee_id, e.full_name, u.email, u.role, u.role_source,
            u.role_set_at, setter.full_name as set_by_name
       from app_user u
       left join employee e on e.id = u.employee_id
       left join app_user su on su.id = u.role_set_by
       left join employee setter on setter.id = su.employee_id
      where u.company_id = $1 and u.active
      order by u.role desc, e.full_name nulls last`,
    [args.companyId],
  );

  return rows.map((r) => ({
    appUserId: r.id,
    employeeId: r.employee_id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    roleSource: r.role_source,
    roleSetAt:
      r.role_set_at instanceof Date
        ? r.role_set_at.toISOString()
        : r.role_set_at
          ? String(r.role_set_at)
          : null,
    roleSetByName: r.set_by_name,
  }));
}
