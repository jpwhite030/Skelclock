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
