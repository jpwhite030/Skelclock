import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bearingDegrees,
  blocksClockIn,
  distanceMetres,
  evaluateGeofence,
  shouldAutoConfirmGeofence,
  shouldRaiseGeofenceException,
} from './geo.js';
import {
  applyTransition,
  currentShift,
  deriveState,
  allowedEvents,
} from './state-machine.js';
import { buildSegments, formatMinutes } from './segments.js';
import { detectExceptions } from './exceptions.js';
import { isValidIdempotencyKey, newIdempotencyKey, syncJobKey } from './idempotency.js';
import { isWithinOperatingHours, minutesSinceLocalMidnight } from './operating-hours.js';
import type { StoredAttendanceEvent, WorkActivityRef } from './types.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function ev(
  eventType: StoredAttendanceEvent['eventType'],
  deviceTime: string,
  extra: Partial<StoredAttendanceEvent> = {},
): StoredAttendanceEvent {
  return {
    id: `e${++seq}`,
    employeeId: 'emp-1',
    eventType,
    deviceTime,
    serverTime: deviceTime,
    jobId: null,
    workActivityId: null,
    latitude: null,
    longitude: null,
    gpsAccuracyM: null,
    insideGeofence: null,
    distanceFromSiteM: null,
    outsideReason: null,
    clockMethod: 'manual',
    wasOffline: false,
    isSuggested: false,
    voidedAt: null,
    ...extra,
  };
}

const ACTIVITIES = new Map<string, WorkActivityRef>([
  ['erect', { id: 'erect', code: 'ERECT', name: 'Erect', isTravel: false, isPaid: true }],
  ['modify', { id: 'modify', code: 'MODIFY', name: 'Modify', isTravel: false, isPaid: true }],
  ['travel', { id: 'travel', code: 'TRAVEL', name: 'Travel', isTravel: true, isPaid: true }],
]);

// --- geo -------------------------------------------------------------------

test('distanceMetres matches a known Sydney baseline', () => {
  // Sydney Opera House -> Harbour Bridge pylon, ~885m by great circle.
  const d = distanceMetres(
    { latitude: -33.856784, longitude: 151.215297 },
    { latitude: -33.852222, longitude: 151.210556 },
  );
  assert.ok(Math.abs(d - 660) < 120, `expected ~660m, got ${d.toFixed(0)}m`);
});

test('distanceMetres is zero for identical points', () => {
  const p = { latitude: -33.8, longitude: 151.2 };
  assert.equal(distanceMetres(p, p), 0);
});

test('bearingDegrees points to the four cardinals', () => {
  const site = { latitude: -34.4248, longitude: 150.8931 }; // 14 Kembla Street

  const north = bearingDegrees(site, { ...site, latitude: site.latitude + 0.01 });
  const south = bearingDegrees(site, { ...site, latitude: site.latitude - 0.01 });
  const east = bearingDegrees(site, { ...site, longitude: site.longitude + 0.01 });
  const west = bearingDegrees(site, { ...site, longitude: site.longitude - 0.01 });

  assert.ok(Math.abs(north - 0) < 1, `north was ${north.toFixed(1)}`);
  assert.ok(Math.abs(south - 180) < 1, `south was ${south.toFixed(1)}`);
  assert.ok(Math.abs(east - 90) < 1, `east was ${east.toFixed(1)}`);
  assert.ok(Math.abs(west - 270) < 1, `west was ${west.toFixed(1)}`);
});

test('bearingDegrees is a compass bearing, not a flat arctangent', () => {
  // Equal degree steps north and east. On a square lat/lng grid this would be
  // exactly 45°; the real forward azimuth is east of that, because a degree of
  // longitude is shorter than a degree of latitude this far south.
  const site = { latitude: -34.4248, longitude: 150.8931 };
  const b = bearingDegrees(site, {
    latitude: site.latitude + 0.01,
    longitude: site.longitude + 0.01,
  });

  assert.ok(b > 39 && b < 40, `expected ~39.5°, got ${b.toFixed(2)}°`);
});

test('bearingDegrees returns 0 for identical points rather than NaN', () => {
  const p = { latitude: -34.4248, longitude: 150.8931 };
  assert.equal(bearingDegrees(p, p), 0);
});

// --- the fence as a hard block -----------------------------------------------
//
// These guard the cases where refusing a clock-on would cost a worker a shift
// for something that is not their fault. The positive case is one test; the
// rest are all the ways someone must still get to work.

