-- ===========================================================================
-- SkelClock 0006 — supervisor/admin editing, payroll settings, site access
--
--   * Payroll settings live on `company` directly rather than a side table —
--     there are few enough of them, and every one of them already needs the
--     company row loaded wherever it matters (rebuildTimesheet, ingestEvents).
--   * `site.operating_hours_*` overrides the company default per site; null
--     means "use the company's". Both null means no restriction at all.
--   * employee_site_exclusion is a hard stop, not a preference — ingestEvents
--     refuses every clock method at an excluded site, not just auto-detect.
-- ===========================================================================

alter table company
  add column auto_lunch_enabled            boolean not null default false,
  -- Shift length (minutes) that triggers the auto-deduction.
  add column auto_lunch_threshold_minutes  integer not null default 300,
  add column auto_lunch_duration_minutes   integer not null default 30,
  add column travel_allocation             text not null default 'unallocated',
  add column operating_hours_start         time,
  add column operating_hours_end           time,

  add constraint company_travel_allocation_check check (
    travel_allocation in ('unallocated', 'first_site', 'second_site')
  ),
  add constraint company_auto_lunch_positive check (
    auto_lunch_threshold_minutes > 0 and auto_lunch_duration_minutes > 0
  );

alter table site
  add column operating_hours_start time,
  add column operating_hours_end   time;

-- Denormalised alongside the other totals rebuildTimesheet already stores,
-- so a day's auto-lunch deduction is visible on the Timesheets list without
-- rebuilding it live just to display it.
alter table timesheet
  add column total_auto_lunch_minutes integer not null default 0;

-- --- employee_site_exclusion -------------------------------------------------
-- "They live next door" — a hard lockout, not a suggestion. No clock method,
-- including a supervisor's own crew-clock, creates a live event for this
-- employee at this site while the row exists; removing the row is the only
-- way back in.

create table employee_site_exclusion (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  employee_id   uuid not null references employee(id),
  site_id       uuid not null references site(id),
  reason        text not null,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),

  constraint employee_site_exclusion_unique unique (employee_id, site_id),
  constraint employee_site_exclusion_reason check (length(trim(reason)) > 0)
);

create index employee_site_exclusion_employee_idx on employee_site_exclusion (employee_id);
create index employee_site_exclusion_site_idx on employee_site_exclusion (site_id);
