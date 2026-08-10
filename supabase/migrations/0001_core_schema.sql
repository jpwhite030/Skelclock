-- ===========================================================================
-- SkelClock 0001 — core schema
--
-- Design rules that the rest of the system depends on:
--   * Odoo is the source of truth for employees and jobs. Anything imported
--     carries its odoo_id so we never maintain a second employee list by hand.
--   * Attendance is append-only. Nothing is ever UPDATEd in place and nothing
--     is ever DELETEd — corrections write a new row and void the old one.
--   * Every event carries an idempotency_key so a phone retrying an offline
--     queue can never create a duplicate shift.
--   * Every table that matters carries company_id so row-level security can
--     scope on it later without a schema change.
--
-- This file is portable Postgres — it runs on PGlite (local, no Docker) and on
-- Supabase unchanged. Supabase-specific bits (auth.users FK, RLS policies)
-- live in 1001_supabase_rls.sql so local dev and tests stay simple.
-- ===========================================================================

-- --- enums -----------------------------------------------------------------

create type user_role as enum ('worker', 'supervisor', 'admin');

create type employment_status as enum ('active', 'on_leave', 'terminated');

create type job_status as enum ('draft', 'quoted', 'active', 'on_hold', 'complete', 'cancelled');

create type attendance_event_type as enum (
  'clock_in',
  'clock_out',
  'break_start',
  'break_end',
  'job_change',
  'activity_change'
);

-- How the event was raised. Phase 3 adds 'auto_geofence' events as *suggested*
-- clocks, which is why suggestion state is a column on the event, not a type.
create type clock_method as enum ('manual', 'auto_geofence', 'supervisor', 'admin');

create type segment_type as enum ('work', 'travel', 'break');

-- The approval ladder from the brief. Order matters — code compares ordinality.
create type timesheet_status as enum (
  'draft',
  'worker_confirmed',
  'supervisor_approved',
  'synced',
  'locked'
);

create type correction_status as enum ('pending', 'approved', 'rejected');

create type approval_action as enum ('confirm', 'approve', 'reject', 'lock', 'reopen');

create type sync_direction as enum ('pull', 'push');

create type sync_status as enum ('pending', 'running', 'success', 'failed', 'dead');

create type exception_type as enum (
  'missing_clock_in',
  'missing_clock_out',
  'outside_geofence',
  'overlapping_shift',
  'very_long_shift',
  'offline_event',
  'unassigned_job',
  'odoo_sync_failure'
);

create type exception_status as enum ('open', 'acknowledged', 'resolved');

-- --- company ---------------------------------------------------------------