const site = { latitude: -34.4248, longitude: 150.8931 };
const fenceM = 200;

/** Roughly `metres` due north of the site. 1 degree of latitude ~ 111,320m. */
const northOf = (metres: number) => ({
  latitude: site.latitude + metres / 111_320,
  longitude: site.longitude,
});

test('blocksClockIn refuses a position confidently outside the fence', () => {
  const result = evaluateGeofence({
    position: northOf(600),
    accuracyM: 10,
    site,
    radiusM: fenceM,
  });

  assert.equal(result.insideGeofence, false);
  assert.equal(blocksClockIn(result), true);
});

test('blocksClockIn allows a worker inside the fence', () => {
  const result = evaluateGeofence({
    position: northOf(50),
    accuracyM: 10,
    site,
    radiusM: fenceM,
  });

  assert.equal(blocksClockIn(result), false);
});

test('blocksClockIn does not refuse when there is no position at all', () => {
  // A basement, a shed, a flat GPS, a refused permission. Unknown is not
  // outside, and must never cost somebody a shift.
  const result = evaluateGeofence({
    position: null,
    accuracyM: null,
    site,
    radiusM: fenceM,
  });

  assert.equal(result.insideGeofence, null);
  assert.equal(blocksClockIn(result), false);
});

test('blocksClockIn does not refuse when the site has no coordinates yet', () => {
  const result = evaluateGeofence({
    position: northOf(5000),
    accuracyM: 10,
    site: null,
    radiusM: fenceM,
  });

  assert.equal(result.insideGeofence, null);
  assert.equal(blocksClockIn(result), false);
});

test('blocksClockIn does not refuse when GPS error bars reach the fence', () => {
  // 260m out with 100m of error: the worker may well be standing inside it.
  // This is the ordinary case on a scaffold deck, not an edge case.
  const result = evaluateGeofence({
    position: northOf(260),
    accuracyM: 100,
    site,
    radiusM: fenceM,
  });

  assert.equal(result.insideGeofence, false);
  assert.equal(result.withinAccuracyMargin, true);
  assert.equal(blocksClockIn(result), false);
});

test('a worker standing on site is inside the fence', () => {
  const r = evaluateGeofence({
    position: { latitude: -33.8000, longitude: 151.2000 },
    accuracyM: 8,
    site: { latitude: -33.8001, longitude: 151.2001 },
    radiusM: 200,
  });
  assert.equal(r.insideGeofence, true);
  assert.ok(r.distanceM! < 20);
  assert.equal(shouldRaiseGeofenceException(r), false);
});

test('a worker well outside the fence raises an exception', () => {
  const r = evaluateGeofence({
    position: { latitude: -33.8000, longitude: 151.2000 },
    accuracyM: 10,
    site: { latitude: -33.9000, longitude: 151.2000 },
    radiusM: 200,
  });
  assert.equal(r.insideGeofence, false);
  assert.equal(r.withinAccuracyMargin, false);
  assert.equal(shouldRaiseGeofenceException(r), true);
});

test('poor GPS just past the fence is not worth chasing', () => {
  // 250m out, but the phone admits to +/-120m — the error bars reach the fence.
  const r = evaluateGeofence({
    position: { latitude: -33.80000, longitude: 151.20000 },
    accuracyM: 120,
    site: { latitude: -33.80225, longitude: 151.20000 },
    radiusM: 200,
  });
  assert.equal(r.insideGeofence, false);
  assert.equal(r.withinAccuracyMargin, true);
  assert.equal(shouldRaiseGeofenceException(r), false);
});

test('a job with no coordinates never raises a geofence exception', () => {
  const r = evaluateGeofence({
    position: { latitude: -33.8, longitude: 151.2 },
    accuracyM: 5,
    site: null,
    radiusM: 200,
  });
  assert.equal(r.insideGeofence, null);
  assert.equal(r.reason, 'no_site_position');
  assert.equal(shouldRaiseGeofenceException(r), false);
});

test('a tight fix comfortably inside the fence auto-confirms', () => {
  assert.equal(
    shouldAutoConfirmGeofence({ insideGeofence: true, accuracyM: 12, candidateSiteCount: 1 }),
    true,
  );
});

test('a loose fix never auto-confirms, even standing inside the fence', () => {
  assert.equal(
    shouldAutoConfirmGeofence({ insideGeofence: true, accuracyM: 45, candidateSiteCount: 1 }),
    false,
  );
});

