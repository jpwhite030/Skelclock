/**
 * Odoo synchronisation queue.
 *
 * A durable queue in Postgres rather than an in-process job runner, because
 * the failure this has to survive is the whole server restarting mid-push. A
 * queued row with a retry schedule survives that; an in-memory promise does
 * not, and a shift that silently never reached payroll is the worst outcome
 * this system can produce.
 *
 * The office-facing contract: every row here is visible on the Odoo Sync
 * screen with its error text and a Retry button.
 */

import { syncJobKey } from '@skelclock/core';
import {
  buildAttendanceBlocks,
  type OdooAdapter,
  type SegmentForPush,
} from '@skelclock/odoo';

import { one, withTransaction, type Db } from './db.js';
import { markTimesheetSynced } from './approval.js';

export interface SyncJobRow {
  id: string;
  company_id: string;
  direction: 'pull' | 'push';
  entity_type: string;
  entity_id: string | null;
  operation: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  odoo_record_id: number | null;
}

/**
 * Backoff schedule, in minutes, indexed by attempt count.
 *
 * Front-loaded because most failures are a dropped connection that clears in
 * seconds; the tail is long enough that an Odoo instance down for maintenance
 * over a weekend is still retried rather than declared dead.
 */
const BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60, 180, 360];

function nextAttemptAt(attempts: number, from: Date): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)]!;
  return new Date(from.getTime() + minutes * 60_000);
}

// --- enqueue ----------------------------------------------------------------

export async function enqueueTimesheetPush(
  db: Db,
  args: { companyId: string; timesheetId: string; now?: Date },
): Promise<string> {
  const key = syncJobKey('timesheet', args.timesheetId, 'push_attendance');

  const row = await one<{ id: string }>(
    db,
    `insert into odoo_sync_job (
       company_id, direction, entity_type, entity_id, operation,
       payload, idempotency_key, next_attempt_at, odoo_model
     ) values ($1,'push','timesheet',$2,'push_attendance','{}'::jsonb,$3,$4,'hr.attendance')
     -- Already queued? Wake the existing row rather than queue a second copy:
     -- a supervisor approving, un-approving and re-approving must not produce
     -- three pushes of the same day.
     --
     -- 'success' is reset too, and that is the case that matters most: a
     -- correction to an already-synced day has to be pushed again, and the
     -- reconcile-by-ordinal logic in pushTimesheet updates the existing Odoo
     -- record rather than adding a second one. 'running' is left alone so a
     -- re-enqueue cannot yank a job out from under a worker mid-push.
     on conflict (company_id, idempotency_key) do update
       set status = case
             when odoo_sync_job.status = 'running' then odoo_sync_job.status
             else 'pending'
           end,
           attempts = case
             when odoo_sync_job.status in ('failed', 'dead', 'success') then 0
             else odoo_sync_job.attempts
           end,
           completed_at = null,
           next_attempt_at = least(odoo_sync_job.next_attempt_at, excluded.next_attempt_at),
           updated_at = now()
     returning id`,
    [args.companyId, args.timesheetId, key, (args.now ?? new Date()).toISOString()],
  );

  return row!.id;
}

/** Office "Retry" button: clear the error and make it due immediately. */
export async function retrySyncJob(db: Db, jobId: string): Promise<void> {
  await db.query(
    `update odoo_sync_job
        set status = 'pending', next_attempt_at = now(), last_error = null,
            -- Reset the counter so a manual retry gets the full backoff
            -- ladder again instead of dying on the next failure.
            attempts = 0, updated_at = now()
      where id = $1 and status in ('failed', 'dead')`,
    [jobId],
  );
}

// --- worker -----------------------------------------------------------------

export interface RunSyncOptions {
  companyId?: string;
  limit?: number;
  now?: Date;
}

export interface SyncRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ jobId: string; error: string }>;
}

