-- ===========================================================================
-- SkelClock 0007 — outbound notifications
--
-- Push nudges and emailed summaries are sent by a sweep that runs on the same
-- cron as the Odoo sync worker. Crons overlap and retry, and a "you forgot to
-- clock off" that arrives three times teaches a worker to ignore the fourth —
-- so every logical message claims a row here first, and the unique constraint
-- is what makes sending exactly-once.
-- ===========================================================================

create table notification_log (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  employee_id   uuid references employee(id),
  -- 'missing_clock_out' | 'stale_suggestion' | 'weekly_summary'
  kind          text not null,
  -- What "already sent" means for that kind: employee+day for a nudge,
  -- attendance event id for a suggestion chase, employee+ISO week for the
  -- weekly summary.
  dedupe_key    text not null,
  -- 'push' | 'email' | 'log' (log = no real provider configured; dev mode)
  channel       text not null,
  detail        jsonb not null default '{}'::jsonb,
  sent_at       timestamptz not null default now(),

  constraint notification_log_dedupe unique (company_id, kind, dedupe_key)
);

create index notification_log_employee_idx
  on notification_log (employee_id, sent_at desc);

-- Server-only table: written via the service connection, never by a client.
-- RLS on with no policies = deny-all through the Data API on Supabase, and a
-- harmless no-op on the local PGlite database.
alter table notification_log enable row level security;