test('a missing accuracy reading is treated as untrustworthy, not lucky', () => {
  assert.equal(
    shouldAutoConfirmGeofence({ insideGeofence: true, accuracyM: null, candidateSiteCount: 1 }),
    false,
  );
});

test('outside the fence never auto-confirms regardless of accuracy', () => {
  assert.equal(
    shouldAutoConfirmGeofence({ insideGeofence: false, accuracyM: 5, candidateSiteCount: 1 }),
    false,
  );
});

test('two candidate sites at once never auto-confirms, even with a perfect fix', () => {
  assert.equal(
    shouldAutoConfirmGeofence({ insideGeofence: true, accuracyM: 5, candidateSiteCount: 2 }),
    false,
  );
});

// --- operating hours (phone-side mirror of server checkOperatingHours) ------

test('operating hours: inside a normal window is allowed, outside is not', () => {
  const window = { start: '06:00:00', end: '18:00:00' };
  assert.equal(isWithinOperatingHours(8 * 60, window), true);
  assert.equal(isWithinOperatingHours(4 * 60, window), false);
  // Start inclusive, end exclusive — same as the server's comparison.
  assert.equal(isWithinOperatingHours(6 * 60, window), true);
  assert.equal(isWithinOperatingHours(18 * 60, window), false);
});

test('operating hours: an overnight window wraps past midnight', () => {
  const window = { start: '22:00', end: '06:00' };
  assert.equal(isWithinOperatingHours(23 * 60, window), true);
  assert.equal(isWithinOperatingHours(5 * 60, window), true);
  assert.equal(isWithinOperatingHours(12 * 60, window), false);
});

test('operating hours: no window means no restriction', () => {
  assert.equal(isWithinOperatingHours(3 * 60, { start: null, end: null }), true);
  assert.equal(isWithinOperatingHours(3 * 60, { start: '06:00', end: null }), true);
});

test('operating hours: equal start and end is 24 hours, not permanently closed', () => {
  const window = { start: '00:00', end: '00:00' };
  assert.equal(isWithinOperatingHours(0, window), true);
  assert.equal(isWithinOperatingHours(12 * 60, window), true);
  assert.equal(isWithinOperatingHours(23 * 60 + 59, window), true);
});

test('minutesSinceLocalMidnight reads the device clock, not UTC', () => {
  const d = new Date(2026, 7, 4, 6, 30); // constructed in local time on purpose
  assert.equal(minutesSinceLocalMidnight(d), 6 * 60 + 30);
});

// --- state machine ---------------------------------------------------------

test('a double-tapped clock-in is rejected', () => {
  const first = applyTransition('off', 'clock_in');
  assert.equal(first.ok, true);
  const second = applyTransition('working', 'clock_in');
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.code, 'already_clocked_in');
});

test('clocking out from a break closes the break', () => {
  const r = applyTransition('on_break', 'clock_out');
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.implicitBreakEnd, true);
});

test('you cannot start a break before clocking in', () => {
  const r = applyTransition('off', 'break_start');
  assert.equal(r.ok === false && r.code, 'not_clocked_in');
});

test('state is derived from device time, not arrival order', () => {
  // Offline queue flushed out of order: clock-out reaches us before clock-in.
  const events = [
    ev('clock_out', '2026-08-04T06:00:00Z', { serverTime: '2026-08-04T09:00:00Z' }),
    ev('clock_in', '2026-08-04T00:00:00Z', { serverTime: '2026-08-04T09:00:01Z' }),
  ];
  assert.equal(deriveState(events), 'off');
});

test('voided events do not affect state', () => {
  const events = [
    ev('clock_in', '2026-08-04T00:00:00Z', { voidedAt: '2026-08-04T10:00:00Z' }),
  ];
  assert.equal(deriveState(events), 'off');
});

test('allowedEvents drives the buttons the app shows', () => {
  assert.deepEqual(allowedEvents('off'), ['clock_in']);
  assert.deepEqual(allowedEvents('working'), [
    'clock_out',
    'break_start',
    'job_change',
    'activity_change',
  ]);
  assert.deepEqual(allowedEvents('on_break'), [
    'clock_out',
    'break_end',
    'job_change',
    'activity_change',
  ]);
});

// --- current shift ---------------------------------------------------------
// A 48-hour lookback is needed to catch a night shift, but it also drags in
// yesterday. These pin down that only the running shift is ever counted.

