/**
 * Location capture.
 *
 * Two modes, and the difference matters enough to be stated plainly.
 *
 *   captureFix()     One shot, at the moment of a clock event. Never blocks
 *                    indefinitely, never throws, and a refusal or a timeout
 *                    comes back as a Fix with `problem` set.
 *
 *   watchPosition()  Continuous, for the live map and the fence check. Runs
 *                    only while the worker is clocked on, and is stopped on
 *                    clock-out and on sign-out — see tracking.ts, which owns
 *                    the background half and the start/stop rules.
 *
 * This module used to promise that a fix was taken at a clock event "and at no
 * other time", with no watcher and nothing running in the background. That is
 * no longer true: SkelClock now follows a worker for the length of their
 * shift. That is a materially different thing for someone to agree to, so it
 * is said outright here, in the permission strings in app.json, and in the
 * privacy section on the clock screen — not softened in any of the three.
 */

import * as Location from 'expo-location';

export interface Fix {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  /** Why we have no position, for the worker-facing message. */
  problem: 'denied' | 'disabled' | 'timeout' | null;
}

const NO_FIX: Fix = { latitude: null, longitude: null, accuracyM: null, problem: null };

/**
 * How long to wait for a fix before clocking anyway.
 *
 * Twelve seconds is long enough for a warm GPS on an open site and short
 * enough that a worker in a basement or a shed is not left holding the phone.
 * A clock event without a position is always better than no clock event.
 */
const FIX_TIMEOUT_MS = 12_000;

export async function requestPermission(): Promise<Location.PermissionStatus> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status;
}

export async function permissionStatus(): Promise<Location.PermissionStatus> {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status;
}

/**
 * One position fix, or a reason there isn't one.
 *
 * Never throws and never blocks indefinitely. A refusal or a timeout comes back
 * as a Fix with `problem` set, and the caller clocks the worker on regardless —
 * the office sees an exception rather than the worker losing a shift.
 */
export async function captureFix(): Promise<Fix> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      const requested = await Location.requestForegroundPermissionsAsync();
      if (requested.status !== 'granted') return { ...NO_FIX, problem: 'denied' };
    }

    if (!(await Location.hasServicesEnabledAsync())) {
      return { ...NO_FIX, problem: 'disabled' };
    }

    const position = await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      }),
      FIX_TIMEOUT_MS,
    );

    if (!position) return { ...NO_FIX, problem: 'timeout' };

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy ?? null,
      problem: null,
    };
  } catch {
    // Any unexpected failure is treated as "no fix". Clocking on matters more.
    return { ...NO_FIX, problem: 'timeout' };
  }
}

/**
 * Follow the worker's position until the returned function is called.
 *
 * Foreground only — this stops when iOS suspends the app. tracking.ts pairs it
 * with a background task so a shift stays covered when the phone is pocketed.
 *
 * Distance-filtered rather than time-filtered: a scaffolder standing still on a
 * deck should not burn battery reporting the same metre over and over, and the
 * map has nothing to redraw until they actually move.
 */
export async function watchPosition(
  onFix: (fix: Fix) => void,
): Promise<() => void> {
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') {
    const requested = await Location.requestForegroundPermissionsAsync();
    if (requested.status !== 'granted') {
      onFix({ ...NO_FIX, problem: 'denied' });
      return () => undefined;
    }
  }

  const subscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: LIVE_DISTANCE_M,
      timeInterval: LIVE_INTERVAL_MS,
    },
    (position) => {
      onFix({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: position.coords.accuracy ?? null,
        problem: null,
      });
    },
  );

  return () => subscription.remove();
}

/** Metres of movement before a new position is reported. */
const LIVE_DISTANCE_M = 10;
/** Floor on how often a position is reported, however fast someone moves. */
const LIVE_INTERVAL_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function describeProblem(problem: Fix['problem']): string | null {
  switch (problem) {
    case 'denied':
      return 'Location permission is off. Your clock still counts, but the office will need to check it.';
    case 'disabled':
      return 'Location services are turned off on this phone. Your clock still counts.';
    case 'timeout':
      return 'Could not get a GPS fix in time. Your clock still counts.';
    default:
      return null;
  }
}