export async function runSyncWorker(
  db: Db,
  adapter: OdooAdapter,
  options: RunSyncOptions = {},
): Promise<SyncRunResult> {
  const { limit = 25, now = new Date() } = options;
  const result: SyncRunResult = { processed: 0, succeeded: 0, failed: 0, errors: [] };

  for (;;) {
    if (result.processed >= limit) break;

    const job = await claimNext(db, { companyId: options.companyId, now });
    if (!job) break;

    result.processed += 1;

    try {
      const outcome = await execute(db, adapter, job, now);
      await db.query(
        `update odoo_sync_job
            set status = 'success', completed_at = now(), last_error = null,
                odoo_record_id = $2, payload = $3, updated_at = now()
          where id = $1`,
        [job.id, outcome.odooRecordId, JSON.stringify(outcome.payload)],
      );
      result.succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      // 'dead' means stop retrying and put it in front of a human. It is not
      // deleted — the record is still owed to payroll.
      const status = attempts >= job.max_attempts ? 'dead' : 'failed';

      await db.query(
        `update odoo_sync_job
            set status = $2, attempts = $3, last_error = $4,
                next_attempt_at = $5, updated_at = now()
          where id = $1`,
        [job.id, status, attempts, message.slice(0, 2000), nextAttemptAt(attempts, now).toISOString()],
      );

      await raiseSyncException(db, job, message);

      result.failed += 1;
      result.errors.push({ jobId: job.id, error: message });
    }
  }

  return result;
}

async function claimNext(
  db: Db,
  args: { companyId?: string; now: Date },
): Promise<SyncJobRow | null> {
  // Claim-by-update so two workers cannot pick up the same row. SKIP LOCKED
  // means a busy row is passed over rather than blocking the whole queue.
  const { rows } = await db.query<SyncJobRow>(
    `update odoo_sync_job
        set status = 'running', started_at = now(), updated_at = now()
      where id = (
        select id from odoo_sync_job
         where status in ('pending', 'failed')
           and next_attempt_at <= $1
           and ($2::uuid is null or company_id = $2)
         order by next_attempt_at asc
         limit 1
         for update skip locked
      )
      returning id, company_id, direction, entity_type, entity_id, operation,
                payload, status, attempts, max_attempts, last_error, odoo_record_id`,
    [args.now.toISOString(), args.companyId ?? null],
  );
  return rows[0] ?? null;
}

interface ExecuteOutcome {
  odooRecordId: number | null;
  payload: Record<string, unknown>;
}

async function execute(
  db: Db,
  adapter: OdooAdapter,
  job: SyncJobRow,
  now: Date,
): Promise<ExecuteOutcome> {
  if (job.entity_type === 'timesheet' && job.operation === 'push_attendance') {
    return pushTimesheet(db, adapter, job, now);
  }
  throw new Error(`No handler for ${job.entity_type}/${job.operation}`);
}

/**
 * Pushes one approved day into Odoo.
 *
 * Reconciles rather than appends: the desired blocks are matched against what
 * we previously created in Odoo by ordinal position, so a correction updates
 * the existing record and a day that shrank from two blocks to one has the
 * spare record removed. That is what keeps Odoo's hours equal to ours after a
 * correction instead of a superset of every version we ever pushed.
 */
