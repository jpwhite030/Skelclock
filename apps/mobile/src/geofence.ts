/**
 * Background geofence detection — Phase 3.
 *
 * Off by default (see setAutoDetectEnabled). A worker who turns this on lets
 * the phone notice arrival at an assigned job's site even with the app
 * closed, and raise a *suggested* clock event — never an authoritative one.
 * `clockMethod: 'auto_geofence'` plus the server's `is_suggested` derivation
 * (packages/server/src/ingest.ts) keeps it invisible to hours/state until the
 * worker confirms it (packages/core/src/state-machine.ts's
 * `orderedLiveEvents` already filters out suggested events for free).
 *
 * This goes through the exact same offline queue manual clocks use
 * (queue.ts/sqlite-store.ts) — it is not a parallel pipeline, just a
 * different `clockMethod` on the same event shape.
 *
 * Runs independently of the React tree: expo-task-manager can invoke
 * `defineTask`'s callback in a background JS context where no component is
 * mounted, so this opens its own SQLite queue connection and resolves the
 * signed-in employee itself, rather than reaching into useClock's state.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { newIdempotencyKey } from '@skelclock/core';

import { ApiClient, type JobOption } from './api';
import { deviceId } from './device';
import { captureFix } from './location';
import { EventQueue } from './queue';
import { SqliteQueueStore } from './sqlite-store';
import { accessToken, supabase } from './supabase';

export const GEOFENCE_TASK_NAME = 'skelclock-geofence-task';

const TOGGLE_KEY = 'skelclock.geofence.enabled';
const WATCHED_SITES_KEY = 'skelclock.geofence.watched_sites';

interface WatchedSite {
  jobId: string;
  siteName: string | null;
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
  const jobId = region.identifier;
  if (!jobId) return;

  const { data: userData } = await supabase.auth.getUser();
  const employeeId = (userData.user?.user_metadata?.employee_id as string | undefined) ?? null;
  // Not signed in (session expired while watching): nothing sensible to attribute this to.
  if (!employeeId) return;

  // A one-shot fix at the moment of the trigger, same helper and same
  // "never block on this" philosophy as a manual clock. Falls back to the
  // region's own centre if the fix fails - an approximate position beats none.
  const fix = await captureFix();
  const latitude = fix.latitude ?? region.latitude;
  const longitude = fix.longitude ?? region.longitude;

  const net = await NetInfo.fetch();
  const wasOffline = !(net.isConnected && net.isInternetReachable !== false);

  const store = await SqliteQueueStore.open();
  const queue = new EventQueue(store, new ApiClient(accessToken));

  await queue.enqueue({
    idempotencyKey: newIdempotencyKey(await deviceId()),
    employeeId,
    eventType: eventType === Location.GeofencingEventType.Enter ? 'clock_in' : 'clock_out',
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
  });

  // Best-effort immediate send; if it fails the event stays queued and the
  // next app open (or the next scheduled sync) picks it up regardless.
  await queue.flush().catch(() => undefined);

  const sites = await getWatchedSites();
  const siteName = sites.find((s) => s.jobId === jobId)?.siteName ?? 'your job site';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: eventType === Location.GeofencingEventType.Enter ? 'Arrived at a job site?' : 'Left a job site?',
      body: `Looks like you ${eventType === Location.GeofencingEventType.Enter ? 'arrived at' : 'left'} ${siteName}. Open SkelClock to confirm.`,
    },
    trigger: null,
  });
});

async function getWatchedSites(): Promise<WatchedSite[]> {
  const raw = await AsyncStorage.getItem(WATCHED_SITES_KEY);
  return raw ? (JSON.parse(raw) as WatchedSite[]) : [];
}

export async function isAutoDetectEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(TOGGLE_KEY)) === '1';
}

/**
 * Flips the worker's opt-in and (re)registers geofences for their currently
 * assigned jobs. Throws if location permission isn't granted, so the caller
 * can show the worker why it didn't turn on.
 */
export async function setAutoDetectEnabled(enabled: boolean, jobs: JobOption[]): Promise<void> {
  await AsyncStorage.setItem(TOGGLE_KEY, enabled ? '1' : '0');
  if (enabled) {
    await startWatchingJobs(jobs);
  } else {
    await stopWatching();
  }
}

/**
 * Re-registers geofences against the latest assigned-job list. Safe to call
 * often (e.g. whenever `useClock` refreshes) - it's a no-op unless the
 * worker has opted in.
 */
export async function refreshWatchedJobsIfEnabled(jobs: JobOption[]): Promise<void> {
  if (await isAutoDetectEnabled()) {
    await startWatchingJobs(jobs);
  }
}

async function startWatchingJobs(jobs: JobOption[]): Promise<void> {
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
    return;
  }

  await AsyncStorage.setItem(
    WATCHED_SITES_KEY,
    JSON.stringify(withCoords.map((j): WatchedSite => ({ jobId: j.id, siteName: j.siteName }))),
  );

  await Location.startGeofencingAsync(
    GEOFENCE_TASK_NAME,
    withCoords.map((j) => ({
      identifier: j.id,
      latitude: j.latitude,
      longitude: j.longitude,
      radius: j.geofenceRadiusM,
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
  );
}

export async function stopWatching(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(GEOFENCE_TASK_NAME);
  if (registered) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
  }
  await AsyncStorage.removeItem(WATCHED_SITES_KEY);
}
