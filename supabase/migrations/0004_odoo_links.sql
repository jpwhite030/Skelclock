-- ===========================================================================
-- SkelClock 0004 — Odoo record links
--
-- Which hr.attendance record in Odoo corresponds to which block of one of our
-- timesheets. Without this, correcting a clock-in time after a successful sync
-- would leave the original record sitting in Odoo *and* create a second one —
-- exactly the double-paid-shift problem the MVP exists to remove.
--
-- Blocks are matched by ordinal position within the timesheet. That is stable
-- under a time correction (block 0 stays block 0 with a new check_in) which a
-- content-derived key would not be.
-- ===========================================================================

create table odoo_attendance_link (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  timesheet_id  uuid not null references timesheet(id),
  block_index   integer not null,
  odoo_model    text not null default 'hr.attendance',
  odoo_id       integer not null,
  check_in      timestamptz not null,
  check_out     timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint odoo_attendance_link_unique unique (timesheet_id, block_index)
);

create index odoo_attendance_link_timesheet_idx
  on odoo_attendance_link (timesheet_id, block_index);

create trigger odoo_attendance_link_set_updated_at
  before update on odoo_attendance_link
  for each row execute function set_updated_at();