async function pushTimesheet(
  db: Db,
  adapter: OdooAdapter,
  job: SyncJobRow,
  now: Date,
): Promise<ExecuteOutcome> {
  const timesheetId = job.entity_id;
  if (!timesheetId) throw new Error('Sync job has no timesheet id');

  const sheet = await one<{
    id: string;
    company_id: string;
    employee_id: string;
    status: string;
    employee_odoo_id: number | null;
    employee_name: string;
  }>(
    db,
    `select t.id, t.company_id, t.employee_id, t.status,
            e.odoo_id as employee_odoo_id, e.full_name as employee_name
       from timesheet t join employee e on e.id = t.employee_id
      where t.id = $1`,
    [timesheetId],
  );
  if (!sheet) throw new Error(`Timesheet ${timesheetId} no longer exists`);

  if (!['supervisor_approved', 'synced', 'locked'].includes(sheet.status)) {
    throw new Error(
      `Timesheet is "${sheet.status}" — only approved days are pushed to Odoo.`,
    );
  }
  if (!sheet.employee_odoo_id) {
    throw new Error(
      `${sheet.employee_name} has no Odoo employee id. Re-run the employee import.`,
    );
  }

  const { rows: segmentRows } = await db.query<{
    id: string;
    segment_type: SegmentForPush['segmentType'];
    start_time: Date | string;
    end_time: Date | string | null;
    is_paid: boolean;
  }>(
    `select id, segment_type, start_time, end_time, is_paid
       from time_segment where timesheet_id = $1 order by start_time asc`,
    [timesheetId],
  );

  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : String(v ?? '');

  const { blocks, skipped } = buildAttendanceBlocks(
    segmentRows.map((r) => ({
      id: r.id,
      segmentType: r.segment_type,
      startTime: iso(r.start_time),
      endTime: r.end_time ? iso(r.end_time) : null,
      isPaid: r.is_paid,
    })),
  );

  if (blocks.length === 0) {
    throw new Error(
      skipped.length > 0
        ? `Nothing to push: ${skipped[0]!.reason}.`
        : 'Nothing to push: the day has no completed paid time.',
    );
  }

  // Existing Odoo records for this day, by ordinal position.
  const { rows: linkRows } = await db.query<{ block_index: number; odoo_id: number }>(
    'select block_index, odoo_id from odoo_attendance_link where timesheet_id = $1 order by block_index',
    [timesheetId],
  );
  const links = new Map(linkRows.map((r) => [r.block_index, r.odoo_id]));

  const refFor = (index: number): string => `${timesheetId}#${index}`;
  const knownOdooIds: Record<string, number> = {};
  const indexed = blocks.map((block, index) => {
    const existing = links.get(index);
    if (existing !== undefined) knownOdooIds[refFor(index)] = existing;
    return { ...block, localRef: refFor(index), index };
  });

  const pushResult = await adapter.pushAttendance({
    employeeOdooId: sheet.employee_odoo_id,
    blocks: indexed.map(({ localRef, checkIn, checkOut }) => ({ localRef, checkIn, checkOut })),
    knownOdooIds,
  });

  // Blocks that existed on a previous push and no longer do.
  const orphanIds = [...links.entries()]
    .filter(([index]) => index >= blocks.length)
    .map(([, odooId]) => odooId);

  if (orphanIds.length > 0) {
    await adapter.unlinkAttendance(orphanIds);
  }

  await withTransaction(
    db,
    async (tx) => {
      for (const block of indexed) {
        const odooId = pushResult.odooIds[block.localRef];
        if (odooId === undefined) continue;
        await tx.query(
          `insert into odoo_attendance_link (
             company_id, timesheet_id, block_index, odoo_id, check_in, check_out
           ) values ($1,$2,$3,$4,$5,$6)
           on conflict (timesheet_id, block_index) do update
             set odoo_id = excluded.odoo_id,
                 check_in = excluded.check_in,
                 check_out = excluded.check_out`,
          [sheet.company_id, timesheetId, block.index, odooId, block.checkIn, block.checkOut],
        );
      }

      if (orphanIds.length > 0) {
        await tx.query(
          'delete from odoo_attendance_link where timesheet_id = $1 and block_index >= $2',
          [timesheetId, blocks.length],
        );
      }
    },
    { reason: 'odoo attendance push' },
  );

  if (sheet.status === 'supervisor_approved') {
    await markTimesheetSynced(db, {
      timesheetId,
      actorUserId: null,
      reason: 'Pushed to Odoo',
    });
  }

  // Any earlier sync-failure exception for this day is now stale.
  await db.query(
    `update attendance_exception
        set status = 'resolved', resolved_at = now(),
            resolution_note = 'Sync succeeded on retry'
      where timesheet_id = $1 and exception_type = 'odoo_sync_failure' and status = 'open'`,
    [timesheetId],
  );

  const firstId = pushResult.odooIds[refFor(0)] ?? null;

  return {
    odooRecordId: firstId,
    payload: {
      odooIds: pushResult.odooIds,
      created: pushResult.created,
      updated: pushResult.updated,
      removed: orphanIds.length,
      blocks: blocks.length,
      skipped,
      pushedAt: now.toISOString(),
    },
  };
}

async function raiseSyncException(
  db: Db,
  job: SyncJobRow,
  message: string,
): Promise<void> {
  if (job.entity_type !== 'timesheet' || !job.entity_id) return;

  const sheet = await one<{ employee_id: string }>(
    db,
    'select employee_id from timesheet where id = $1',
    [job.entity_id],
  );
  if (!sheet) return;

  await db.query(
    `insert into attendance_exception (
       company_id, employee_id, timesheet_id, exception_type, severity, details, status
     ) values ($1,$2,$3,'odoo_sync_failure',1,$4,'open')
     on conflict (company_id, timesheet_id, exception_type, attendance_event_id)
     do update set details = excluded.details, status = 'open'`,
    [
      job.company_id,
      sheet.employee_id,
      job.entity_id,
      JSON.stringify({ message, syncJobId: job.id, attempts: job.attempts + 1 }),
    ],
  );
}
