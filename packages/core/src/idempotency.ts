/**
 * Idempotency keys.
 *
 * Minted on the device the instant the worker presses the button, written to
 * on-device SQLite alongside the event, and replayed unchanged on every sync
 * attempt for the life of that event. The server's unique index on
 * (company_id, idempotency_key) turns "retry" into "no-op".
 *
 * Deliberately *not* derived from the event's contents. A content hash would
 * collapse two genuinely separate button presses that happened to land in the
 * same second — a supervisor clocking a crew of six in one tap produces six
 * events with identical timestamps and near-identical payloads.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;

/**
 * UUID v4, working the same on Node, Hermes and a browser.
 *
 * `node:crypto` is deliberately not imported: this module runs inside the
 * React Native app, where that import fails at bundle time. `crypto.randomUUID`
 * is used where the runtime has it, and built from `getRandomValues` where it
 * does not — Hermes has the latter but not always the former.
 */
function uuidV4(): string {
  const c = globalThis.crypto;

  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    // Version 4, variant 1 — the bits that make it a valid random UUID.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // No CSPRNG at all. Refuse rather than fall back to Math.random(): a
  // predictable idempotency key could let one worker's retry collide with
  // another's event, and losing a shift is worse than a loud failure.
  throw new Error(
    'No secure random source available; cannot mint an idempotency key safely.',
  );
}

/**
 * @param deviceId  short device identifier, so a key can be traced back to the
 *                  handset it came from when reconciling a bad sync.
 */
export function newIdempotencyKey(deviceId: string): string {
  return `${sanitiseDeviceId(deviceId)}.${uuidV4()}`;
}

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function sanitiseDeviceId(deviceId: string): string {
  const cleaned = deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Key for a queued Odoo sync job.
 *
 * Content-derived here, unlike attendance events, and that is the point:
 * enqueueing "push timesheet X" twice should collapse to one job. The
 * attempt counter is not part of the key, so a retry reuses the same row.
 */
export function syncJobKey(
  entityType: string,
  entityId: string,
  operation: string,
): string {
  return `${entityType}:${entityId}:${operation}`;
}