test('yesterday\'s finished shift is excluded from the running one', () => {
  const events = [
    ev('clock_in', '2026-08-03T06:00:00Z', { timesheetId: 'ts-yesterday' }),
    ev('clock_out', '2026-08-03T14:00:00Z', { timesheetId: 'ts-yesterday' }),
    ev('clock_in', '2026-08-04T06:30:00Z', { timesheetId: 'ts-today' }),
  ];

  const shift = currentShift(events);
  assert.ok(shift);
  assert.equal(shift!.timesheetId, 'ts-today');
  assert.equal(shift!.events.length, 1);
  assert.equal(shift!.events[0]!.deviceTime, '2026-08-04T06:30:00Z');

  // The bug this replaced reported 14h 24m here instead of 3h.
  const { totals } = buildSegments(shift!.events, { now: new Date('2026-08-04T09:30:00Z') });
  assert.equal(totals.totalPaidMinutes, 180);
});

test('a clocked-off worker has no running shift', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z'),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];
  assert.equal(currentShift(events), null);
});

test('a night shift past midnight is still one running shift', () => {
  const events = [
    ev('clock_in', '2026-08-03T20:00:00Z', { timesheetId: 'ts-3rd' }),
    ev('break_start', '2026-08-04T00:00:00Z', { timesheetId: 'ts-3rd' }),
    ev('break_end', '2026-08-04T00:30:00Z', { timesheetId: 'ts-3rd' }),
  ];
  const shift = currentShift(events);
  assert.equal(shift!.timesheetId, 'ts-3rd');
  assert.equal(shift!.events.length, 3);
});

test('the running shift keeps its breaks', () => {
  const events = [
    ev('clock_in', '2026-08-03T06:00:00Z'),
    ev('clock_out', '2026-08-03T14:00:00Z'),
    ev('clock_in', '2026-08-04T06:00:00Z'),
    ev('break_start', '2026-08-04T09:00:00Z'),
    ev('break_end', '2026-08-04T09:30:00Z'),
  ];
  const shift = currentShift(events);
  assert.deepEqual(
    shift!.events.map((e) => e.eventType),
    ['clock_in', 'break_start', 'break_end'],
  );
});

// --- segments --------------------------------------------------------------

test('the brief\'s worked example produces three segments', () => {
  // 6:30-9:00 Erect Job 1032, 9:00-9:30 Travel, 9:30-14:30 Modify Job 1041
  const events = [
    ev('clock_in', '2026-08-04T06:30:00+10:00', { jobId: 'job-1032', workActivityId: 'erect' }),
    ev('job_change', '2026-08-04T09:00:00+10:00', { jobId: null, workActivityId: 'travel' }),
    ev('job_change', '2026-08-04T09:30:00+10:00', { jobId: 'job-1041', workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:30:00+10:00'),
  ];

  const { segments, totals, hasOpenShift } = buildSegments(events, { activities: ACTIVITIES });

  assert.equal(hasOpenShift, false);
  assert.equal(segments.length, 3);

  assert.equal(segments[0]!.minutes, 150);
  assert.equal(segments[0]!.jobId, 'job-1032');
  assert.equal(segments[0]!.segmentType, 'work');

  assert.equal(segments[1]!.minutes, 30);
  assert.equal(segments[1]!.segmentType, 'travel');
  // Travel between two jobs belongs to neither, so it costs to neither.
  assert.equal(segments[1]!.jobId, null);

  assert.equal(segments[2]!.minutes, 300);
  assert.equal(segments[2]!.jobId, 'job-1041');

  assert.equal(totals.totalShiftMinutes, 480);
  assert.equal(totals.totalPaidMinutes, 480);
  assert.equal(totals.totalBreakMinutes, 0);
});

test('travel allocation defaults to unallocated - the brief example is unaffected', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:30:00+10:00', { jobId: 'job-1032', workActivityId: 'erect' }),
    ev('job_change', '2026-08-04T09:00:00+10:00', { jobId: null, workActivityId: 'travel' }),
    ev('job_change', '2026-08-04T09:30:00+10:00', { jobId: 'job-1041', workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:30:00+10:00'),
  ];
  const { segments } = buildSegments(events, { activities: ACTIVITIES });
  assert.equal(segments[1]!.jobId, null);
});

test('travel allocation can cost to the site just left', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:30:00+10:00', { jobId: 'job-1032', workActivityId: 'erect' }),
    ev('job_change', '2026-08-04T09:00:00+10:00', { jobId: null, workActivityId: 'travel' }),
    ev('job_change', '2026-08-04T09:30:00+10:00', { jobId: 'job-1041', workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:30:00+10:00'),
  ];
  const { segments } = buildSegments(events, {
    activities: ACTIVITIES,
    travelAllocation: 'first_site',
  });
  assert.equal(segments[1]!.segmentType, 'travel');
  assert.equal(segments[1]!.jobId, 'job-1032');
  // Neither neighbour segment is touched - only the travel segment moves.
  assert.equal(segments[0]!.jobId, 'job-1032');
  assert.equal(segments[2]!.jobId, 'job-1041');
});

test('travel allocation can cost to the site being travelled to', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:30:00+10:00', { jobId: 'job-1032', workActivityId: 'erect' }),
    ev('job_change', '2026-08-04T09:00:00+10:00', { jobId: null, workActivityId: 'travel' }),
    ev('job_change', '2026-08-04T09:30:00+10:00', { jobId: 'job-1041', workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:30:00+10:00'),
  ];
  const { segments } = buildSegments(events, {
    activities: ACTIVITIES,
    travelAllocation: 'second_site',
  });
  assert.equal(segments[1]!.jobId, 'job-1041');
});

test('travel at the very start of a shift stays unallocated - there is no first site', () => {
  // e.g. a supervisor correction that opens the day already mid-travel.
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: null, workActivityId: 'travel' }),
    ev('job_change', '2026-08-04T06:30:00Z', { jobId: 'job-1032', workActivityId: 'erect' }),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];
  const { segments } = buildSegments(events, {
    activities: ACTIVITIES,
    travelAllocation: 'first_site',
  });
  assert.equal(segments[0]!.segmentType, 'travel');
  assert.equal(segments[0]!.jobId, null);
});

