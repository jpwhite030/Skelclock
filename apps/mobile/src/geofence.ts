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
const PENDING_ARRIVALS_KEY = 'skelclock.geofence.pending_arrivals';

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
  /** Company policy in minutes, carried per job the same way operating hours
   * are. 0 means the rule is off and an arrival clocks on immediately. */
  minDwellMinutes: number;
}

/**
 * An arrival that has been noticed but not yet acted on.
 *
 * Crossing a fence and turning up for work look identical at the boundary,
 * and the boundary is the only moment iOS tells us about — region monitoring
 * reports enter and exit, and has no notion of "stayed". So an arrival is
 * parked here instead of being clocked immediately, and settled later once
 * enough time has passed to tell a shift from a drive-past.
 *
 * `arrivedAt` is what eventually becomes the clock's device_time, not the
 * moment it settles. Someone who arrives at 06:58 and whose phone only gets
 * around to sending it at 07:04 started work at 06:58, and that is what
 * payroll has to see.
 */
interface PendingArrival {
  jobId: string;
  /** Epoch ms, device clock. */
  arrivedAt: number;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  candidateJobIds: string[];
  minDwellMinutes: number;
  /** The local notification asking the worker to open the app, so it can be
   * cancelled if the arrival settles on its own first. */
  reminderId: string | null;
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

  const dwellMinutes = resolvedSites[0]?.minDwellMinutes ?? 0;

  if (derivedEventType === 'clock_in' && dwellMinutes > 0) {
    // Park it. iOS tells us about the boundary and nothing else, so "did they
    // stay" cannot be answered here — only later. settlePendingArrivals below
    // is what turns this into a clock, and it runs on the next geofence
    // callback, the next app open, or the reminder being tapped.
    await holdArrival({
      jobId,
      arrivedAt: Date.now(),
      latitude,
      longitude,
      accuracyM: fix.accuracyM,
      candidateJobIds,
      minDwellMinutes: dwellMinutes,
      siteName: resolvedSites[0]?.siteName ?? null,
    });
    return;
  }

  if (derivedEventType === 'clock_out') {
    // Left before the arrival ever became a clock: they did not turn up, they
    // drove past. Drop it, and do not send a clock-off for a shift that never
    // started.
    const dropped = await discardPendingArrival(jobId);
    if (dropped) return;
  }

