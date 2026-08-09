/**
 * The clock hook — everything the home screen needs, in one place.
 *
 * Two principles drive the design:
 *
 *   * The UI reads from local state, never from the network. A press updates
 *     the on-device queue and the visible state immediately; syncing happens
 *     behind it. A worker on a site with one bar should never watch a spinner
 *     to find out whether they are clocked on.
 *   * The state machine from @skelclock/core runs here too, over the same
 *     events, so the phone and the server always agree on which buttons are
 *     legal. A rejection at sync time should be impossible for anything the
 *     app itself could have caught.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import {
  allowedEvents,
  applyTransition,
  evaluateGeofence,
  isWithinOperatingHours,
  minutesSinceLocalMidnight,
  newIdempotencyKey,
  type AttendanceEventType,
  type ClockState,
} from '@skelclock/core';
import { GEOFENCE_CONSENT_POLICY_VERSION } from '@skelclock/contracts';

import {
  ApiClient,
  type ActivityOption,
  type JobOption,
  type PendingSuggestionDto,
  type WorkerHomeDto,
} from './api';
import { captureFix, describeProblem, type Fix } from './location';
import { deviceId } from './device';
import {
  checkPermissionHealth,
  isAutoDetectEnabled,
  refreshWatchedJobsIfEnabled,
  setAutoDetectEnabled,
  type PermissionHealth,
} from './geofence';
import { EventQueue, type QueuedEvent } from './queue';
import { SqliteQueueStore } from './sqlite-store';
import { accessToken } from './supabase';

export interface ClockScreenState {
  loading: boolean;
  home: WorkerHomeDto | null;
  jobs: JobOption[];
  activities: ActivityOption[];
  /** Derived locally so it stays right while offline. */
  clockState: ClockState;
  availableActions: AttendanceEventType[];
  pending: QueuedEvent[];
  online: boolean;
  syncing: boolean;
  banner: { tone: 'info' | 'warn' | 'error'; text: string } | null;
  /** Phase 3: worker opt-in for background geofence auto-detect. Off by default. */
  autoDetectEnabled: boolean;
  /** 'needs_attention' when the toggle is on but the OS permission got silently revoked. */
  permissionHealth: PermissionHealth;
  /** True when there were more assigned sites with coordinates than the platform can watch at once. */
  autoDetectTruncated: boolean;
  /** Geofence-raised events waiting on this worker to confirm or dismiss. */
  suggestions: PendingSuggestionDto[];
}

export interface PressOptions {
  jobId?: string | null;
  workActivityId?: string | null;
  /** Supplied by the UI after prompting, when the fix falls outside the fence. */
  outsideReason?: string | null;
}

export interface GeofencePrompt {
  distanceM: number;
  siteName: string | null;
}

const REFRESH_MS = 60_000;