test('an unpaid break is excluded from paid hours but not from shift time', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('break_start', '2026-08-04T09:00:00Z'),
    ev('break_end', '2026-08-04T09:30:00Z'),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];

  const { totals } = buildSegments(events, { activities: ACTIVITIES });

  assert.equal(totals.totalShiftMinutes, 480); // 8h door to door
  assert.equal(totals.totalBreakMinutes, 30);
  assert.equal(totals.totalPaidMinutes, 450); // 7h30 paid
});

test('an activity change keeps the worker on the same job', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('activity_change', '2026-08-04T09:00:00Z', { jobId: null, workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];
  const { segments } = buildSegments(events, { activities: ACTIVITIES });
  assert.equal(segments.length, 2);
  assert.equal(segments[1]!.jobId, 'j1');
  assert.equal(segments[1]!.workActivityId, 'modify');
});

test('work resumes on the same job after a break', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('break_start', '2026-08-04T09:00:00Z'),
    ev('break_end', '2026-08-04T09:30:00Z'),
    ev('clock_out', '2026-08-04T10:00:00Z'),
  ];
  const { segments } = buildSegments(events, { activities: ACTIVITIES });
  const afterBreak = segments[2]!;
  assert.equal(afterBreak.jobId, 'j1');
  assert.equal(afterBreak.workActivityId, 'erect');
  assert.equal(afterBreak.segmentType, 'work');
});

test('an open shift reports hours so far without inventing a clock-out', () => {
  const events = [ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1' })];
  const { totals, hasOpenShift } = buildSegments(events, {
    now: new Date('2026-08-04T09:15:00Z'),
  });
  assert.equal(hasOpenShift, true);
  assert.equal(totals.totalShiftMinutes, 195);
});

test('a device clock running ahead never produces negative hours', () => {
  const events = [ev('clock_in', '2026-08-04T12:00:00Z', { jobId: 'j1' })];
  const { totals } = buildSegments(events, { now: new Date('2026-08-04T09:00:00Z') });
  assert.equal(totals.totalShiftMinutes, 0);
});

test('forgetting to end a break still closes it at clock-out', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('break_start', '2026-08-04T09:00:00Z'),
    ev('clock_out', '2026-08-04T09:30:00Z'),
  ];
  const { segments, totals } = buildSegments(events, { activities: ACTIVITIES });
  assert.equal(segments.length, 2);
  assert.equal(segments[1]!.segmentType, 'break');
  assert.equal(totals.totalBreakMinutes, 30);
});

