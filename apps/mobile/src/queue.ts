/**
 * The offline event queue.
 *
 * This is the piece the brief calls mandatory, and the one most likely to cost
 * someone a day's pay if it is wrong. The contract:
 *
 *   * A button press is written to local storage BEFORE anything is sent. If
 *     the app is killed, the battery dies, or the phone goes in a skip bin, the
 *     event is already durable.
 *   * The idempotency key is minted once, at press time, and never changes. The
 *     same event can be posted any number of times and the server keeps one.
 *   * device_time is captured at press time and never rewritten. A shift that
 *     syncs at 5pm still says the worker started at 6am.
 *   * Nothing is deleted from the queue until the server confirms it, and a
 *     server rejection is kept (not dropped) so the worker can be told why.
 *
 * Storage is behind an interface so this logic runs under `node --test` against
 * an in-memory store, rather than only being exercisable on a handset.
 */

import type { AttendanceEventType, ClockMethod } from '@skelclock/core';
import type { IngestOutcomeDto } from '@skelclock/contracts';

export type QueueItemStatus = 'pending' | 'syncing' | 'synced' | 'rejected';

export interface QueuedEvent {
  idempotencyKey: string;
  employeeId: string;
  eventType: AttendanceEventType;
  /** ISO 8601 with the device's offset, captured at press time. */
  deviceTime: string;
  jobId: string | null;
  workActivityId: string | null;
  latitude: number | null;
  longitude: number | null;
  gpsAccuracyM: number | null;
  outsideReason: string | null;
  clockMethod: ClockMethod;
  wasOffline: boolean;
  deviceId: string;
  /** Auto-geofence only: every assigned job whose fence the fix fell inside. */
  candidateJobIds?: string[] | null;
  status: QueueItemStatus;
  attempts: number;
  lastError: string | null;
  /** ms since epoch, for ordering and for the "queued 3 min ago" label. */
  queuedAt: number;
}

export interface QueueStore {
  insert(event: QueuedEvent): Promise<void>;
  /** Oldest first, by device time — the order the worker performed them. */
  listByStatus(statuses: QueueItemStatus[]): Promise<QueuedEvent[]>;
  update(
    idempotencyKey: string,
    patch: Partial<Pick<QueuedEvent, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<void>;
  delete(idempotencyKey: string): Promise<void>;
  countByStatus(status: QueueItemStatus): Promise<number>;
}

export type { IngestOutcomeDto };

export interface Transport {
  submit(events: QueuedEvent[]): Promise<IngestOutcomeDto[]>;
}

export interface FlushResult {
  attempted: number;
  accepted: number;
  rejected: number;
  /** True when the flush stopped because the network was unavailable. */
  offline: boolean;
  rejections: Array<{ idempotencyKey: string; code: string; message: string }>;
  /**
   * Detail for events the server newly created (not 'duplicate'), keyed by
   * idempotency key — lets a caller that enqueued exactly one event, like the
   * geofence task, find out what happened to it without reaching into the
   * queue's internals.
   */
  created: Array<{ idempotencyKey: string; autoConfirmed: boolean }>;
}

/**
 * How many times a rejected-looking failure is retried before the worker is
 * shown it. Network errors are not counted against this — they retry forever,
 * because "no reception until Friday" must not exhaust a shift's retries.
 */
const MAX_ATTEMPTS = 10;

export class EventQueue {
  constructor(
    private readonly store: QueueStore,
    private readonly transport: Transport,
  ) {}

  /**
   * Records a button press. Returns once it is durably stored — the caller
   * should update the UI off this, not off the network round trip.
   */
  async enqueue(
    event: Omit<QueuedEvent, 'status' | 'attempts' | 'lastError' | 'queuedAt'>,
  ): Promise<QueuedEvent> {
    const item: QueuedEvent = {
      ...event,
      status: 'pending',
      attempts: 0,
      lastError: null,
      queuedAt: Date.now(),
    };
    await this.store.insert(item);
    return item;
  }

  async pendingCount(): Promise<number> {
    return this.store.countByStatus('pending');
  }

  /** Everything not yet accepted, for the "pending sync" panel. */
  async pending(): Promise<QueuedEvent[]> {
    return this.store.listByStatus(['pending', 'syncing', 'rejected']);
  }

