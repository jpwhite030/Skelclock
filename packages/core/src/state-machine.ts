/**
 * Clock state machine.
 *
 * Two different things stop duplicate attendance records, and both are needed:
 *
 *   1. `idempotency_key` — a UUID minted once when the worker presses the
 *      button and replayed on every retry. Protects against the network: the
 *      phone can POST the same queued event twenty times and get one row.
 *
 *   2. This state machine — protects against the *worker*. A double-tap on
 *      "Clock in" mints two different keys, so idempotency alone would happily
 *      write two clock-ins. Here the second one is rejected because you cannot
 *      clock in while already clocked in.
 *
 * It also runs on the phone, before an event is queued, so a worker with no
 * reception gets the same "you're already clocked in" answer immediately
 * rather than a surprise rejection at sync time hours later.
 */

import type { AttendanceEventType, StoredAttendanceEvent } from './types.js';

export type ClockState = 'off' | 'working' | 'on_break';

export interface TransitionOk {
  ok: true;
  nextState: ClockState;
  /**
   * Set when the event is legal but implies fixing up something the worker
   * forgot — clocking out straight from a break auto-closes the break.
   */
  implicitBreakEnd?: boolean;
}

export interface TransitionError {
  ok: false;
  code:
    | 'already_clocked_in'
    | 'not_clocked_in'
    | 'already_on_break'
    | 'not_on_break'
    | 'job_change_requires_clock_in'
    | 'out_of_order';
  message: string;
}

export type TransitionResult = TransitionOk | TransitionError;

/** Fold an ordered event list down to the worker's current state. */
export function deriveState(events: readonly StoredAttendanceEvent[]): ClockState {
  let state: ClockState = 'off';
  for (const e of orderedLiveEvents(events)) {
    const result = applyTransition(state, e.eventType);
    // Historical events that no longer make sense (e.g. a supervisor voided the
    // clock-in underneath them) are skipped rather than throwing — we still owe
    // the worker a usable screen.
    if (result.ok) state = result.nextState;
  }
  return state;
}

/**
 * Live events, oldest first, by device time.
 *
 * Device time — not server time — is the ordering key, because an offline day
 * arrives at the server all at once and in whatever order the queue flushed.
 * The worker's own clock is the only thing that knows the real sequence.
 * Ties break on server time so a same-second pair is still deterministic.
 */
export function orderedLiveEvents(
  events: readonly StoredAttendanceEvent[],
): StoredAttendanceEvent[] {
  return events
    .filter((e) => !e.voidedAt && !e.isSuggested)
    .slice()
    .sort((a, b) => {
      const d = Date.parse(a.deviceTime) - Date.parse(b.deviceTime);
      if (d !== 0) return d;
      return Date.parse(a.serverTime) - Date.parse(b.serverTime);
    });
}

/**
 * The events belonging to the shift that is currently open, or null.
 *
 * Needed because a 48-hour lookback — the window required to catch a night
 * shift — also catches yesterday's finished shift. Summing that whole window
 * reports a worker who started at 6:30 this morning as having done fourteen
 * hours, and shows yesterday's clock-in time on the supervisor's screen.
 *
 * The shift begins at the last clock_in not followed by a clock_out.
 */
export function currentShift(
  events: readonly StoredAttendanceEvent[],
): { events: StoredAttendanceEvent[]; timesheetId: string | null } | null {
  const ordered = orderedLiveEvents(events);

  let startIndex = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    const type = ordered[i]!.eventType;
    if (type === 'clock_in') startIndex = i;
    else if (type === 'clock_out') startIndex = -1;
  }

  if (startIndex === -1) return null;

  const shift = ordered.slice(startIndex);
  return { events: shift, timesheetId: shift[0]?.timesheetId ?? null };
}

export function applyTransition(
  state: ClockState,
  eventType: AttendanceEventType,
): TransitionResult {
  switch (eventType) {
    case 'clock_in':
      if (state !== 'off') {
        return {
          ok: false,
          code: 'already_clocked_in',
          message: 'You are already clocked in.',
        };
      }
      return { ok: true, nextState: 'working' };

    case 'clock_out':
      if (state === 'off') {
        return {
          ok: false,
          code: 'not_clocked_in',
          message: 'You are not clocked in, so there is nothing to clock out of.',
        };
      }
      // Forgetting to end a break before knocking off is extremely common.
      // Accept it and close the break at the same timestamp.
      return { ok: true, nextState: 'off', implicitBreakEnd: state === 'on_break' };

    case 'break_start':
      if (state === 'off') {
        return {
          ok: false,
          code: 'not_clocked_in',
          message: 'Clock in before starting a break.',
        };
      }
      if (state === 'on_break') {
        return {
          ok: false,
          code: 'already_on_break',
          message: 'You are already on a break.',
        };
      }
      return { ok: true, nextState: 'on_break' };

    case 'break_end':
      if (state !== 'on_break') {
        return {
          ok: false,
          code: 'not_on_break',
          message: 'You are not on a break.',
        };
      }
      return { ok: true, nextState: 'working' };

    case 'job_change':
    case 'activity_change':
      if (state === 'off') {
        return {
          ok: false,
          code: 'job_change_requires_clock_in',
          message: 'Clock in before changing job or activity.',
        };
      }
      // Changing job while on a break is legal and means "the break continues,
      // but I am going to a different job after it". The segment builder reads
      // the change as applying to the segment that follows.
      return { ok: true, nextState: state };
  }
}

/** Which buttons the app should offer, given the current state. */
export function allowedEvents(state: ClockState): AttendanceEventType[] {
  const all: AttendanceEventType[] = [
    'clock_in',
    'clock_out',
    'break_start',
    'break_end',
    'job_change',
    'activity_change',
  ];
  return all.filter((t) => applyTransition(state, t).ok);
}
