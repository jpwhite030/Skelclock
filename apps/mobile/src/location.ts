/**
 * Location capture.
 *
 * Bound tightly by the privacy requirements: a fix is taken at the moment of a
 * clock event and at no other time. There is no background location task, no
 * watcher, and nothing that keeps running after clock-out — the only API used
 * here is a one-shot `getCurrentPositionAsync`.
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
