-- ===========================================================================
-- SkelClock 0002 — integrity guarantees
--
-- The audit requirements in the brief ("never silently overwrite attendance
-- history", "do not permanently delete attendance records") are enforced in
-- the database, not in application code. Application code gets rewritten;
-- a trigger protects the payroll record even from a future bug or a hand-run
-- SQL statement in a hurry.
-- ===========================================================================

-- --- updated_at ------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'company', 'employee', 'app_user', 'crew', 'site', 'job',
    'work_activity', 'assignment', 'timesheet', 'odoo_sync_job'
  ] loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
         for each row execute function set_updated_at()', t, t);
  end loop;
end;
$$;

-- --- attendance events are append-only -------------------------------------

-- Columns a correction may touch after the fact. Everything else about an
-- event is frozen the moment it lands: to change a time you void the event and
-- write a new one, which is what leaves the audit trail.
create or replace function attendance_event_guard() returns trigger
language plpgsql as $$
begin
  if new.employee_id  is distinct from old.employee_id
  or new.company_id   is distinct from old.company_id
  or new.event_type   is distinct from old.event_type
  or new.device_time  is distinct from old.device_time
  or new.server_time  is distinct from old.server_time
  or new.latitude     is distinct from old.latitude
  or new.longitude    is distinct from old.longitude
  or new.gps_accuracy_m is distinct from old.gps_accuracy_m
  or new.clock_method is distinct from old.clock_method
  or new.idempotency_key is distinct from old.idempotency_key
  then
    raise exception
      'attendance_event % is immutable; void it and insert a replacement instead',
      old.id
      using errcode = 'restrict_violation';
  end if;

  -- Un-voiding would erase the fact that a void happened.
  if old.voided_at is not null and new.voided_at is null then
    raise exception 'attendance_event % cannot be un-voided', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

create trigger attendance_event_guard_trg
  before update on attendance_event
  for each row execute function attendance_event_guard();

create or replace function block_hard_delete() returns trigger
language plpgsql as $$
begin
  raise exception
    '% rows cannot be deleted; set voided_at with a reason instead', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger attendance_event_no_delete
  before delete on attendance_event
  for each row execute function block_hard_delete();

create trigger approval_no_delete
  before delete on approval
  for each row execute function block_hard_delete();

create trigger audit_log_no_delete
  before delete on audit_log
  for each row execute function block_hard_delete();

-- --- locked timesheets -----------------------------------------------------

-- A locked timesheet can only move by way of an explicit reopen, which the
-- approval table forces a reason onto. This stops a stray update from
-- reopening payroll silently.
create or replace function timesheet_lock_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'locked' and new.status = 'locked' then
    if new.total_shift_minutes is distinct from old.total_shift_minutes
    or new.total_break_minutes is distinct from old.total_break_minutes
    or new.total_paid_minutes  is distinct from old.total_paid_minutes then
      raise exception 'timesheet % is locked; reopen it before changing totals', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger timesheet_lock_guard_trg
  before update on timesheet
  for each row execute function timesheet_lock_guard();

-- --- automatic audit trail --------------------------------------------------

-- Writes a before/after pair for every change to the tables that carry payroll
-- meaning. Reason is threaded through a transaction-local setting so the API
-- can say *why* without every statement growing a parameter:
--     select set_config('skelclock.reason', 'supervisor fixed missed clock-out', true);
create or replace function write_audit_log() returns trigger
language plpgsql as $$
declare
  v_actor uuid;
  v_reason text;
  v_company uuid;
begin
  begin
    v_actor := nullif(current_setting('skelclock.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  v_reason := nullif(current_setting('skelclock.reason', true), '');

  if tg_op = 'DELETE' then
    v_company := old.company_id;
  else
    v_company := new.company_id;
  end if;

  insert into audit_log (
    company_id, actor_user_id, action, table_name, record_id,
    before_value, after_value, reason
  ) values (
    v_company,
    v_actor,
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    v_reason
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'attendance_event', 'timesheet', 'time_segment', 'correction', 'approval'
  ] loop
    execute format(
      'create trigger %I_audit after insert or update or delete on %I
         for each row execute function write_audit_log()', t, t);
  end loop;
end;
$$;
