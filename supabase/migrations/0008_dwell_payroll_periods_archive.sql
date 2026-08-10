-- ===========================================================================
-- SkelClock 0008 — dwell time, payroll periods, and archive-instead-of-delete
--
--   * geofence_min_dwell_minutes: how long a worker has to actually STAY
--     inside a fence before an automatic arrival is trusted. Driving past a
--     site, or parking next to one to buy a coffee, crosses a fence exactly
--     the same way turning up for work does — and until now the two were
--     indistinguishable.
--
--   * payroll_period / payroll_week_starts_on / payroll_anchor_date: the
--     office runs weekly or fortnightly, and "which week is it" is not
--     derivable — a fortnight needs a known starting Monday or every screen
--     picks its own. Settings live on `company` alongside the auto-lunch and
--     travel rules, same reasoning as 0006: few enough of them, and the
--     company row is already loaded everywhere they matter.
--
--   * archived_at / archived_by: nothing the office can see gets deleted.
--     A site or a job that is gone from the list is still on last quarter's
--     timesheets, and a foreign key that stops the delete is a worse outcome
--     than a row nobody looks at. Employees already had `active` and
--     `employment_status` and are left alone.
-- ===========================================================================

alter table company
  -- 5 minutes: long enough that a drive-past and a coffee stop both fail it,
  -- short enough that nobody stands at the gate wondering if it worked. 0
  -- disables the rule rather than being a special case elsewhere.
  add column geofence_min_dwell_minutes integer not null default 5,

  add column payroll_period text not null default 'weekly',
  -- ISO day numbering, 1 = Monday. Australian construction weeks start
  -- Monday; stored anyway because it is a policy, not a fact about the world.
  add column payroll_week_starts_on smallint not null default 1,
  -- Which fortnight is which. Any date that fell in a period-one week will
  -- do — every later boundary is counted from it. Null while the company runs
  -- weekly, because then there is nothing to anchor.
  add column payroll_anchor_date date,

  add constraint company_payroll_period_check check (
    payroll_period in ('weekly', 'fortnightly')
  ),
  add constraint company_payroll_week_start_check check (
    payroll_week_starts_on between 1 and 7
  ),
  add constraint company_dwell_nonneg check (
    geofence_min_dwell_minutes >= 0
  ),
  -- A fortnightly company with no anchor cannot say which fortnight it is in,
  -- and every screen would answer differently. Enforced here rather than in
  -- the settings form so a direct SQL edit cannot create that state either.
  add constraint company_fortnight_needs_anchor check (
    payroll_period <> 'fortnightly' or payroll_anchor_date is not null
  );

-- --- archive instead of delete ---------------------------------------------

alter table site
  add column archived_at timestamptz,
  add column archived_by uuid references app_user(id);

alter table job
  add column archived_at timestamptz,
  add column archived_by uuid references app_user(id);

-- Partial, so the live list stays cheap while the archive grows.
create index site_active_idx on site (company_id) where archived_at is null;
create index job_active_idx  on job  (company_id) where archived_at is null;

-- --- employee_site_exclusion: lifting a lockout is history too --------------
-- "We banned them from this site, then we un-banned them" is exactly the sort
-- of thing that gets argued about later, and removeSiteExclusion used to
-- delete the row outright.

alter table employee_site_exclusion
  add column removed_at timestamptz,
  add column removed_by uuid references app_user(id);

-- The old constraint made one row per (employee, site) forever, which a soft
-- delete breaks the moment someone is excluded, un-excluded, then excluded
-- again. Uniqueness now applies only to LIVE exclusions.
alter table employee_site_exclusion
  drop constraint employee_site_exclusion_unique;

create unique index employee_site_exclusion_live_unique
  on employee_site_exclusion (employee_id, site_id)
  where removed_at is null;
