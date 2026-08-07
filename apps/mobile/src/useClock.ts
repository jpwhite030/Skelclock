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
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import {
  allowedEvents,
  applyTransition,
  blocksClockIn,
  evaluateGeofence,
  newIdempotencyKey,
  type AttendanceEventType,
  type ClockState,
} from '@skelclock/core';

import {
  ApiClient,
  type ActivityOption,
  type JobOption,
  type PendingSuggestionDto,
  type WorkerHomeDto,
} from './api';
import { captureFix, describeProblem, watchPosition, type Fix } from './location';
import * as tracking from './tracking';
import { deviceId } from './device';
import {
  isAutoDetectEnabled,
  refreshWatchedJobsIfEnabled,
  setAutoDetectEnabled,
} from './geofence';
import { EventQueue, type QueuedEvent } from './queue';
import { SqliteQueueStore } from './sqlite-store';
import { accessToken } from './auth';

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
  /** Geofence-raised events waiting on this worker to confirm or dismiss. */
  suggestions: PendingSuggestionDto[];
  /**
   * The last position fix, kept only so the site plan has something to draw.
   *
   * This is a record of a fix already taken for another reason — a clock event,
   * or the worker asking outright — never a reason to take one. Nothing here
   * polls, and it is deliberately dropped on sign-out with the rest of state.
   */
  lastFix: Fix | null;
  lastFixAt: string | null;
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

export interface GeofenceCheck {
  fix: Fix;
  /** Set when the worker is off-site and should be told before proceeding. */
  prompt: GeofencePrompt | null;
  /**
   * True only when we are confident the worker is beyond the fence. Never set
   * by a missing fix, a site with no coordinates, or GPS whose error bars
   * reach the boundary — see blocksClockIn() in @skelclock/core.
   */
  blocked: boolean;
  distanceM: number | null;
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
    suggestions: [],
    lastFix: null,
    lastFixAt: null,
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
      if (!cancelled) setState((s) => ({ ...s, autoDetectEnabled }));

      await refresh();
      await sync();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  /**
   * Follow the worker for the length of the shift, and only the shift.
   *
   * Keyed on clockState, so every way of leaving the clocked-on state stops
   * tracking — a clock-off, a correction from the office, a refresh that says
   * the shift ended. Sign-out is handled in auth.ts for the same reason: there
   * must be no route out of "on shift" that leaves the watcher running.
   */
  useEffect(() => {
    const onShift = state.clockState === 'working' || state.clockState === 'on_break';

    if (!onShift) {
      void tracking.stop();
      return;
    }

    let cancelled = false;
    let stopWatching: (() => void) | undefined;

    void tracking.start();
    void watchPosition((fix) => tracking.reportForegroundFix(fix)).then((stop) => {
      if (cancelled) stop();
      else stopWatching = stop;
    });

    return () => {
      cancelled = true;
      stopWatching?.();
    };
  }, [state.clockState]);

  // Positions from either source — the foreground watcher or the background
  // task — arrive here and drive the map.
  useEffect(
    () =>
      tracking.onPosition((fix, at) =>
        setState((s) => ({ ...s, lastFix: fix, lastFixAt: at })),
      ),
    [],
  );

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

  // So does bringing the app back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refresh();
        void sync();
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
      void refreshWatchedJobsIfEnabled(jobs).catch(() => undefined);

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
    async (jobId: string | null): Promise<GeofenceCheck> => {
      const fix = await captureFix();
      const job = state.jobs.find((j) => j.id === jobId) ?? null;

      // Remembered for the site plan. The fix has already been taken by the
      // time we get here; keeping it costs nothing and saves taking another.
      if (fix.latitude != null && fix.longitude != null) {
        setState((s) => ({ ...s, lastFix: fix, lastFixAt: new Date().toISOString() }));
      }

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
        radiusM: job?.geofenceRadiusM ?? 200,
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
        // Decided here rather than in the screen: whether someone may start
        // work is not a presentation concern, and the rule lives in core where
        // it is tested.
        blocked: blocksClockIn(verdict),
        distanceM: verdict.distanceM,
        siteName: job?.siteName ?? null,
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
    [employeeId, state.clockState, state.home, state.online, sync],
  );

  /**
   * Flips the worker's auto-detect opt-in. Throws (via setAutoDetectEnabled)
   * if location permission is refused - the caller is expected to show that
   * to the worker, same as any other permission-denied path.
   */
  const toggleAutoDetect = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setAutoDetectEnabled(enabled, state.jobs);
      setState((s) => ({ ...s, autoDetectEnabled: enabled }));
    },
    [state.jobs],
  );

  const confirmSuggestion = useCallback(async (suggestionId: string): Promise<void> => {
    await apiRef.current.confirmSuggestion(suggestionId);
    setState((s) => ({ ...s, suggestions: s.suggestions.filter((sg) => sg.id !== suggestionId) }));
    await refresh();
  }, [refresh]);

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