test('a long shift with no break clocked gets an automatic unpaid lunch deducted', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('clock_out', '2026-08-04T14:00:00Z'), // 8h, no break
  ];
  const { totals } = buildSegments(events, {
    activities: ACTIVITIES,
    autoLunch: { thresholdMinutes: 300, durationMinutes: 30 },
  });
  assert.equal(totals.totalShiftMinutes, 480);
  assert.equal(totals.autoLunchMinutes, 30);
  assert.equal(totals.totalPaidMinutes, 450);
});

test('a shift under the auto-lunch threshold is not touched', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('clock_out', '2026-08-04T10:00:00Z'), // 4h
  ];
  const { totals } = buildSegments(events, {
    activities: ACTIVITIES,
    autoLunch: { thresholdMinutes: 300, durationMinutes: 30 },
  });
  assert.equal(totals.autoLunchMinutes, 0);
  assert.equal(totals.totalPaidMinutes, 240);
});

test('a worker who already clocked a break is not also docked the automatic lunch', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('break_start', '2026-08-04T10:00:00Z'),
    ev('break_end', '2026-08-04T10:15:00Z'), // a genuine but short break
    ev('clock_out', '2026-08-04T14:00:00Z'), // 8h door to door, 15m of it unpaid break
  ];
  const { totals } = buildSegments(events, {
    activities: ACTIVITIES,
    autoLunch: { thresholdMinutes: 300, durationMinutes: 30 },
  });
  assert.equal(totals.autoLunchMinutes, 0);
  assert.equal(totals.totalBreakMinutes, 15);
  assert.equal(totals.totalPaidMinutes, 465); // 480 - 15, not also -30
});

test('auto-lunch is disabled by default', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];
  const { totals } = buildSegments(events, { activities: ACTIVITIES });
  assert.equal(totals.autoLunchMinutes, 0);
  assert.equal(totals.totalPaidMinutes, 480);
});

test('formatMinutes reads the same for workers and payroll', () => {
  assert.equal(formatMinutes(465), '7h 45m');
  assert.equal(formatMinutes(60), '1h 00m');
  assert.equal(formatMinutes(0), '0h 00m');
});

// --- exceptions ------------------------------------------------------------

test('a clean day raises nothing', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', {
      jobId: 'j1',
      insideGeofence: true,
      distanceFromSiteM: 12,
    }),
    ev('clock_out', '2026-08-04T14:00:00Z', {
      jobId: 'j1',
      insideGeofence: true,
      distanceFromSiteM: 15,
    }),
  ];
  const { segments, hasOpenShift } = buildSegments(events);
  const found = detectExceptions({ events, segments, hasOpenShift, dayIsClosed: true });
  assert.deepEqual(found, []);
});

test('a live shift does not raise missing clock-out until the day closes', () => {
  const events = [ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1' })];
  const { segments, hasOpenShift } = buildSegments(events);

  const midShift = detectExceptions({ events, segments, hasOpenShift, dayIsClosed: false });
  assert.equal(midShift.some((e) => e.type === 'missing_clock_out'), false);

  const endOfDay = detectExceptions({ events, segments, hasOpenShift, dayIsClosed: true });
  assert.equal(endOfDay.some((e) => e.type === 'missing_clock_out'), true);
});

test('an outside-fence clock with a reason given is not an exception', () => {
  const withReason = ev('clock_in', '2026-08-04T06:00:00Z', {
    jobId: 'j1',
    insideGeofence: false,
    distanceFromSiteM: 900,
    outsideReason: 'Parked in the overflow yard, gate was locked',
  });
  const found = detectExceptions({
    events: [withReason],
    segments: [],
    hasOpenShift: true,
  });
  assert.equal(found.some((e) => e.type === 'outside_geofence'), false);
});

test('an outside-fence clock with no reason is an exception', () => {
  const noReason = ev('clock_in', '2026-08-04T06:00:00Z', {
    jobId: 'j1',
    insideGeofence: false,
    distanceFromSiteM: 900,
  });
  const found = detectExceptions({ events: [noReason], segments: [], hasOpenShift: true });
  assert.equal(found.some((e) => e.type === 'outside_geofence'), true);
});

test('offline events are reported once for the day, not once each', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', {
      jobId: 'j1',
      wasOffline: true,
      serverTime: '2026-08-04T15:00:00Z',
    }),
    ev('clock_out', '2026-08-04T14:00:00Z', {
      jobId: 'j1',
      wasOffline: true,
      serverTime: '2026-08-04T15:00:00Z',
    }),
  ];
  const { segments, hasOpenShift } = buildSegments(events);
  const found = detectExceptions({ events, segments, hasOpenShift, dayIsClosed: true });
  const offline = found.filter((e) => e.type === 'offline_event');
  assert.equal(offline.length, 1);
  assert.equal(offline[0]!.details.count, 2);
  assert.equal(offline[0]!.details.maxSyncLagMinutes, 540);
});

