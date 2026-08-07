/**
 * The wire contract between apps/web's API routes and apps/mobile.
 *
 * Zod schemas, not just TS types: a route handler validates its response
 * against these before sending, and the mobile client validates what it
 * receives. A route that stops matching its contract fails loudly — in
 * dev/tests on the server side, on first fetch on the mobile side — instead
 * of silently drifting until a worker hits it in the field.
 *
 * Pure data shapes only, no I/O, safe to import from a phone bundle — same
 * rule as @skelclock/core.
 */

export * from './home.js';
export * from './jobs.js';
export * from './activities.js';
export * from './events.js';
export * from './suggestions.js';
export * from './timesheets.js';
export * from './device.js';
export * from './consent.js';
