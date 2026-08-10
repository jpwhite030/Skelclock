/**
 * Shift tracking.
 *
 * SkelClock follows a worker's position for the length of their shift, so the
 * clock screen can show a live map and the fence check is answered from a
 * current position rather than a stale one.
 *
 * ── The rules this file exists to enforce ──────────────────────────────────
 *
 * Tracking runs when, and only when, a worker is clocked on. It starts on
 * clock-on, it stops on clock-off, and it stops on sign-out. There is no path
 * that leaves it running once a shift has ended — that is the difference
 * between a tool that records a working day and one that follows somebody
 * home, and it is enforced here rather than left to each caller to remember.
 *
 * `stop()` is therefore safe to call at any time and is called on every exit
 * from the clocked-on state, including ones that are not a clock-off: signing
 * out, and the app deciding the worker is no longer on shift after a refresh.
 *
 * ── What is and is not sent ────────────────────────────────────────────────
 *
 * Positions stay on the handset. They drive the map and the fence check; there
 * is no breadcrumb trail uploaded to the office, because a stored history of
 * everywhere a worker went is a much larger thing to hold than the attendance
 * record this system is for, and nobody has asked for one. Attendance events
 * still carry the single position taken at the moment of the press, exactly as
 * before. If a live office view is wanted later it needs a schema decision and
 * a retention policy, not just this task reporting somewhere new.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { Fix } from './location';

export const SHIFT_TRACKING_TASK = 'skelclock-shift-tracking';

/**
 * The most recent position, wherever it came from.
 *
 * Module-level rather than React state because the background task runs with
 * no component mounted. The clock screen reads it on wake to catch up on
 * anything that arrived while it was not looking.
 */
let latest: { fix: Fix; at: string } | null = null;

type Listener = (fix: Fix, at: string) => void;
const listeners = new Set<Listener>();

export function lastKnown(): { fix: Fix; at: string } | null {
  return latest;
}

export function onPosition(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function record(fix: Fix): void {
  latest = { fix, at: new Date().toISOString() };
  for (const listener of listeners) listener(fix, latest.at);
}

TaskManager.defineTask(SHIFT_TRACKING_TASK, async ({ data, error }) => {
  if (error) {
    // kCLErrorLocationUnknown. Core Location is saying "not yet", not "no" —
    // it is routine while a fix is still settling, and Apple's guidance is to
    // keep waiting. Shouting about it would put a red banner in front of a
    // worker for something that resolves itself a second later.
    if (error.code !== 0) console.error('SkelClock shift tracking error', error);
    return;
  }
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  const position = locations?.at(-1);
  if (!position) return;

  record({
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? null,
    problem: null,
  });
});

/** Feeds a foreground fix into the same channel the background task uses. */
export function reportForegroundFix(fix: Fix): void {
  if (fix.latitude == null || fix.longitude == null) return;
  record(fix);
}

export async function isTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(SHIFT_TRACKING_TASK);
  } catch {
    return false;
  }
}

/**
 * Begin following the shift. Requires "Always" permission; without it the
 * foreground watcher still runs and the map still works, so a refusal costs
 * background coverage rather than the feature.
 */
export async function start(): Promise<{ background: boolean }> {
  const foreground = await Location.getForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status !== 'granted') return { background: false };
  }

  const background = await Location.getBackgroundPermissionsAsync();
  if (background.status !== 'granted') {
    const asked = await Location.requestBackgroundPermissionsAsync();
    if (asked.status !== 'granted') return { background: false };
  }

  if (await isTracking()) return { background: true };

  await Location.startLocationUpdatesAsync(SHIFT_TRACKING_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 25,
    timeInterval: 60_000,
    pausesUpdatesAutomatically: true,
    // iOS shows this while the app is holding location in the background. A
    // worker should never have to wonder why the arrow is lit.
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: 'SkelClock is on shift',
      notificationBody: 'Recording your position until you clock off.',
      notificationColor: '#0a6b3c',
    },
  });

  return { background: true };
}

/** Stop following. Safe to call when not running. */
export async function stop(): Promise<void> {
  try {
    if (await isTracking()) {
      await Location.stopLocationUpdatesAsync(SHIFT_TRACKING_TASK);
    }
  } catch {
    // Nothing to stop, or the task was never registered on this launch.
  }
  latest = null;
}
