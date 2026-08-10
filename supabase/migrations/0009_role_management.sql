-- ===========================================================================
-- SkelClock 0009 — who decides a role, and who changed it
--
-- Until now nothing in the application wrote app_user.role at all. The only
-- way to make somebody an admin was direct SQL against production, which is
-- how the two existing admins were set, and there is no record anywhere of it
-- having happened.
--
-- Two things are needed to fix that, and they pull in opposite directions:
--
--   * Odoo is master for people (see import.ts), and it already knows the org
--     chart — hr.employee.parent_id is imported as supervisor_employee_id. A
--     company should not have to re-enter its own management structure here.
--
--   * A SkelClock role is not an employment fact. "Admin" means "can change
--     payroll policy for the whole company", which is nothing Odoo models and
--     nothing an import should ever be able to grant.
--
-- So: Odoo seeds, a human decides, and a human's decision is permanent.
-- role_source records which of the two set the current value, and the sync
-- refuses to touch anything marked 'manual'. This is the same rule the site
-- pin already follows — Odoo coordinates win when present, but a pin the
-- office dropped by hand is never overwritten (see importJobs).
--
-- The default is 'manual', which is the safe direction: it means the first
-- role sync after this migration cannot demote anybody who is already set,
-- including the two admins who were set by hand.
-- ===========================================================================

alter table app_user
  add column role_source text not null default 'manual',
  add column role_set_at timestamptz,
  add column role_set_by uuid references app_user(id),

  add constraint app_user_role_source_check check (
    role_source in ('odoo', 'manual')
  );

-- --- audit --------------------------------------------------------------
-- write_audit_log() from 0002 is generic over any table with company_id and
-- id, so a role change gets the same before/after pair, actor and reason that
-- an edited timesheet already gets. Nothing new to maintain.

create trigger app_user_audit
  after insert or update or delete on app_user
  for each row execute function write_audit_log();