  // Someone else's arrival may have come of age while this callback was
  // running — the app is awake, which is the scarce thing here.
  await settlePendingArrivals();

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
    insideSince: null,
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

// --- held arrivals ----------------------------------------------------------

async function getPendingArrivals(): Promise<PendingArrival[]> {
  const raw = await AsyncStorage.getItem(PENDING_ARRIVALS_KEY);
  return raw ? (JSON.parse(raw) as PendingArrival[]) : [];
}

async function setPendingArrivals(list: PendingArrival[]): Promise<void> {
  if (list.length === 0) await AsyncStorage.removeItem(PENDING_ARRIVALS_KEY);
  else await AsyncStorage.setItem(PENDING_ARRIVALS_KEY, JSON.stringify(list));
}

/**
 * Notice an arrival without acting on it, and tell the worker what will
 * happen.
 *
 * The notification is not decoration. The phone cannot promise to wake itself
 * in five minutes — iOS decides that — so the honest thing is to say the clock
 * is coming and give the worker a way to make it happen now by opening the
 * app. Silence here would look exactly like the feature being broken.
 */
async function holdArrival(
  arrival: Omit<PendingArrival, 'reminderId'> & { siteName: string | null },
): Promise<void> {
  const { siteName, ...rest } = arrival;
  const existing = await getPendingArrivals();
  // Already holding this one: the first arrival time is the true one, so a
  // second boundary crossing at the fence edge must not push it later.
  if (existing.some((a) => a.jobId === arrival.jobId)) return;

  const at = new Date(arrival.arrivedAt);
  const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

  let reminderId: string | null = null;
  try {
    reminderId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Arrived at ${siteName ?? 'your job site'}`,
        body: `You'll be clocked on from ${stamp} once you've been here ${arrival.minDwellMinutes} minutes. Open SkelClock to do it now.`,
      },
      trigger: { seconds: Math.max(arrival.minDwellMinutes * 60, 60) } as never,
    });
  } catch {
    // A missing notification permission must not cost the clock itself.
  }

  await setPendingArrivals([...existing, { ...rest, reminderId }]);
}

/** Drop a held arrival — they left before it counted. Returns whether there
 * was one, which is what tells a clock-out apart from a drive-past. */
async function discardPendingArrival(jobId: string): Promise<boolean> {
  const existing = await getPendingArrivals();
  const match = existing.find((a) => a.jobId === jobId);
  if (!match) return false;

  if (match.reminderId) {
    await Notifications.cancelScheduledNotificationAsync(match.reminderId).catch(() => undefined);
  }
  await setPendingArrivals(existing.filter((a) => a.jobId !== jobId));
  return true;
}

/**
 * Turn arrivals that have served their time into real clock events.
 *
 * Safe to call from anywhere and as often as anything likes — it is how the
 * app gets a second look at the problem, and there is no other. Called from
 * the geofence task, and from the app coming to the foreground.
 *
 * An arrival that has not yet served its time is simply left alone; one that
 * has is enqueued stamped with when it *started*, not with now.
 */
export async function settlePendingArrivals(): Promise<void> {
  const pending = await getPendingArrivals();
  if (pending.length === 0) return;

  const employeeId = (await getSession())?.employeeId ?? null;
  if (!employeeId) return;

  const now = Date.now();
  const ready = pending.filter((a) => now - a.arrivedAt >= a.minDwellMinutes * 60_000);
  if (ready.length === 0) return;

  const net = await NetInfo.fetch();
  const wasOffline = !(net.isConnected && net.isInternetReachable !== false);
  const store = await SqliteQueueStore.open();
  const queue = new EventQueue(store, new ApiClient(accessToken));
  const device = await deviceId();
  const sites = await getWatchedSites();

  for (const arrival of ready) {
    await queue.enqueue({
      idempotencyKey: newIdempotencyKey(device),
      employeeId,
      eventType: 'clock_in',
      // When they got here, not when the phone got around to it.
      deviceTime: new Date(arrival.arrivedAt).toISOString(),
      jobId: arrival.jobId,
      workActivityId: null,
      latitude: arrival.latitude,
      longitude: arrival.longitude,
      gpsAccuracyM: arrival.accuracyM,
      outsideReason: null,
      clockMethod: 'auto_geofence',
      wasOffline,
      deviceId: device,
      candidateJobIds: arrival.candidateJobIds.length > 1 ? arrival.candidateJobIds : null,
      // The server re-checks this against its own copy of the policy. The
      // phone holding the event is what makes the wait happen; it is not what
      // decides the event is trustworthy.
      insideSince: new Date(arrival.arrivedAt).toISOString(),
    });

    if (arrival.reminderId) {
      await Notifications.cancelScheduledNotificationAsync(arrival.reminderId).catch(
        () => undefined,
      );
    }
  }

  await setPendingArrivals(pending.filter((a) => !ready.some((r) => r.jobId === a.jobId)));
  await queue.flush().catch(() => undefined);

  for (const arrival of ready) {
    const at = new Date(arrival.arrivedAt);
    const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const siteName = sites.find((sx) => sx.jobId === arrival.jobId)?.siteName ?? 'your job site';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Clocked in at ${stamp}`,
        body: `${siteName} — done automatically. Open SkelClock if that's not right.`,
      },
      trigger: null,
    }).catch(() => undefined);
  }
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
          minDwellMinutes: j.geofenceMinDwellMinutes,
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
  await AsyncStorage.removeItem(PENDING_ARRIVALS_KEY);
}