create table company (
  id              uuid primary key default gen_random_uuid(),
  odoo_id         integer unique,
  name            text not null,
  timezone        text not null default 'Australia/Sydney',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- --- employee (mastered in Odoo: hr.employee) ------------------------------

create table employee (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company(id),
  odoo_id               integer not null,
  employee_number       text,
  full_name             text not null,
  email                 text,
  mobile                text,
  employment_status     employment_status not null default 'active',
  supervisor_employee_id uuid references employee(id),
  active                boolean not null default true,
  -- provenance
  synced_at             timestamptz,
  sync_status           sync_status not null default 'pending',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint employee_odoo_unique unique (company_id, odoo_id)
);

-- Lookups the auth flow does on every login must be indexed. Partial unique:
-- two terminated employees may share a recycled number, live ones may not.
create unique index employee_mobile_active_idx
  on employee (company_id, mobile) where active and mobile is not null;
create unique index employee_email_active_idx
  on employee (company_id, lower(email)) where active and email is not null;

-- --- app_user --------------------------------------------------------------
-- One row per person who can log in. auth_user_id links to Supabase auth.users
-- but carries no FK here so the schema stays runnable outside Supabase.

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  auth_user_id  uuid unique,
  employee_id   uuid unique references employee(id),
  email         text,
  phone         text,
  role          user_role not null default 'worker',
  active        boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index app_user_company_role_idx on app_user (company_id, role) where active;

-- --- crew ------------------------------------------------------------------

create table crew (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company(id),
  odoo_id                 integer,
  name                    text not null,
  supervisor_employee_id  uuid references employee(id),
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table crew_member (
  crew_id     uuid not null references crew(id),
  employee_id uuid not null references employee(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (crew_id, employee_id)
);

-- --- site ------------------------------------------------------------------
-- Split from job because one physical site can host several jobs over time and
-- the geofence belongs to the place, not the paperwork.

create table site (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company(id),
  name                text not null,
  address             text,
  latitude            double precision,
  longitude           double precision,
  geofence_radius_m   integer not null default 200,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint site_lat_range  check (latitude  is null or (latitude  between  -90 and  90)),
  constraint site_lng_range  check (longitude is null or (longitude between -180 and 180)),
  constraint site_radius_pos check (geofence_radius_m > 0)
);

-- --- job (mastered in Odoo — model TBC, see packages/odoo/src/mapping.ts) ---

create table job (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  -- We store which Odoo model this came from so switching project.project ->
  -- sale.order later is a data migration, not a schema change.
  odoo_model      text not null,
  odoo_id         integer not null,
  job_number      text not null,
  customer_name   text,
  site_id         uuid references site(id),
  status          job_status not null default 'active',
  starts_on       date,
  ends_on         date,
  synced_at       timestamptz,
  sync_status     sync_status not null default 'pending',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint job_odoo_unique unique (company_id, odoo_model, odoo_id)
);

create index job_company_status_idx on job (company_id, status);

-- --- work activity (cost codes) --------------------------------------------
-- Seeded with the brief's list in 0004 but fully editable — the brief says
-- these need to be configurable later, so they are rows, not an enum.

create table work_activity (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  code          text not null,
  name          text not null,
  odoo_model    text,
  odoo_id       integer,
  is_travel     boolean not null default false,
  is_paid       boolean not null default true,
  sort_order    integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint work_activity_code_unique unique (company_id, code)
);

-- Which activities are offered on a given job. Empty = all active activities.
create table job_activity (
  job_id            uuid not null references job(id),
  work_activity_id  uuid not null references work_activity(id),
  primary key (job_id, work_activity_id)
);

-- --- assignment ------------------------------------------------------------
-- Who is expected where, per day. Sourced from Odoo planning.slot when
-- available; created locally by a supervisor otherwise.

create table assignment (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company(id),
  job_id                uuid not null references job(id),
  employee_id           uuid references employee(id),
  crew_id               uuid references crew(id),
  work_date             date not null,
  scheduled_start       timestamptz,
  scheduled_end         timestamptz,
  odoo_planning_slot_id integer,
  created_by            uuid references app_user(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- An assignment targets exactly one of employee or crew.
  constraint assignment_target_one check (
    (employee_id is not null and crew_id is null) or
    (employee_id is null and crew_id is not null)
  )
);

create index assignment_lookup_idx on assignment (company_id, work_date, employee_id);
create index assignment_crew_idx   on assignment (company_id, work_date, crew_id);

-- --- timesheet -------------------------------------------------------------
-- One per employee per working day. The unit of approval and of Odoo sync.

create table timesheet (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company(id),
  employee_id           uuid not null references employee(id),
  work_date             date not null,
  status                timesheet_status not null default 'draft',

  -- Denormalised totals, recomputed by the segment builder. Minutes, not
  -- hours — integer minutes avoid float drift across a fortnight of adding up.
  total_shift_minutes   integer not null default 0,
  total_break_minutes   integer not null default 0,
  total_paid_minutes    integer not null default 0,

  worker_confirmed_at   timestamptz,
  worker_confirmed_by   uuid references app_user(id),
  supervisor_approved_at timestamptz,
  supervisor_approved_by uuid references app_user(id),
  locked_at             timestamptz,
  locked_by             uuid references app_user(id),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint timesheet_unique unique (employee_id, work_date)
);

create index timesheet_company_date_idx on timesheet (company_id, work_date, status);

-- --- attendance_event ------------------------------------------------------
-- The append-only spine of the whole system. Never updated except to void.

create table attendance_event (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company(id),
  employee_id         uuid not null references employee(id),
  timesheet_id        uuid references timesheet(id),
  job_id              uuid references job(id),
  work_activity_id    uuid references work_activity(id),

  event_type          attendance_event_type not null,

  -- Two clocks, always both. device_time is what the worker's phone believed
  -- at the moment they pressed the button and is preserved verbatim through
  -- offline sync; server_time is when we received it. They differ by hours
  -- after a day with no reception, and payroll needs the former.
  device_time         timestamptz not null,
  server_time         timestamptz not null default now(),

  -- Location, captured at clock events only (see privacy requirements).
  latitude            double precision,
  longitude           double precision,
  gps_accuracy_m      double precision,
  inside_geofence     boolean,
  distance_from_site_m double precision,
  outside_reason      text,

  clock_method        clock_method not null default 'manual',
  was_offline         boolean not null default false,
  -- Phase 3: geofence-raised events land as suggestions and need confirming
  -- before they count. Nothing auto-created ever silently becomes payroll.
  is_suggested        boolean not null default false,

  source_device_id    text,
  -- Client-generated, stable across retries. This is what makes the offline
  -- queue safe: the phone can POST the same event ten times and get one row.
  idempotency_key     text not null,

  created_by          uuid references app_user(id),

  -- Soft delete only. The brief forbids destroying attendance history.
  voided_at           timestamptz,
  voided_by           uuid references app_user(id),
  void_reason         text,
  -- When a correction replaces this event, point at the replacement.
  superseded_by       uuid references attendance_event(id),

  created_at          timestamptz not null default now(),

  constraint attendance_event_idempotency_unique unique (company_id, idempotency_key),
  constraint attendance_event_lat_range check (latitude  is null or (latitude  between  -90 and  90)),
  constraint attendance_event_lng_range check (longitude is null or (longitude between -180 and 180)),
  -- A void must say why. Enforced here rather than in app code because this is
  -- the audit guarantee the whole payroll story rests on.
  constraint attendance_event_void_reason check (
    voided_at is null or (void_reason is not null and length(trim(void_reason)) > 0)
  )
);

create index attendance_event_employee_idx on attendance_event (employee_id, device_time desc)
  where voided_at is null;
create index attendance_event_timesheet_idx on attendance_event (timesheet_id)
  where voided_at is null;
create index attendance_event_job_idx on attendance_event (job_id, device_time desc)
  where voided_at is null;

-- --- time_segment ----------------------------------------------------------
-- The day sliced into costable blocks, derived from the event stream:
--   06:30-09:00 work/Erect/Job 1032, 09:00-09:30 travel, 09:30-14:30 work/...
-- Rebuilt from scratch whenever events change, so it is safe to delete rows
-- here — the events they came from are the permanent record.

create table time_segment (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company(id),
  timesheet_id      uuid not null references timesheet(id) on delete cascade,
  employee_id       uuid not null references employee(id),
  job_id            uuid references job(id),
  work_activity_id  uuid references work_activity(id),

  segment_type      segment_type not null default 'work',
  start_time        timestamptz not null,
  end_time          timestamptz,
  minutes           integer,
  is_paid           boolean not null default true,

  start_event_id    uuid references attendance_event(id),
  end_event_id      uuid references attendance_event(id),

  created_at        timestamptz not null default now(),

  constraint time_segment_order check (end_time is null or end_time >= start_time)
);

create index time_segment_timesheet_idx on time_segment (timesheet_id, start_time);

-- The brief lists "Break" as a core model. Rather than a second table that can
-- disagree with the timeline, breaks are segments and this view is the model.
create view break_period as
  select id, company_id, timesheet_id, employee_id,
         start_time, end_time, minutes, is_paid,
         start_event_id, end_event_id
  from time_segment
  where segment_type = 'break';

-- --- correction ------------------------------------------------------------
-- A requested change to attendance. Always retains the original value.

create table correction (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  timesheet_id    uuid references timesheet(id),
  target_table    text not null,
  target_id       uuid not null,
  field           text not null,
  original_value  text,
  new_value       text,
  reason          text not null,
  status          correction_status not null default 'pending',
  requested_by    uuid not null references app_user(id),
  requested_at    timestamptz not null default now(),
  reviewed_by     uuid references app_user(id),
  reviewed_at     timestamptz,
  review_note     text,

  constraint correction_reason_present check (length(trim(reason)) > 0)
);

create index correction_pending_idx on correction (company_id, status, requested_at desc);

-- --- approval --------------------------------------------------------------
-- Every rung of the ladder, including reopens. Append-only history.

create table approval (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  timesheet_id  uuid not null references timesheet(id),
  action        approval_action not null,
  from_status   timesheet_status,
  to_status     timesheet_status,
  actor_user_id uuid references app_user(id),
  reason        text,
  created_at    timestamptz not null default now(),

  -- Reopening a locked record requires a reason. The brief is explicit.
  constraint approval_reopen_reason check (
    action <> 'reopen' or (reason is not null and length(trim(reason)) > 0)
  )
);

create index approval_timesheet_idx on approval (timesheet_id, created_at);

-- --- attendance_exception --------------------------------------------------

create table attendance_exception (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  employee_id     uuid references employee(id),
  timesheet_id    uuid references timesheet(id),
  attendance_event_id uuid references attendance_event(id),
  exception_type  exception_type not null,
  severity        integer not null default 2,
  details         jsonb not null default '{}'::jsonb,
  status          exception_status not null default 'open',
  resolved_by     uuid references app_user(id),
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),

  -- One exception of a given type per timesheet — re-running the detector must
  -- not pile up duplicates for the office to wade through. NULLS NOT DISTINCT
  -- matters here: day-level exceptions (missing clock-out, long shift) carry no
  -- attendance_event_id, and the default NULL handling would let every rebuild
  -- insert another copy.
  constraint attendance_exception_dedupe
    unique nulls not distinct (company_id, timesheet_id, exception_type, attendance_event_id)
);

create index attendance_exception_open_idx
  on attendance_exception (company_id, status, created_at desc) where status = 'open';

-- --- odoo_sync_job ---------------------------------------------------------
-- The queue. Both directions: pull (employees, jobs) and push (attendance).

create table odoo_sync_job (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  direction       sync_direction not null,
  entity_type     text not null,          -- 'employee' | 'job' | 'timesheet' | ...
  entity_id       uuid,                   -- local row this job concerns
  operation       text not null,          -- 'import' | 'create' | 'update'
  payload         jsonb not null default '{}'::jsonb,

  status          sync_status not null default 'pending',
  attempts        integer not null default 0,
  max_attempts    integer not null default 8,
  next_attempt_at timestamptz not null default now(),
  last_error      text,

  -- The Odoo-side id once we have it. Presence of this is what makes a push
  -- an update rather than a create on retry.
  odoo_model      text,
  odoo_record_id  integer,

  -- Same guarantee as attendance_event: enqueueing twice is a no-op.
  idempotency_key text not null,

  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint odoo_sync_job_idempotency_unique unique (company_id, idempotency_key)
);

-- The worker's claim query: due, not finished, oldest first.
create index odoo_sync_job_due_idx on odoo_sync_job (next_attempt_at)
  where status in ('pending', 'failed');
create index odoo_sync_job_entity_idx on odoo_sync_job (entity_type, entity_id);

-- --- audit_log -------------------------------------------------------------

create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  actor_user_id uuid references app_user(id),
  action        text not null,
  table_name    text not null,
  record_id     uuid,
  before_value  jsonb,
  after_value   jsonb,
  reason        text,
  created_at    timestamptz not null default now()
);

create index audit_log_record_idx on audit_log (table_name, record_id, created_at desc);
create index audit_log_company_idx on audit_log (company_id, created_at desc);

-- --- device ----------------------------------------------------------------
-- Needed for push notifications and for the Phase 3 permission-health check.

create table device (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company(id),
  app_user_id       uuid not null references app_user(id),
  device_id         text not null,
  platform          text,
  app_version       text,
  push_token        text,
  location_permission text,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),

  constraint device_unique unique (app_user_id, device_id)
);
