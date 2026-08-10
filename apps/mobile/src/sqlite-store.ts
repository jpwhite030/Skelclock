/**
 * On-device SQLite backing for the event queue.
 *
 * SQLite rather than AsyncStorage because the queue has to survive an app
 * crash mid-write. AsyncStorage's read-modify-write on a JSON blob can lose the
 * whole queue if the process dies between the read and the write; a SQLite
 * insert is atomic.
 *
 * The logic that uses this lives in queue.ts and is tested against an in-memory
 * store — this file is deliberately thin so there is little here to get wrong.
 */

import * as SQLite from 'expo-sqlite';

import type { QueueItemStatus, QueueStore, QueuedEvent } from './queue';

const SCHEMA = `
  create table if not exists event_queue (
    idempotency_key   text primary key,
    employee_id       text not null,
    event_type        text not null,
    device_time       text not null,
    job_id            text,
    work_activity_id  text,
    latitude          real,
    longitude         real,
    gps_accuracy_m    real,
    outside_reason    text,
    clock_method      text not null,
    was_offline       integer not null,
    device_id         text not null,
    status            text not null,
    attempts          integer not null default 0,
    last_error        text,
    queued_at         integer not null
  );
  create index if not exists event_queue_status_idx on event_queue (status, device_time);
`;

/**
 * Columns added after the first release.
 *
 * `create table if not exists` does nothing to a table that already exists, so
 * an app updating in place keeps the old shape and every insert naming a new
 * column fails. SQLite has no `add column if not exists`, and the error for
 * re-adding one is harmless — so each is attempted and its complaint ignored.
 * That is the whole migration story this queue needs: it is a spool, not a
 * database, and rows live in it for minutes.
 */
const ADDED_COLUMNS = ['alter table event_queue add column inside_since text'];

interface Row {
  idempotency_key: string;
  employee_id: string;
  event_type: string;
  device_time: string;
  job_id: string | null;
  work_activity_id: string | null;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy_m: number | null;
  outside_reason: string | null;
  clock_method: string;
  was_offline: number;
  device_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  queued_at: number;
  inside_since: string | null;
}

const toEvent = (r: Row): QueuedEvent => ({
  insideSince: r.inside_since ?? null,
  idempotencyKey: r.idempotency_key,
  employeeId: r.employee_id,
  eventType: r.event_type as QueuedEvent['eventType'],
  deviceTime: r.device_time,
  jobId: r.job_id,
  workActivityId: r.work_activity_id,
  latitude: r.latitude,
  longitude: r.longitude,
  gpsAccuracyM: r.gps_accuracy_m,
  outsideReason: r.outside_reason,
  clockMethod: r.clock_method as QueuedEvent['clockMethod'],
  wasOffline: r.was_offline === 1,
  deviceId: r.device_id,
  status: r.status as QueueItemStatus,
  attempts: r.attempts,
  lastError: r.last_error,
  queuedAt: r.queued_at,
});

export class SqliteQueueStore implements QueueStore {
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(name = 'skelclock.db'): Promise<SqliteQueueStore> {
    const db = await SQLite.openDatabaseAsync(name);
    // WAL keeps a read during a flush from blocking the next button press.
    await db.execAsync('pragma journal_mode = WAL;');
    await db.execAsync(SCHEMA);
    for (const statement of ADDED_COLUMNS) {
      // Already there on a fresh install and on the second launch after an
      // update — see the note on ADDED_COLUMNS.
      await db.execAsync(statement).catch(() => undefined);
    }
    return new SqliteQueueStore(db);
  }

  async insert(event: QueuedEvent): Promise<void> {
    // `or ignore` on the primary key: a re-render firing the handler twice
    // with the same key writes one row, not two.
    await this.db.runAsync(
      `insert or ignore into event_queue (
         idempotency_key, employee_id, event_type, device_time, job_id,
         work_activity_id, latitude, longitude, gps_accuracy_m, outside_reason,
         clock_method, was_offline, device_id, status, attempts, last_error, queued_at,
         inside_since
       ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.idempotencyKey,
        event.employeeId,
        event.eventType,
        event.deviceTime,
        event.jobId,
        event.workActivityId,
        event.latitude,
        event.longitude,
        event.gpsAccuracyM,
        event.outsideReason,
        event.clockMethod,
        event.wasOffline ? 1 : 0,
        event.deviceId,
        event.status,
        event.attempts,
        event.lastError,
        event.queuedAt,
        event.insideSince ?? null,
      ],
    );
  }

  async listByStatus(statuses: QueueItemStatus[]): Promise<QueuedEvent[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = await this.db.getAllAsync<Row>(
      `select * from event_queue where status in (${placeholders}) order by device_time asc`,
      statuses,
    );
    return rows.map(toEvent);
  }

  async update(
    idempotencyKey: string,
    patch: Partial<Pick<QueuedEvent, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?');
      params.push(patch.attempts);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(patch.lastError);
    }
    if (sets.length === 0) return;

    params.push(idempotencyKey);
    await this.db.runAsync(
      `update event_queue set ${sets.join(', ')} where idempotency_key = ?`,
      params,
    );
  }

  async delete(idempotencyKey: string): Promise<void> {
    await this.db.runAsync('delete from event_queue where idempotency_key = ?', [
      idempotencyKey,
    ]);
  }

  async countByStatus(status: QueueItemStatus): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      'select count(*) as n from event_queue where status = ?',
      [status],
    );
    return row?.n ?? 0;
  }

  /**
   * Recovers events left mid-flight by an app kill.
   *
   * Anything still 'syncing' at startup was interrupted before the server
   * answered. Putting it back to 'pending' is always safe: if the server did
   * receive it, the replay comes back 'duplicate' and the queue clears.
   */
  async recoverInterrupted(): Promise<number> {
    const result = await this.db.runAsync(
      `update event_queue set status = 'pending' where status = 'syncing'`,
    );
    return result.changes;
  }
}
