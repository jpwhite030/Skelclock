-- ============================================================================
-- Row-level security for everything 0005, 0006 and the payroll settings added.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 1001
--
-- scripts/apply-migrations.ts records applied filenames in `_migrations` and
-- skips anything already there. A database that has run 1001 will never run it
-- again, whatever the file later says. So an edit to 1001 reaches a fresh
-- database and no other — and the two tables added by 0005 and 0006 would be
-- created on an existing database with no row-level security at all, holding
-- consent records and site lockouts keyed to named employees, reachable by any
-- authenticated client. RLS that only protects new installations is not RLS.
--
-- Everything here is therefore additive and lands as its own file. 0007 got
-- this right already by enabling RLS for its own table inline; this is the
-- catch-up for the two that did not.
--
-- Safe to run twice: enabling RLS on a table that already has it is a no-op,
-- and every policy is dropped before it is created. scripts/rls-check.ts holds
-- this file to that claim, keyed on the marker below.
--
-- idempotent
-- ============================================================================

-- --- the two tables that 1001 never covered ---------------------------------

alter table geofence_consent_event  enable row level security;
alter table geofence_consent_event  force  row level security;
alter table employee_site_exclusion enable row level security;
alter table employee_site_exclusion force  row level security;

-- --- payroll policy is an admin act -----------------------------------------
-- Auto-lunch, travel allocation and operating hours change how every
-- employee's pay is computed company-wide.

drop policy if exists company_settings_write on company;
create policy company_settings_write on company for update
  using (id = app.current_company_id() and app.is_admin())
  with check (id = app.current_company_id() and app.is_admin());

-- --- site edits are supervisor or admin -------------------------------------
-- The pin, the radius and the operating-hours override: same authority
-- saveSiteLocation already requires.

drop policy if exists site_write on site;
create policy site_write on site for update
  using (company_id = app.current_company_id() and (app.is_admin() or app.current_role() = 'supervisor'))
  with check (company_id = app.current_company_id());

-- --- consent ----------------------------------------------------------------
-- A worker logs their own consent; a supervisor may read their reports' —
-- this is the record that stands behind the in-app notice, so the office needs
-- to be able to show it was given.

drop policy if exists geofence_consent_event_read on geofence_consent_event;
create policy geofence_consent_event_read on geofence_consent_event for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

drop policy if exists geofence_consent_event_insert on geofence_consent_event;
create policy geofence_consent_event_insert on geofence_consent_event for insert
  with check (
    company_id = app.current_company_id()
    and employee_id = app.current_employee_id()
    and app_user_id = app.current_app_user_id()
  );

-- --- site lockouts ----------------------------------------------------------
-- Supervisor manages their own reports' exclusions, admin manages anyone's. A
-- worker may read their own — they should be able to see why a site does not
-- show up for them — but never write.

drop policy if exists employee_site_exclusion_read on employee_site_exclusion;
create policy employee_site_exclusion_read on employee_site_exclusion for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

drop policy if exists employee_site_exclusion_write on employee_site_exclusion;
create policy employee_site_exclusion_write on employee_site_exclusion for all
  using (
    company_id = app.current_company_id()
    and (app.is_admin() or app.supervises(employee_id))
  )
  with check (
    company_id = app.current_company_id()
    and (app.is_admin() or app.supervises(employee_id))
  );