export function useClock(employeeId: string | null) {
  const [state, setState] = useState<ClockScreenState>({
    loading: true,
    home: null,
    jobs: [],
    activities: [],
    clockState: 'off',
    availableActions: ['clock_in'],
    pending: [],
    online: true,
    syncing: false,
    banner: null,
    autoDetectEnabled: false,
    permissionHealth: 'disabled',
    autoDetectTruncated: false,
    suggestions: [],
  });

  const queueRef = useRef<EventQueue | null>(null);
  const storeRef = useRef<SqliteQueueStore | null>(null);
  const apiRef = useRef<ApiClient>(new ApiClient(accessToken));
  // Guards against a second flush starting while one is in flight, which would
  // submit the same events twice. Harmless server-side thanks to idempotency,
  // but it wastes a worker's data allowance.
  const flushing = useRef(false);

  // --- setup ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const store = await SqliteQueueStore.open();
      // Anything left 'syncing' was interrupted by an app kill mid-flush.
      await store.recoverInterrupted();

      if (cancelled) return;
      storeRef.current = store;
      queueRef.current = new EventQueue(store, apiRef.current);

      const autoDetectEnabled = await isAutoDetectEnabled();
      const permissionHealth = await checkPermissionHealth();
      if (!cancelled) setState((s) => ({ ...s, autoDetectEnabled, permissionHealth }));

      void checkinDevice(apiRef.current, permissionHealth);

      await refresh();
      await sync();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  // Reception coming back is the moment the backlog should go.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((netState) => {
      const online = Boolean(netState.isConnected && netState.isInternetReachable !== false);
      setState((s) => ({ ...s, online }));
      if (online) void sync();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // So does bringing the app back to the foreground - also the moment to
  // notice a background permission the OS quietly revoked while closed.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refresh();
        void sync();
        void checkPermissionHealth().then((permissionHealth) => {
          setState((s) => ({ ...s, permissionHealth }));
          void checkinDevice(apiRef.current, permissionHealth);
        });
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the running hours figure honest without hammering the API.
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
      void sync();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- data ----------------------------------------------------------------

  const refresh = useCallback(async (): Promise<void> => {
    const queue = queueRef.current;
    const pending = queue ? await queue.pending() : [];

    try {
      const workDate = localDate(new Date());
      const [home, jobs, activities, suggestions] = await Promise.all([
        apiRef.current.home(workDate),
        apiRef.current.jobs(),
        apiRef.current.activities(),
        // A worker who has never opted into auto-detect will just always get
        // an empty list back here - cheap enough not to bother gating on it.
        apiRef.current.pendingSuggestions().catch(() => []),
      ]);

      // Re-registers geofences against today's assignments; a no-op unless
      // the worker has opted in. Fire-and-forget: a permission hiccup here
      // must never break the clock screen itself.
      void refreshWatchedJobsIfEnabled(jobs)
        .then((watch) => {
          if (watch) setState((s) => ({ ...s, autoDetectTruncated: watch.truncated }));
        })
        .catch(() => undefined);

      setState((s) => ({
        ...s,
        loading: false,
        home,
        jobs,
        activities,
        pending,
        suggestions,
        // The server's view, then anything queued locally on top of it — that
        // is what keeps the buttons right for a worker who clocked on with no
        // reception and has not synced yet.
        clockState: applyQueued(home.clockState, pending),
        availableActions: allowedEvents(applyQueued(home.clockState, pending)),
        online: true,
      }));
    } catch {
      // Offline: keep whatever we last knew and fold in the local queue.
      setState((s) => {
        const derived = applyQueued(s.home?.clockState ?? s.clockState, pending);
        return {
          ...s,
          loading: false,
          pending,
          clockState: derived,
          availableActions: allowedEvents(derived),
          online: false,
        };
      });
    }
  }, []);

  const sync = useCallback(async (): Promise<void> => {
    const queue = queueRef.current;
    if (!queue || flushing.current) return;

    flushing.current = true;
    setState((s) => ({ ...s, syncing: true }));

    try {
      const result = await queue.flush();

      if (result.rejections.length > 0) {
        setState((s) => ({
          ...s,
          banner: { tone: 'error', text: result.rejections[0]!.message },
        }));
      }
      // Only re-read the server when something actually landed there; a flush
      // that found nothing to send should not cost a round trip.
      if (result.accepted > 0) await refresh();
    } finally {
      flushing.current = false;
      const pending = await queue.pending();
      setState((s) => ({ ...s, syncing: false, pending }));
    }
  }, [refresh]);

  // --- actions -------------------------------------------------------------

  /**
   * Checks a prospective clock against the site fence, before queueing.
   *
   * Returns a prompt when the worker is outside, so the UI can ask for a reason
   * rather than the office chasing it the next morning. The clock is never
   * blocked — pressing on without a reason is allowed and simply creates an
   * exception, exactly as the brief requires.
   */
  const checkGeofence = useCallback(
    async (jobId: string | null): Promise<{ fix: Fix; prompt: GeofencePrompt | null }> => {
      const fix = await captureFix();
      const job = state.jobs.find((j) => j.id === jobId) ?? null;

      const verdict = evaluateGeofence({
        position:
          fix.latitude != null && fix.longitude != null
            ? { latitude: fix.latitude, longitude: fix.longitude }
            : null,
        accuracyM: fix.accuracyM,
        site:
          job?.latitude != null && job.longitude != null
            ? { latitude: job.latitude, longitude: job.longitude }
            : null,
        radiusM: job?.geofenceRadiusM ?? 70,
      });

      // Poor GPS whose error bars reach the fence is not worth interrupting a
      // worker over — same rule the server applies when raising exceptions.
      const needsReason =
        verdict.insideGeofence === false && !verdict.withinAccuracyMargin;

      return {
        fix,
        prompt: needsReason
          ? { distanceM: Math.round(verdict.distanceM ?? 0), siteName: job?.siteName ?? null }
          : null,
      };
    },
    [state.jobs],
  );

  const press = useCallback(
    async (
      eventType: AttendanceEventType,
      options: PressOptions = {},
      fix?: Fix,
    ): Promise<{ ok: boolean; message?: string }> => {
      const queue = queueRef.current;
      if (!queue || !employeeId) return { ok: false, message: 'Still starting up.' };

      // Local guard first, so an illegal press is refused instantly and never
      // reaches the queue.
      const transition = applyTransition(state.clockState, eventType);
      if (!transition.ok) return { ok: false, message: transition.message };

      const jobId =
        options.jobId !== undefined ? options.jobId : (state.home?.currentJobId ?? state.home?.assignedJob?.id ?? null);

      // Operating hours, checked locally for the same reason the state
      // machine is: offline, the server's own refusal would arrive hours late
      // — after a whole day has been worked on top of a clock-on that was
      // never going to count, taking every event after it down with it. The
      // jobs payload carries the already-resolved window (site override, else
      // company default); with no job selected there is nothing local to
      // check against, and the server — which always knows — stays the guard.
      if (eventType === 'clock_in' && jobId) {
        const job = state.jobs.find((j) => j.id === jobId);
        const window = {
          start: job?.operatingHoursStart ?? null,
          end: job?.operatingHoursEnd ?? null,
        };
        if (!isWithinOperatingHours(minutesSinceLocalMidnight(new Date()), window)) {
          return {
            ok: false,
            message: `Clock-on is only accepted between ${window.start!.slice(0, 5)} and ${window.end!.slice(0, 5)}.`,
          };
        }
      }

      // Location only on the events that need it — see the privacy section.
      const needsFix = eventType === 'clock_in' || eventType === 'clock_out';
      const position = fix ?? (needsFix ? await captureFix() : null);

      // Captured here, not at flush time: this is the worker's own clock at the
      // moment they pressed, and it is what payroll is owed.
      const deviceTime = new Date().toISOString();

      await queue.enqueue({
        idempotencyKey: newIdempotencyKey(await deviceId()),
        employeeId,
        eventType,
        deviceTime,
        jobId,
        workActivityId:
          options.workActivityId !== undefined
            ? options.workActivityId
            : (state.home?.currentActivityId ?? null),
        latitude: position?.latitude ?? null,
        longitude: position?.longitude ?? null,
        gpsAccuracyM: position?.accuracyM ?? null,
        outsideReason: options.outsideReason ?? null,
        clockMethod: 'manual',
        wasOffline: !state.online,
        deviceId: await deviceId(),
      });

      const nextState = transition.nextState;
      const pending = await queue.pending();
      setState((s) => ({
        ...s,
        clockState: nextState,
        availableActions: allowedEvents(nextState),
        pending,
        banner: position?.problem
          ? { tone: 'warn', text: describeProblem(position.problem)! }
          : s.banner,
      }));

      void sync();
      return { ok: true };
    },
    [employeeId, state.clockState, state.home, state.jobs, state.online, sync],
  );

  /**
   * Flips the worker's auto-detect opt-in. Throws (via setAutoDetectEnabled)
   * if location permission is refused - the caller is expected to show that
   * to the worker, same as any other permission-denied path. The caller
   * (index.tsx) is responsible for showing the tracking notice and only
   * calling this once the worker has actually agreed to it — this function
   * treats being called with enabled=true as that agreement and logs it.
   */
  const toggleAutoDetect = useCallback(
    async (enabled: boolean): Promise<void> => {
      const result = await setAutoDetectEnabled(enabled, state.jobs);
      const permissionHealth = await checkPermissionHealth();
      setState((s) => ({
        ...s,
        autoDetectEnabled: enabled,
        autoDetectTruncated: result.truncated,
        permissionHealth,
      }));

      // Best-effort: the toggle already reflects reality even if this write
      // fails offline - nothing downstream depends on it succeeding, and it
      // is retried in effect next time the toggle moves.
      void apiRef.current
        .recordGeofenceConsent({
          action: enabled ? 'granted' : 'revoked',
          policyVersion: GEOFENCE_CONSENT_POLICY_VERSION,
          deviceId: await deviceId(),
        })
        .catch(() => undefined);
    },
    [state.jobs],
  );

  const confirmSuggestion = useCallback(
    async (suggestionId: string, jobId?: string): Promise<void> => {
      await apiRef.current.confirmSuggestion(suggestionId, jobId);
      setState((s) => ({ ...s, suggestions: s.suggestions.filter((sg) => sg.id !== suggestionId) }));
      await refresh();
    },
    [refresh],
  );

  const dismissSuggestion = useCallback(
    async (suggestionId: string, reason: string): Promise<void> => {
      await apiRef.current.dismissSuggestion(suggestionId, reason);
      setState((s) => ({
        ...s,
        suggestions: s.suggestions.filter((sg) => sg.id !== suggestionId),
      }));
    },
    [],
  );

  const dismissBanner = useCallback(() => {
    setState((s) => ({ ...s, banner: null }));
  }, []);

  return {
    state,
    press,
    refresh,
    sync,
    checkGeofence,
    dismissBanner,
    toggleAutoDetect,
    confirmSuggestion,
    dismissSuggestion,
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Fire-and-forget: lets the office eventually tell "auto-detect is on but
 * background location got silently revoked" apart from "working fine" (see
 * device.location_permission, wired up by packages/server/src/devices.ts).
 * Never awaited by a caller for anything user-visible.
 */
function checkinDevice(api: ApiClient, permissionHealth: PermissionHealth): void {
  void (async () => {
    try {
      await api.checkinDevice({
        deviceId: await deviceId(),
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null,
        appVersion: Application.nativeApplicationVersion,
        locationPermission: permissionHealth === 'disabled' ? undefined : permissionHealth === 'ok' ? 'granted' : 'denied',
        pushToken: await expoPushToken(),
      });
    } catch {
      // Best-effort only - a failed check-in has no effect on the worker's day.
    }
  })();
}

/**
 * The Expo push token for this install, or null when notifications are off.
 *
 * This is what lets the server's notification sweep (missing clock-out
 * nudges, stale-suggestion reminders) reach this phone. Null is a fine
 * answer — the sweep just skips this worker — and the server keeps the last
 * good token, so one failed read here never un-registers the device.
 */
async function expoPushToken(): Promise<string | null> {
  try {
    const perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) return null;
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId ?? Constants.easConfig?.projectId ?? undefined;
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return token.data;
  } catch {
    // No EAS project configured yet (bare dev build) — push simply stays off.
    return null;
  }
}

/** Folds locally-queued events on top of the server's view of the state. */
function applyQueued(serverState: ClockState, pending: readonly QueuedEvent[]): ClockState {
  let current = serverState;
  for (const item of pending) {
    if (item.status === 'rejected') continue;
    const result = applyTransition(current, item.eventType);
    if (result.ok) current = result.nextState;
  }
  return current;
}

/** YYYY-MM-DD in the device's own timezone, which is the site's timezone. */
function localDate(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