  /**
   * Sends everything queued, oldest first.
   *
   * The whole batch goes in one request so the server can replay it through
   * the state machine in device-time order. Sending them one at a time would
   * let a clock-out arrive before its clock-in on a flaky connection.
   */
  async flush(): Promise<FlushResult> {
    const batch = await this.store.listByStatus(['pending']);

    const result: FlushResult = {
      attempted: batch.length,
      accepted: 0,
      rejected: 0,
      offline: false,
      rejections: [],
      created: [],
    };
    if (batch.length === 0) return result;

    for (const item of batch) {
      await this.store.update(item.idempotencyKey, { status: 'syncing' });
    }

    let outcomes: IngestOutcomeDto[];
    try {
      outcomes = await this.transport.submit(batch);
    } catch (error) {
      // Network failure: put everything back and leave it for the next attempt.
      // Deliberately does NOT increment attempts — see MAX_ATTEMPTS above.
      const message = error instanceof Error ? error.message : String(error);
      for (const item of batch) {
        await this.store.update(item.idempotencyKey, {
          status: 'pending',
          lastError: message,
        });
      }
      result.offline = true;
      return result;
    }

    const byKey = new Map(outcomes.map((o) => [o.idempotencyKey, o]));

    for (const item of batch) {
      const outcome = byKey.get(item.idempotencyKey);

      if (!outcome) {
        // The server did not mention it. Treat as unsent and retry, but count
        // the attempt so a permanently ignored event eventually surfaces.
        const attempts = item.attempts + 1;
        await this.store.update(item.idempotencyKey, {
          status: attempts >= MAX_ATTEMPTS ? 'rejected' : 'pending',
          attempts,
          lastError: 'Server did not acknowledge this event',
        });
        continue;
      }

      // 'duplicate' is success: the server already has it. That is exactly what
      // a retry after a lost response looks like, and it must clear the queue.
      if (outcome.status === 'created' || outcome.status === 'duplicate') {
        await this.store.delete(item.idempotencyKey);
        result.accepted += 1;
        if (outcome.status === 'created') {
          result.created.push({
            idempotencyKey: item.idempotencyKey,
            autoConfirmed: outcome.autoConfirmed,
          });
        }
        continue;
      }

      // A rejection is a decision, not a failure — retrying "already clocked
      // in" forever would never succeed. Keep it so the worker can be told.
      await this.store.update(item.idempotencyKey, {
        status: 'rejected',
        attempts: item.attempts + 1,
        lastError: outcome.message ?? outcome.code ?? 'Rejected',
      });
      result.rejected += 1;
      result.rejections.push({
        idempotencyKey: item.idempotencyKey,
        code: outcome.code ?? 'rejected',
        message: outcome.message ?? 'The server rejected this event.',
      });
    }

    return result;
  }

  /** Clears a rejection the worker has read and acknowledged. */
  async dismissRejection(idempotencyKey: string): Promise<void> {
    await this.store.delete(idempotencyKey);
  }
}

// --- in-memory store (tests, and the Expo dev fallback) ---------------------

export class MemoryQueueStore implements QueueStore {
  private readonly items = new Map<string, QueuedEvent>();

  async insert(event: QueuedEvent): Promise<void> {
    // Insert-or-ignore: re-pressing during a render loop must not double up.
    if (!this.items.has(event.idempotencyKey)) {
      this.items.set(event.idempotencyKey, { ...event });
    }
  }

  async listByStatus(statuses: QueueItemStatus[]): Promise<QueuedEvent[]> {
    return [...this.items.values()]
      .filter((i) => statuses.includes(i.status))
      .sort((a, b) => Date.parse(a.deviceTime) - Date.parse(b.deviceTime));
  }

  async update(
    idempotencyKey: string,
    patch: Partial<Pick<QueuedEvent, 'status' | 'attempts' | 'lastError'>>,
  ): Promise<void> {
    const existing = this.items.get(idempotencyKey);
    if (existing) this.items.set(idempotencyKey, { ...existing, ...patch });
  }

  async delete(idempotencyKey: string): Promise<void> {
    this.items.delete(idempotencyKey);
  }

  async countByStatus(status: QueueItemStatus): Promise<number> {
    return [...this.items.values()].filter((i) => i.status === status).length;
  }

  /** Test helper. */
  all(): QueuedEvent[] {
    return [...this.items.values()];
  }
}
