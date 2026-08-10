/**
 * Background geofence detection — Phase 3.
 *
 * Off by default (see setAutoDetectEnabled). A worker who turns this on lets
 * the phone notice arrival at or departure from an assigned job's site, even
 * with the app closed, and raise a clock event for it. Most of the time that
 * event needs no tap at all — see the auto-confirm note below — tap-to-confirm
 * is the fallback for anything the phone is not sure about, never the default.
 *
 * This goes through the exact same offline queue manual clocks use
 * (queue.ts/sqlite-store.ts) — it is not a parallel pipeline, just a
 * different `clockMethod` on the same event shape.
 *
 * Runs independently of the React tree: expo-task-manager can invoke
 * `defineTask`'s callback in a background JS context where no component is
 * mounted, so this opens its own SQLite queue connection and resolves the
 * signed-in employee itself, rather than reaching into useClock's state.
 *
 * Three safety nets live here, mirrored server-side in ingest.ts so a bug in
 * one is not the only thing standing between a bad fix and a wrong payroll
 * record:
 *   1. Region cap — iOS refuses to monitor more than 20 regions per app.
 *   2. Debounce — GPS bouncing at a fence edge must not fire twice.
 *   3. Ambiguity — a fix inside two assigned sites' fences at once is never
 *      guessed at; the worker picks (see candidateJobIds).
 * What actually decides whether an event lands live or needs a tap is
 * server-side (shouldAutoConfirmGeofence, packages/core/src/geo.ts) — the
 * client's own read of accuracy/ambiguity only chooses notification copy.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { evaluateGeofence, newIdempotencyKey } from '@skelclock/core';

import { ApiClient, type JobOption } from './api';
import { deviceId } from './device';
import { captureFix } from './location';
import { EventQueue } from './queue';
import { SqliteQueueStore } from './sqlite-store';
import { accessToken, getSession } from './auth';

export const GEOFENCE_TASK_NAME = 'skelclock-geofence-task';

const TOGGLE_KEY = 'skelclock.geofence.enabled';
const WATCHED_SITES_KEY = 'skelclock.geofence.watched_sites';
const LAST_TRIGGER_KEY = 'skelclock.geofence.last_trigger';

/**
 * iOS hard-caps `startMonitoringForRegion` at 20 concurrent regions per app —
 * past that, registration silently stops taking new ones. Android's ceiling
 * (100) is much higher, but there is no good reason to run the two platforms
 * differently, so both use the conservative number.
 */
const MAX_WATCHED_SITES = 20;

/**
 * Smallest region iOS will monitor dependably. Apple's own guidance puts the
 * floor near 100m, because region monitoring runs off coarse cell and wifi
 * position rather than GPS. Anything tighter is registered and then quietly
 * never fires.
 */
const MIN_REGION_RADIUS_M = 100;

/**
 * How close together two triggers of the same type, for the same job, have
 * to land before the second is dropped as GPS bounce rather than treated as
 * a second real arrival/departure. Kept in sync by hand with
 * AUTO_GEOFENCE_DEBOUNCE_MS in packages/server/src/ingest.ts — that is the
 * authoritative copy of this rule, this one only avoids bothering the worker
 * with a notification the server would have collapsed anyway.
 */
const DEBOUNCE_MS = 10 * 60_000;

interface WatchedSite {
  jobId: string;
  siteName: string | null;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

TaskManager.defineTask(GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('SkelClock geofence task error', error);
    return;
  }

