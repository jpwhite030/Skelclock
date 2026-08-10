import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newIdempotencyKey } from '@skelclock/core';

import {
  EventQueue,
  MemoryQueueStore,
  type IngestOutcomeDto,
  type QueuedEvent,
  type Transport,
} from './queue.js';

// --- harness ----------------------------------------------------------------

function press(
  eventType: QueuedEvent['eventType'],
  deviceTime: string,
): Omit<QueuedEvent, 'status' | 'attempts' | 'lastError' | 'queuedAt'> {
  return {
    idempotencyKey: newIdempotencyKey('pixel-8'),
    employeeId: 'emp-1',
    eventType,
    deviceTime,
    jobId: 'job-1',
    workActivityId: 'act-1',
    latitude: -34.4248,
    longitude: 150.8931,
    gpsAccuracyM: 7,
    outsideReason: null,
    clockMethod: 'manual',
    wasOffline: true,
    deviceId: 'pixel-8',
  };
}

class FakeTransport implements Transport {
  submitted: QueuedEvent[][] = [];
  constructor(
    private readonly handler: (events: QueuedEvent[]) => IngestOutcomeDto[] | Error,
  ) {}

  async submit(events: QueuedEvent[]): Promise<IngestOutcomeDto[]> {
    this.submitted.push(events);
    const result = this.handler(events);
    if (result instanceof Error) throw result;
    return result;
  }
}

const acceptAll = (): FakeTransport =>
  new FakeTransport((events) =>
    events.map((e) => ({
      idempotencyKey: e.idempotencyKey,
      status: 'created' as const,
      insideGeofence: null,
      distanceM: null,
      autoConfirmed: true,
    })),
  );

const offline = (): FakeTransport =>
  new FakeTransport(() => new Error('Network request failed'));

// --- tests ------------------------------------------------------------------

test('a button press is durable before anything is sent', async () => {
  const store = new MemoryQueueStore();
  const queue = new EventQueue(store, offline());

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));

  assert.equal(await queue.pendingCount(), 1);
  assert.equal(store.all()[0]!.status, 'pending');
});

test('an accepted event leaves the queue', async () => {
  const store = new MemoryQueueStore();
  const queue = new EventQueue(store, acceptAll());

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  const result = await queue.flush();

  assert.equal(result.accepted, 1);
  assert.equal(await queue.pendingCount(), 0);
  assert.equal(store.all().length, 0);
});

test('a full offline day survives and syncs in device-time order', async () => {
  const store = new MemoryQueueStore();
  const transport = acceptAll();
  const queue = new EventQueue(store, transport);

  // Pressed in this order through the day, with no reception at any point.
  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  await queue.enqueue(press('break_start', '2026-08-04T09:00:00+10:00'));
  await queue.enqueue(press('break_end', '2026-08-04T09:30:00+10:00'));
  await queue.enqueue(press('clock_out', '2026-08-04T14:30:00+10:00'));

  assert.equal(await queue.pendingCount(), 4);

  const result = await queue.flush();
  assert.equal(result.accepted, 4);

  // One request, so the server can replay the sequence through the state
  // machine intact.
  assert.equal(transport.submitted.length, 1);
  assert.deepEqual(
    transport.submitted[0]!.map((e) => e.eventType),
    ['clock_in', 'break_start', 'break_end', 'clock_out'],
  );
});

test('device times are preserved verbatim through a late sync', async () => {
  const store = new MemoryQueueStore();
  const transport = acceptAll();
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  await queue.flush();

  assert.equal(transport.submitted[0]![0]!.deviceTime, '2026-08-04T06:00:00+10:00');
});

test('no reception means nothing is lost and nothing burns a retry', async () => {
  const store = new MemoryQueueStore();
  const queue = new EventQueue(store, offline());

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));

  for (let i = 0; i < 50; i += 1) {
    const result = await queue.flush();
    assert.equal(result.offline, true);
    assert.equal(result.accepted, 0);
  }

  // Still queued, still pending, attempts untouched — a week with no signal
  // must not exhaust the event.
  assert.equal(await queue.pendingCount(), 1);
  assert.equal(store.all()[0]!.attempts, 0);
  assert.equal(store.all()[0]!.status, 'pending');
});

test('reception returning flushes the whole backlog', async () => {
  const store = new MemoryQueueStore();
  let online = false;
  const transport = new FakeTransport((events) =>
    online
      ? events.map((e) => ({
          idempotencyKey: e.idempotencyKey,
          status: 'created' as const,
          insideGeofence: null,
          distanceM: null,
          autoConfirmed: true,
        }))
      : new Error('Network request failed'),
  );
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  await queue.enqueue(press('clock_out', '2026-08-04T14:30:00+10:00'));
  await queue.flush();
  assert.equal(await queue.pendingCount(), 2);

  online = true;
  const result = await queue.flush();
  assert.equal(result.accepted, 2);
  assert.equal(await queue.pendingCount(), 0);
});

