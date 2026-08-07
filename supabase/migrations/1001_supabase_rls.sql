-- ===========================================================================
-- SkelClock 1001 — Supabase-only: auth linkage and row-level security
--
-- Applied on Supabase only. Local dev and the test suite run 0001-0003 and
-- stop, because PGlite has no auth schema and RLS would just get in the way of
-- fixtures. Every policy scopes on company_id first, then on role.
--
-- Privacy note: location columns live on attendance_event, and the row
-- policies below are what enforce "restrict location data to supervisors and
-- authorised administrators" — a worker can read the rows they created and
-- nothing else, so they never see a colleague's coordinates.
-- ===========================================================================

alter table app_user
  add constraint app_user_auth_fk
  foreign key (auth_user_id) references auth.users(id) on delete set null;

create schema if not exists app;

-- Resolved once per statement rather than per row. STABLE lets the planner
-- hoist it out of the row loop, which matters on the timesheet list queries.
create or replace function app.current_app_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from app_user where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function app.current_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from app_user where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function app.current_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from app_user where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function app.current_employee_id() returns uuid
language sql stable security definer set search_path = public as $$
  select employee_id from app_user where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function app.is_admin() returns boolean
language sql stable as $$ select app.current_role() = 'admin' $$;

-- A supervisor's reach: anyone reporting to them directly, plus anyone in a
-- crew they run. Recursion is deliberate — leading hands report to a
-- supervisor who reports to the manager, and the manager should see both.
create or replace function app.supervises(p_employee_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive me as (
    select app.current_employee_id() as employee_id
  ), reports as (
    select e.id from employee e, me
      where e.supervisor_employee_id = me.employee_id
    union
    select e.id from employee e join reports r on e.supervisor_employee_id = r.id
  )
  select
    app.current_role() in ('supervisor', 'admin')
    and (
      exists (select 1 from reports where id = p_employee_id)
      or exists (
        select 1 from crew c
        join crew_member cm on cm.crew_id = c.id and cm.active
        where c.supervisor_employee_id = app.current_employee_id()
          and cm.employee_id = p_employee_id
      )
    );
$$;

-- Convenience: rows this user may see at all, by employee.
create or replace function app.can_see_employee(p_employee_id uuid) returns boolean
language sql stable as $$
  select app.is_admin()
      or p_employee_id = app.current_employee_id()
      or app.supervises(p_employee_id);
$$;

-- --- enable RLS -------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'company','employee','app_user','crew','crew_member','site','job',
    'work_activity','job_activity','assignment','timesheet','attendance_event',
    'time_segment','correction','approval','attendance_exception',
    'odoo_sync_job','audit_log','device','geofence_consent_event',
    'employee_site_exclusion'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- --- company-wide reference data -------------------------------------------
-- Everyone signed in may read their own company's jobs, sites and activities;
-- nobody writes them from the app, because Odoo owns them.

create policy company_read on company for select
  using (id = app.current_company_id());

-- Payroll policy (auto-lunch, travel allocation, operating hours) is an
-- admin act — it changes how every employee's pay is computed company-wide.
create policy company_settings_write on company for update
  using (id = app.current_company_id() and app.is_admin())
  with check (id = app.current_company_id() and app.is_admin());

create policy job_read on job for select
  using (company_id = app.current_company_id());

create policy site_read on site for select
  using (company_id = app.current_company_id());

-- Site-level edits (pin, radius, operating-hours override) are supervisor or
-- admin, same authority as saveSiteLocation already requires.
create policy site_write on site for update
  using (company_id = app.current_company_id() and (app.is_admin() or app.current_role() = 'supervisor'))
  with check (company_id = app.current_company_id());

create policy work_activity_read on work_activity for select
  using (company_id = app.current_company_id());

create policy job_activity_read on job_activity for select
  using (exists (
    select 1 from job j where j.id = job_id and j.company_id = app.current_company_id()
  ));

create policy crew_read on crew for select
  using (company_id = app.current_company_id());

create policy crew_member_read on crew_member for select
  using (exists (
    select 1 from crew c where c.id = crew_id and c.company_id = app.current_company_id()
  ));

-- --- people -----------------------------------------------------------------

create policy employee_read on employee for select
  using (company_id = app.current_company_id() and app.can_see_employee(id));

create policy app_user_self_read on app_user for select
  using (id = app.current_app_user_id() or (company_id = app.current_company_id() and app.is_admin()));

create policy device_own on device for all
  using (app_user_id = app.current_app_user_id())
  with check (app_user_id = app.current_app_user_id());

-- A worker logs their own consent; a supervisor may read their reports' —
-- this is the record that stands behind the in-app notice, so the office
-- needs to be able to show it was given.
create policy geofence_consent_event_read on geofence_consent_event for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

create policy geofence_consent_event_insert on geofence_consent_event for insert
  with check (
    company_id = app.current_company_id()
    and employee_id = app.current_employee_id()
    and app_user_id = app.current_app_user_id()
  );

-- Site lockouts: supervisor manages their own reports' exclusions, admin
-- manages anyone's. A worker may read their own (they should know why a site
-- doesn't show up for them) but never write.
create policy employee_site_exclusion_read on employee_site_exclusion for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

create policy employee_site_exclusion_write on employee_site_exclusion for all
  using (
    company_id = app.current_company_id()
    and (app.is_admin() or app.supervises(employee_id))
  )
  with check (
    company_id = app.current_company_id()
    and (app.is_admin() or app.supervises(employee_id))
  );

-- --- assignments ------------------------------------------------------------

create policy assignment_read on assignment for select
  using (
    company_id = app.current_company_id()
    and (
      app.is_admin()
      or (employee_id is not null and app.can_see_employee(employee_id))
      or (crew_id is not null and exists (
            select 1 from crew_member cm
            where cm.crew_id = assignment.crew_id
              and (cm.employee_id = app.current_employee_id()
                   or app.can_see_employee(cm.employee_id))))
    )
  );

-- --- attendance -------------------------------------------------------------

create policy attendance_event_read on attendance_event for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

-- A worker may only ever insert events for themselves, and only 'manual' ones.
-- Supervisor and admin methods require the matching role, so a tampered client
-- cannot post a supervisor-authored clock-in.
create policy attendance_event_insert on attendance_event for insert
  with check (
    company_id = app.current_company_id()
    and (
      (employee_id = app.current_employee_id() and clock_method in ('manual', 'auto_geofence'))
      or (clock_method = 'supervisor' and app.supervises(employee_id))
      or (clock_method = 'admin' and app.is_admin())
    )
  );

-- Voiding and superseding is a supervisor/admin act. Workers correct their day
-- by asking, not by editing — that is what the correction table is for.
create policy attendance_event_void on attendance_event for update
  using (
    company_id = app.current_company_id()
    and (app.is_admin() or app.supervises(employee_id))
  )
  with check (company_id = app.current_company_id());

create policy timesheet_read on timesheet for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

create policy timesheet_write on timesheet for update
  using (
    company_id = app.current_company_id()
    and (app.is_admin()
         or app.supervises(employee_id)
         or employee_id = app.current_employee_id())
  )
  with check (company_id = app.current_company_id());

create policy time_segment_read on time_segment for select
  using (company_id = app.current_company_id() and app.can_see_employee(employee_id));

-- --- corrections and approvals ---------------------------------------------

create policy correction_read on correction for select
  using (company_id = app.current_company_id());

create policy correction_insert on correction for insert
  with check (
    company_id = app.current_company_id()
    and requested_by = app.current_app_user_id()
  );

-- Only a supervisor or admin closes a correction out, and never their own.
create policy correction_review on correction for update
  using (
    company_id = app.current_company_id()
    and app.current_role() in ('supervisor', 'admin')
  )
  with check (company_id = app.current_company_id());

create policy approval_read on approval for select
  using (company_id = app.current_company_id());

create policy approval_insert on approval for insert
  with check (
    company_id = app.current_company_id()
    and actor_user_id = app.current_app_user_id()
    and (
      -- workers may only confirm their own day
      (action = 'confirm' and exists (
        select 1 from timesheet t
        where t.id = timesheet_id and t.employee_id = app.current_employee_id()))
      or (action in ('approve', 'reject') and app.current_role() in ('supervisor', 'admin'))
      or (action in ('lock', 'reopen') and app.is_admin())
    )
  );

create policy attendance_exception_read on attendance_exception for select
  using (
    company_id = app.current_company_id()
    and app.current_role() in ('supervisor', 'admin')
  );

create policy attendance_exception_update on attendance_exception for update
  using (
    company_id = app.current_company_id()
    and app.current_role() in ('supervisor', 'admin')
  )
  with check (company_id = app.current_company_id());

-- --- office-only ------------------------------------------------------------

create policy odoo_sync_job_admin on odoo_sync_job for all
  using (company_id = app.current_company_id() and app.is_admin())
  with check (company_id = app.current_company_id() and app.is_admin());

create policy audit_log_admin on audit_log for select
  using (company_id = app.current_company_id() and app.is_admin());

-- The sync worker and the ingest endpoint run as service_role, which bypasses
-- RLS by design. They are the only paths allowed to write across employees,
-- and they live server-side where the client cannot reach them.