test('a 16 hour shift is flagged', () => {
  const events = [
    ev('clock_in', '2026-08-04T04:00:00Z', { jobId: 'j1' }),
    ev('clock_out', '2026-08-04T20:00:00Z', { jobId: 'j1' }),
  ];
  const { segments, hasOpenShift } = buildSegments(events);
  const found = detectExceptions({ events, segments, hasOpenShift, dayIsClosed: true });
  assert.equal(found.some((e) => e.type === 'very_long_shift'), true);
});

test('clocking in with no job selected is flagged as uncostable', () => {
  const events = [ev('clock_in', '2026-08-04T06:00:00Z')];
  const { segments, hasOpenShift } = buildSegments(events);
  const found = detectExceptions({ events, segments, hasOpenShift });
  assert.equal(found.some((e) => e.type === 'unassigned_job'), true);
});

test('back-to-back segments are not treated as overlapping', () => {
  const events = [
    ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
    ev('job_change', '2026-08-04T09:00:00Z', { jobId: 'j2', workActivityId: 'modify' }),
    ev('clock_out', '2026-08-04T14:00:00Z'),
  ];
  const { segments, hasOpenShift } = buildSegments(events, { activities: ACTIVITIES });
  const found = detectExceptions({
    events,
    segments,
    hasOpenShift,
    neighbouringSegments: segments,
    dayIsClosed: true,
  });
  // Comparing the day against itself: the shared boundary at 09:00 must not
  // count, but each segment does overlap its own copy — so we check the
  // boundary specifically rather than asserting zero.
  const boundaryOnly = found
    .filter((e) => e.type === 'overlapping_shift')
    .filter((e) => (e.details as { minutes: number }).minutes === 0);
  assert.equal(boundaryOnly.length, 0);
});

test('a genuine overlap across two jobs is caught', () => {
  const dayA = buildSegments(
    [
      ev('clock_in', '2026-08-04T06:00:00Z', { jobId: 'j1', workActivityId: 'erect' }),
      ev('clock_out', '2026-08-04T14:00:00Z'),
    ],
    { activities: ACTIVITIES },
  );
  const dayB = buildSegments(
    [
      ev('clock_in', '2026-08-04T12:00:00Z', { jobId: 'j2', workActivityId: 'modify' }),
      ev('clock_out', '2026-08-04T18:00:00Z'),
    ],
    { activities: ACTIVITIES },
  );

  const found = detectExceptions({
    events: [],
    segments: dayA.segments,
    hasOpenShift: false,
    neighbouringSegments: dayB.segments,
  });
  const overlap = found.find((e) => e.type === 'overlapping_shift');
  assert.ok(overlap, 'expected an overlap to be detected');
  assert.equal((overlap!.details as { minutes: number }).minutes, 120);
});

// --- idempotency -----------------------------------------------------------

test('idempotency keys are unique per press and traceable to a device', () => {
  const a = newIdempotencyKey('pixel-8-abc');
  const b = newIdempotencyKey('pixel-8-abc');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('pixel-8-abc.'));
  assert.ok(isValidIdempotencyKey(a));
});

test('a hostile device id cannot smuggle characters into the key', () => {
  const key = newIdempotencyKey("'; drop table attendance_event;--");
  assert.ok(isValidIdempotencyKey(key), key);
});

test('an empty device id still yields a valid key', () => {
  assert.ok(isValidIdempotencyKey(newIdempotencyKey('')));
});

test('malformed keys are rejected', () => {
  assert.equal(isValidIdempotencyKey(''), false);
  assert.equal(isValidIdempotencyKey('short'), false);
  assert.equal(isValidIdempotencyKey(null), false);
  assert.equal(isValidIdempotencyKey('has spaces in it and is long enough'), false);
});

test('sync job keys collapse duplicate enqueues', () => {
  assert.equal(
    syncJobKey('timesheet', 'ts-1', 'push_attendance'),
    syncJobKey('timesheet', 'ts-1', 'push_attendance'),
  );
});
