/**
 * Turns the raw event stream into the costable day.
 *
 *   06:30-09:00  work    Erect     Job 1032
 *   09:00-09:30  travel  Travel    -
 *   09:30-14:30  work    Modify    Job 1041
 *
 * Segments are always rebuilt from scratch rather than patched, because the
 * events are the permanent record and any patching logic would eventually
 * disagree with them. Cheap to do — a day is a dozen events.
 */

import type {
  DayTotals,
  StoredAttendanceEvent,
  TimeSegment,
  WorkActivityRef,
} from './types.js';
import { orderedLiveEvents } from './state-machine.js';

export interface BuildSegmentsOptions {
  /** Activity lookup, used to decide travel vs work and paid vs unpaid. */
  activities?: ReadonlyMap<string, WorkActivityRef>;
  /**
   * Whether breaks count as paid time. Off by default: the brief says Odoo
   * owns award interpretation, and unpaid is the common case for a meal break.
   */
  breaksArePaid?: boolean;
  /**
   * Clamp for a shift with no clock-out yet. Live "hours worked" on the home
   * screen passes the current time; the nightly exception job leaves it
   * undefined so an open shift stays visibly open.
   */
  now?: Date;
}

export interface BuildSegmentsResult {
  segments: TimeSegment[];
  totals: DayTotals;
  /** True when the last shift never got a clock-out. Drives the exception. */
  hasOpenShift: boolean;
}

interface OpenSegment {
  jobId: string | null;
  workActivityId: string | null;
  startTime: string;
  startEventId: string | null;
  isBreak: boolean;
}

const minutesBetween = (startIso: string, endIso: string): number =>
  Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000));

export function buildSegments(
  events: readonly StoredAttendanceEvent[],
  options: BuildSegmentsOptions = {},
): BuildSegmentsResult {
  const activities = options.activities ?? new Map<string, WorkActivityRef>();
  const breaksArePaid = options.breaksArePaid ?? false;

  const ordered = orderedLiveEvents(events);
  const segments: TimeSegment[] = [];

  let open: OpenSegment | null = null;
  // Carried across a break so that resuming work returns to the same job and
  // activity without the worker having to re-pick them.
  let currentJobId: string | null = null;
  let currentActivityId: string | null = null;
  let clockedIn = false;

  const closeOpen = (endTime: string, endEventId: string | null): void => {
    if (!open) return;
    segments.push(materialise(open, endTime, endEventId, activities, breaksArePaid));
    open = null;
  };

  for (const e of ordered) {
    switch (e.eventType) {
      case 'clock_in': {
        if (clockedIn) break; // guarded by the state machine; belt and braces
        clockedIn = true;
        currentJobId = e.jobId;
        currentActivityId = e.workActivityId;
        open = {
          jobId: currentJobId,
          workActivityId: currentActivityId,
          startTime: e.deviceTime,
          startEventId: e.id,
          isBreak: false,
        };
        break;
      }

      case 'job_change':
      case 'activity_change': {
        if (!clockedIn) break;

        // The event type decides which field is authoritative:
        //   job_change      — the job is taken literally, null included. That
        //                     is how travel between two jobs is recorded: it
        //                     belongs to neither, so it costs to neither.
        //   activity_change — only the activity moves; the job is inherited,
        //                     because switching from Erect to Modify does not
        //                     mean the worker left the site.
        if (e.eventType === 'job_change') {
          currentJobId = e.jobId;
          if (e.workActivityId !== null) currentActivityId = e.workActivityId;
        } else {
          currentActivityId = e.workActivityId;
        }

        if (open && open.isBreak) {
          // Mid-break switch: the break keeps running, the *next* work segment
          // picks up the new job. Nothing to close here.
          break;
        }
        closeOpen(e.deviceTime, e.id);
        open = {
          jobId: currentJobId,
          workActivityId: currentActivityId,
          startTime: e.deviceTime,
          startEventId: e.id,
          isBreak: false,
        };
        break;
      }

      case 'break_start': {
        if (!clockedIn || open?.isBreak) break;
        closeOpen(e.deviceTime, e.id);
        open = {
          jobId: currentJobId,
          workActivityId: currentActivityId,
          startTime: e.deviceTime,
          startEventId: e.id,
          isBreak: true,
        };
        break;
      }

      case 'break_end': {
        if (!open?.isBreak) break;
        closeOpen(e.deviceTime, e.id);
        open = {
          jobId: currentJobId,
          workActivityId: currentActivityId,
          startTime: e.deviceTime,
          startEventId: e.id,
          isBreak: false,
        };
        break;
      }

      case 'clock_out': {
        if (!clockedIn) break;
        // Closes whatever is open, break included — see implicitBreakEnd in
        // the state machine.
        closeOpen(e.deviceTime, e.id);
        clockedIn = false;
        currentJobId = null;
        currentActivityId = null;
        break;
      }
    }
  }

  const hasOpenShift = clockedIn;

  // An open shift still needs an "hours so far" figure for the home screen.
  if (open && options.now) {
    const nowIso = options.now.toISOString();
    // Guard against a device clock ahead of the server: never render negative.
    if (Date.parse(nowIso) >= Date.parse(open.startTime)) {
      segments.push(materialise(open, nowIso, null, activities, breaksArePaid));
    }
  }

  return { segments, totals: totalsFor(segments), hasOpenShift };
}

function materialise(
  open: OpenSegment,
  endTime: string,
  endEventId: string | null,
  activities: ReadonlyMap<string, WorkActivityRef>,
  breaksArePaid: boolean,
): TimeSegment {
  const activity = open.workActivityId ? activities.get(open.workActivityId) : undefined;

  const segmentType = open.isBreak ? 'break' : activity?.isTravel ? 'travel' : 'work';
  const isPaid = open.isBreak ? breaksArePaid : (activity?.isPaid ?? true);

  return {
    jobId: open.jobId,
    workActivityId: open.workActivityId,
    segmentType,
    startTime: open.startTime,
    endTime,
    minutes: minutesBetween(open.startTime, endTime),
    isPaid,
    startEventId: open.startEventId,
    endEventId,
  };
}

export function totalsFor(segments: readonly TimeSegment[]): DayTotals {
  let totalShiftMinutes = 0;
  let totalBreakMinutes = 0;
  let totalPaidMinutes = 0;

  for (const s of segments) {
    const m = s.minutes ?? 0;
    totalShiftMinutes += m;
    if (s.segmentType === 'break') totalBreakMinutes += m;
    if (s.isPaid) totalPaidMinutes += m;
  }

  return { totalShiftMinutes, totalBreakMinutes, totalPaidMinutes };
}

/** "7h 45m" — the only formatting workers and payroll both read the same way. */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
}