  const { eventType, region } = data as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  };
  const regionJobId = region.identifier;
  if (!regionJobId) return;

  const employeeId = (await getSession())?.employeeId ?? null;
  // Not signed in (session expired while watching): nothing sensible to attribute this to.
  if (!employeeId) return;

  // A one-shot fix at the moment of the trigger, same helper and same
  // "never block on this" philosophy as a manual clock. Falls back to the
  // region's own centre if the fix fails - an approximate position beats none.
  const fix = await captureFix();
  const latitude = fix.latitude ?? region.latitude;
  const longitude = fix.longitude ?? region.longitude;

  const derivedEventType =
    eventType === Location.GeofencingEventType.Enter ? 'clock_in' : 'clock_out';

  const sites = await getWatchedSites();

  // Geometry, not just the region that happened to callback: the OS fires one
  // callback per region crossed, so trusting region.identifier alone would
  // silently pick one site even when the fix is inside two assigned sites'
  // fences at once. Recomputing against every watched site is what makes that
  // ambiguity visible instead of guessed away.
  const candidates = sites.filter(
    (s) =>
      evaluateGeofence({
        position: { latitude, longitude },
        accuracyM: fix.accuracyM,
        site: { latitude: s.latitude, longitude: s.longitude },
        radiusM: s.geofenceRadiusM,
      }).insideGeofence === true,
  );
  const candidateJobIds = candidates.length > 0 ? candidates.map((c) => c.jobId) : [regionJobId];
  const jobId = candidateJobIds[0]!;
  // Geometry found nothing (fix arrived slightly after crossing the edge) -
  // still resolve the site by the region the OS told us fired, so the
  // notification can name it instead of falling back to "your job site".
  const resolvedSites = candidates.length > 0 ? candidates : sites.filter((s) => s.jobId === jobId);

  if (await recentlyTriggered(jobId, derivedEventType)) return;
  await recordTrigger(jobId, derivedEventType);

  const net = await NetInfo.fetch();
  const wasOffline = !(net.isConnected && net.isInternetReachable !== false);

  const store = await SqliteQueueStore.open();
  const queue = new EventQueue(store, new ApiClient(accessToken));
  const idempotencyKey = newIdempotencyKey(await deviceId());

  await queue.enqueue({
    idempotencyKey,
    employeeId,
    eventType: derivedEventType,
    deviceTime: new Date().toISOString(),
    jobId,
    workActivityId: null,
    latitude,
    longitude,
    gpsAccuracyM: fix.accuracyM,
    outsideReason: null,
    clockMethod: 'auto_geofence',
    wasOffline,
    deviceId: await deviceId(),
    candidateJobIds: candidateJobIds.length > 1 ? candidateJobIds : null,
  });

  // Best-effort immediate send; if it fails the event stays queued and the
  // next app open (or the next scheduled sync) picks it up regardless.
  const flushResult = await queue.flush().catch(() => undefined);
  const autoConfirmed =
    flushResult?.created.find((c) => c.idempotencyKey === idempotencyKey)?.autoConfirmed ?? false;

  await notify({ derivedEventType, candidateJobIds, candidates: resolvedSites, autoConfirmed });
});

async function notify(args: {
  derivedEventType: 'clock_in' | 'clock_out';
  candidateJobIds: string[];
  candidates: WatchedSite[];
  autoConfirmed: boolean;
}): Promise<void> {
  const { derivedEventType, candidateJobIds, candidates, autoConfirmed } = args;
  const arrived = derivedEventType === 'clock_in';
  const siteName = candidates[0]?.siteName ?? 'your job site';
  const ambiguous = candidateJobIds.length > 1;

  if (autoConfirmed) {
    // The time is the thing a worker checks. A clock they did not press has to
    // say when it happened, or the only way to know whether the app caught the
    // right moment is to open it — and a notification that has to be opened to
    // be useful is a notification that failed. It is also what makes a wrong
    // one arguable: "it says 6:42, I was still driving" is a correction the
    // office can act on.
    const at = new Date();
    const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

    // Never fires when ambiguous - shouldAutoConfirmGeofence server-side
    // refuses whenever candidateJobIds carries more than one entry.
    await Notifications.scheduleNotificationAsync({
      content: {
        title: arrived ? `Clocked in at ${stamp}` : `Clocked off at ${stamp}`,
        body: `${siteName} — done automatically. Open SkelClock if that's not right.`,
      },
      trigger: null,
    });
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: arrived ? 'Arrived at a job site?' : 'Left a job site?',
      body: ambiguous
        ? `Looks like you're near ${candidateJobIds.length} job sites. Open SkelClock to say which one.`
        : `Looks like you ${arrived ? 'arrived at' : 'left'} ${siteName}. Open SkelClock to confirm.`,
    },
    trigger: null,
  });
}

async function getWatchedSites(): Promise<WatchedSite[]> {
  const raw = await AsyncStorage.getItem(WATCHED_SITES_KEY);
  return raw ? (JSON.parse(raw) as WatchedSite[]) : [];
}

/** In-memory per-process debounce state, backed by AsyncStorage so it also
 * survives the headless relaunch a background trigger can cause. */
async function recentlyTriggered(jobId: string, eventType: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(LAST_TRIGGER_KEY);
  const table = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  const last = table[`${jobId}:${eventType}`];
  return typeof last === 'number' && Date.now() - last < DEBOUNCE_MS;
}

async function recordTrigger(jobId: string, eventType: string): Promise<void> {
  const raw = await AsyncStorage.getItem(LAST_TRIGGER_KEY);
  const table = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  table[`${jobId}:${eventType}`] = Date.now();
  await AsyncStorage.setItem(LAST_TRIGGER_KEY, JSON.stringify(table));
}

