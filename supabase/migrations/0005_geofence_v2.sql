-- ===========================================================================
-- SkelClock 0005 — geofencing hardening
--
--   * candidate_job_ids: when a fix falls inside more than one assigned job's
--     geofence at once, ingest.ts stores every candidate here instead of
--     guessing. Never auto-confirmed while ambiguous — the worker picks.
--   * geofence_consent_event: an append-only log of the worker opting in or
--     out of background auto-detect, mirroring attendance_event's own
--     "never overwrite, always append" rule. This is the audit trail behind
--     the in-app notice a worker agrees to before auto-detect turns on.
-- ===========================================================================

alter table attendance_event
  add column candidate_job_ids uuid[];

create table geofence_consent_event (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  employee_id     uuid not null references employee(id),
  app_user_id     uuid references app_user(id),
  action          text not null check (action in ('granted', 'revoked')),
  policy_version  text not null,
  device_id       text,
  created_at      timestamptz not null default now()
);

create index geofence_consent_event_employee_idx
  on geofence_consent_event (employee_id, created_at desc);

-- The fence default drops from 200m to 70m: geofence v2 acts on the fence
-- (auto-confirm, and a clock-on refused outright when confidently outside),
-- and 200m of slack around a suburban site is wide enough that "inside" stops
-- meaning much.
--
-- Set here rather than by editing 0001 in place. scripts/apply-migrations.ts
-- records applied filenames and skips them, so a database that has already run
-- 0001 would never see an edit to it — the schema in the repo and the schema in
-- the database would silently disagree. Only new files ever reach an existing
-- database, so a change to an applied migration has to arrive as one.
--
-- Existing rows keep whatever radius the office set for them; a default is for
-- rows that do not exist yet, and silently re-fencing live sites is not this
-- migration's business.
alter table site alter column geofence_radius_m set default 70;
