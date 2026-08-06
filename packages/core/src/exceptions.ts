/**
 * Exception detection — the office's work queue.
 *
 * Deliberately conservative. Every false positive here is a phone call to a
 * scaffolder who did nothing wrong, and an exceptions list nobody trusts gets
 * ignored, which defeats the point. When in doubt, stay quiet.
 */

import type {
  ExceptionType,
  StoredAttendanceEvent,
  TimeSegment,
} from './types.js';
import { orderedLiveEvents } from './state-machine.js';
import { shouldRaiseGeofenceException } from './geo.js';

export interface DetectedException {
  type: ExceptionType;
  /** 1 = office should look today, 2 = review at approval, 3 = informational. */
  severity: 1 | 2 | 3;
  attendanceEventId?: string | null;
  details: Record<string, unknown>;
  message: string;
}

export interface DetectExceptionsInput {
  events: readonly StoredAttendanceEvent[];
  segments: readonly TimeSegment[];
  hasOpenShift: boolean;
  /** Hours past which a shift looks like a forgotten clock-out. */
  longShiftHours?: number;
  /** Segments from this employee's other timesheets in the surrounding days. */
  neighbouringSegments?: readonly TimeSegment[];
  /** True once the day is over — suppresses "missing clock-out" mid-shift. */
  dayIsClosed?: boolean;
}

export function detectExceptions(input: DetectExceptionsInput): DetectedException[] {
  const {
    events,
    segments,
    hasOpenShift,
    longShiftHours = 14,
    neighbouringSegments = [],
    dayIsClosed = false,
  } = input;

  const found: DetectedException[] = [];
  const ordered = orderedLiveEvents(events);

  // --- missing clock-in ----------------------------------------------------
  // A day whose first meaningful event is not a clock-in. Usually a supervisor
  // clocking someone out who never clocked themselves in.
  const first = ordered[0];
  if (first && first.eventType !== 'clock_in') {
    found.push({
      type: 'missing_clock_in',
      severity: 1,
      attendanceEventId: first.id,
      details: { firstEventType: first.eventType, firstEventTime: first.deviceTime },
      message: `Day starts with "${first.eventType}" — no clock-in was recorded.`,
    });
  }

  // --- missing clock-out ---------------------------------------------------
  // Only once the day is genuinely over. Raising this at 2pm on a live shift
  // is how an exceptions list becomes noise.
  if (hasOpenShift && dayIsClosed) {
    const last = ordered[ordered.length - 1];
    found.push({
      type: 'missing_clock_out',
      severity: 1,
      attendanceEventId: last?.id ?? null,
      details: { lastEventTime: last?.deviceTime ?? null },
      message: 'Shift was never clocked out.',
    });
  }

  // --- very long shift -----------------------------------------------------
  const totalMinutes = segments.reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  if (totalMinutes > longShiftHours * 60) {
    found.push({
      type: 'very_long_shift',
      severity: 2,
      details: { totalMinutes, thresholdMinutes: longShiftHours * 60 },
      message: `Shift totals ${(totalMinutes / 60).toFixed(1)}h, over the ${longShiftHours}h threshold.`,
    });
  }

  // --- outside geofence ----------------------------------------------------
  for (const e of ordered) {
    if (e.eventType !== 'clock_in' && e.eventType !== 'clock_out') continue;

    const raise = shouldRaiseGeofenceException({
      distanceM: e.distanceFromSiteM,
      insideGeofence: e.insideGeofence,
      // Recomputing the margin here would need the radius again; the ingest
      // path already applied it, so trust its verdict and only re-check that
      // an unexplained outside-clock got flagged.
      withinAccuracyMargin: false,
    });

    if (raise && !e.outsideReason) {
      found.push({
        type: 'outside_geofence',
        severity: 2,
        attendanceEventId: e.id,
        details: {
          eventType: e.eventType,
          distanceM: e.distanceFromSiteM,
          accuracyM: e.gpsAccuracyM,
        },
        message:
          e.distanceFromSiteM != null
            ? `${e.eventType.replace('_', ' ')} recorded ${Math.round(e.distanceFromSiteM)}m from site, with no reason given.`
            : `${e.eventType.replace('_', ' ')} recorded outside the site boundary.`,
      });
    }
  }

  // --- unassigned job ------------------------------------------------------
  const jobless = ordered.filter((e) => e.eventType === 'clock_in' && !e.jobId);
  for (const e of jobless) {
    found.push({
      type: 'unassigned_job',
      severity: 2,
      attendanceEventId: e.id,
      details: { eventTime: e.deviceTime },
      message: 'Clocked in without a job selected — hours cannot be costed.',
    });
  }

  // --- offline event -------------------------------------------------------
  // Informational, and raised once for the day rather than once per event:
  // a full day with no reception is normal on a regional site, and the office
  // only needs to know the times came from the device clock.
  const offline = ordered.filter((e) => e.wasOffline);
  if (offline.length > 0) {
    const lagMinutes = offline.map((e) =>
      Math.round((Date.parse(e.serverTime) - Date.parse(e.deviceTime)) / 60_000),
    );
    found.push({
      type: 'offline_event',
      severity: 3,
      details: {
        count: offline.length,
        maxSyncLagMinutes: Math.max(...lagMinutes),
      },
      message: `${offline.length} event(s) recorded offline and synced later.`,
    });
  }

  // --- overlapping shifts --------------------------------------------------
  // Cannot happen inside one rebuilt day, so this only ever fires across the
  // boundary: a night shift double-counted into the next day, or a supervisor
  // clocking a worker onto a second job while their first is still running.
  for (const overlap of findOverlaps(segments, neighbouringSegments)) {
    found.push({
      type: 'overlapping_shift',
      severity: 1,
      details: { ...overlap },
      message: `Time is claimed on two jobs at once between ${overlap.from} and ${overlap.to}.`,
    });
  }

  return found;
}

interface Overlap {
  from: string;
  to: string;
  minutes: number;
}

function findOverlaps(
  a: readonly TimeSegment[],
  b: readonly TimeSegment[],
): Overlap[] {
  const overlaps: Overlap[] = [];
  const closed = (s: TimeSegment): boolean => s.endTime !== null;

  for (const left of a.filter(closed)) {
    for (const right of b.filter(closed)) {
      const start = Math.max(Date.parse(left.startTime), Date.parse(right.startTime));
      const end = Math.min(Date.parse(left.endTime!), Date.parse(right.endTime!));
      // Touching endpoints (one segment ending exactly as another begins) are
      // normal, not overlaps — hence a strict comparison.
      if (end > start) {
        overlaps.push({
          from: new Date(start).toISOString(),
          to: new Date(end).toISOString(),
          minutes: Math.round((end - start) / 60_000),
        });
      }
    }
  }
  return overlaps;
}