test('a duplicate response clears the queue — it means the server already has it', async () => {
  // The exact failure this protects against: the POST succeeded but the
  // response was lost, so the phone retries. Treating 'duplicate' as an error
  // would leave the event stuck in the queue forever.
  const store = new MemoryQueueStore();
  const transport = new FakeTransport((events) =>
    events.map((e) => ({ idempotencyKey: e.idempotencyKey, status: 'duplicate' as const })),
  );
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  const result = await queue.flush();

  assert.equal(result.accepted, 1);
  assert.equal(await queue.pendingCount(), 0);
});

test('the idempotency key never changes across retries', async () => {
  const store = new MemoryQueueStore();
  let online = false;
  const transport = new FakeTransport((events) =>
    online
      ? events.map((e) => ({
          idempotencyKey: e.idempotencyKey,
          status: 'created' as const,
          insideGeofence: null,
          distanceM: null,
          autoConfirmed: true,
        }))
      : new Error('offline'),
  );
  const queue = new EventQueue(store, transport);

  const queued = await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));

  await queue.flush();
  await queue.flush();
  online = true;
  await queue.flush();

  const keysSeen = transport.submitted.flat().map((e) => e.idempotencyKey);
  assert.equal(new Set(keysSeen).size, 1);
  assert.equal(keysSeen[0], queued.idempotencyKey);
});

test('a rejection is kept and explained rather than retried forever', async () => {
  const store = new MemoryQueueStore();
  const transport = new FakeTransport((events) =>
    events.map((e) => ({
      idempotencyKey: e.idempotencyKey,
      status: 'rejected' as const,
      code: 'already_clocked_in',
      message: 'You are already clocked in.',
    })),
  );
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  const result = await queue.flush();

  assert.equal(result.rejected, 1);
  assert.equal(result.rejections[0]!.code, 'already_clocked_in');
  assert.equal(result.rejections[0]!.message, 'You are already clocked in.');

  // Not pending any more, so it will not be resubmitted...
  assert.equal(await queue.pendingCount(), 0);
  // ...but it is still on the device for the worker to see.
  assert.equal(store.all()[0]!.status, 'rejected');
  assert.equal((await queue.pending()).length, 1);

  await queue.dismissRejection(store.all()[0]!.idempotencyKey);
  assert.equal((await queue.pending()).length, 0);
});

test('an event the server ignores is retried, then surfaced', async () => {
  const store = new MemoryQueueStore();
  const transport = new FakeTransport(() => []); // acknowledges nothing
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));

  for (let i = 0; i < 9; i += 1) {
    await queue.flush();
    assert.equal(await queue.pendingCount(), 1, `still pending after ${i + 1} attempts`);
  }

  await queue.flush();
  assert.equal(await queue.pendingCount(), 0);
  assert.equal(store.all()[0]!.status, 'rejected');
});

test('a double-tap on the same render does not queue twice', async () => {
  const store = new MemoryQueueStore();
  const queue = new EventQueue(store, acceptAll());

  const event = press('clock_in', '2026-08-04T06:00:00+10:00');
  await queue.enqueue(event);
  await queue.enqueue(event); // same key — the UI re-fired

  assert.equal(await queue.pendingCount(), 1);
});

test('flushing an empty queue is a no-op that touches no network', async () => {
  const store = new MemoryQueueStore();
  const transport = acceptAll();
  const queue = new EventQueue(store, transport);

  const result = await queue.flush();
  assert.equal(result.attempted, 0);
  assert.equal(transport.submitted.length, 0);
});

test('a partial batch response settles each event on its own merits', async () => {
  const store = new MemoryQueueStore();
  const transport = new FakeTransport((events) => [
    {
      idempotencyKey: events[0]!.idempotencyKey,
      status: 'created',
      insideGeofence: null,
      distanceM: null,
      autoConfirmed: true,
    },
    {
      idempotencyKey: events[1]!.idempotencyKey,
      status: 'rejected',
      code: 'not_clocked_in',
      message: 'You are not clocked in.',
    },
  ]);
  const queue = new EventQueue(store, transport);

  await queue.enqueue(press('clock_in', '2026-08-04T06:00:00+10:00'));
  await queue.enqueue(press('break_end', '2026-08-04T09:30:00+10:00'));

  const result = await queue.flush();

  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(store.all().length, 1);
  assert.equal(store.all()[0]!.eventType, 'break_end');
});