export async function isAutoDetectEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(TOGGLE_KEY)) === '1';
}

/**
 * Compares the worker's stated intent (the toggle) against what the OS
 * actually granted. Both platforms can silently downgrade "Always" to "While
 * Using" behind the app's back - iOS periodically re-prompts and defaults to
 * doing exactly that - and the toggle alone cannot tell the difference
 * between "working" and "quietly stopped weeks ago".
 */
export type PermissionHealth = 'ok' | 'needs_attention' | 'disabled';

export async function checkPermissionHealth(): Promise<PermissionHealth> {
  const enabled = await isAutoDetectEnabled();
  if (!enabled) return 'disabled';
  const background = await Location.getBackgroundPermissionsAsync();
  return background.status === 'granted' ? 'ok' : 'needs_attention';
}

export interface StartWatchingResult {
  watching: number;
  /** True when there were more assigned sites with coordinates than MAX_WATCHED_SITES allows. */
  truncated: boolean;
}

/**
 * Flips the worker's opt-in and (re)registers geofences for their currently
 * assigned jobs. Throws if location permission isn't granted, so the caller
 * can show the worker why it didn't turn on.
 */
export async function setAutoDetectEnabled(
  enabled: boolean,
  jobs: JobOption[],
): Promise<StartWatchingResult> {
  await AsyncStorage.setItem(TOGGLE_KEY, enabled ? '1' : '0');
  if (enabled) {
    return startWatchingJobs(jobs);
  }
  await stopWatching();
  return { watching: 0, truncated: false };
}

/**
 * Re-registers geofences against the latest assigned-job list. Safe to call
 * often (e.g. whenever `useClock` refreshes) - it's a no-op unless the
 * worker has opted in.
 */
export async function refreshWatchedJobsIfEnabled(jobs: JobOption[]): Promise<StartWatchingResult | null> {
  if (await isAutoDetectEnabled()) {
    return startWatchingJobs(jobs);
  }
  return null;
}

async function startWatchingJobs(jobs: JobOption[]): Promise<StartWatchingResult> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    throw new Error('Location permission was not granted.');
  }
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== 'granted') {
    throw new Error(
      'Background ("Always Allow") location permission was not granted - auto-detect needs this to work with the app closed.',
    );
  }
  await Notifications.requestPermissionsAsync();

  // Jobs with no coordinates yet simply can't be watched - same graceful-null
  // handling evaluateGeofence already applies (packages/core/src/geo.ts).
  const withCoords = jobs.filter(
    (j): j is JobOption & { latitude: number; longitude: number } =>
      j.latitude != null && j.longitude != null,
  );

  if (withCoords.length === 0) {
    await stopWatching();
    return { watching: 0, truncated: false };
  }

  const truncated = withCoords.length > MAX_WATCHED_SITES;
  const watched = withCoords.slice(0, MAX_WATCHED_SITES);

  await AsyncStorage.setItem(
    WATCHED_SITES_KEY,
    JSON.stringify(
      watched.map(
        (j): WatchedSite => ({
          jobId: j.id,
          siteName: j.siteName,
          latitude: j.latitude,
          longitude: j.longitude,
          geofenceRadiusM: j.geofenceRadiusM,
        }),
      ),
    ),
  );

  await Location.startGeofencingAsync(
    GEOFENCE_TASK_NAME,
    watched.map((j) => ({
      identifier: j.id,
      latitude: j.latitude,
      longitude: j.longitude,
      // Not the office's fence — the radius at which the OS agrees to wake us.
      //
      // iOS monitors regions off coarse cell and wifi position to keep the
      // radio asleep, and stops firing reliably below about 100m. A site fenced
      // at 10m for a small office building is a region iOS will mostly ignore,
      // so the worker walks in and nothing happens at all — the failure is
      // total and silent, which is the worst kind.
      //
      // Widening only changes when we are woken. The task re-evaluates the fix
      // against each site's real geofenceRadiusM before it treats anyone as
      // arrived, so a wake 60m from a 10m fence resolves to no candidate and
      // no clock. Coarse trigger, exact decision.
      radius: Math.max(j.geofenceRadiusM, MIN_REGION_RADIUS_M),
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
  );

  return { watching: watched.length, truncated };
}

export async function stopWatching(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(GEOFENCE_TASK_NAME);
  if (registered) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
  }
  await AsyncStorage.removeItem(WATCHED_SITES_KEY);
}
