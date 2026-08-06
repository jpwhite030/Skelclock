/**
 * The clock screen.
 *
 * Everything a worker needs before 6am, in one view and without scrolling on a
 * normal handset: which job, where it is, whether they are on, how long they
 * have been on, whether anything is waiting to sync, and one very large button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AttendanceEventType } from '@skelclock/core';

import type { PendingSuggestionDto } from '../src/api';
import { useClock, type PressOptions } from '../src/useClock';
import { supabase, signOut } from '../src/supabase';
import { colors, radius, spacing, type, MIN_TAP } from '../src/theme';

export default function ClockScreen() {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    // The app_user row carries the employee link; the JWT only has the auth id.
    supabase.auth.getUser().then(({ data }) => {
      setEmployeeId((data.user?.user_metadata?.employee_id as string) ?? null);
    });
  }, []);

  const {
    state,
    press,
    refresh,
    sync,
    checkGeofence,
    dismissBanner,
    toggleAutoDetect,
    confirmSuggestion,
    dismissSuggestion,
  } = useClock(employeeId);
  const [busy, setBusy] = useState(false);
  const shownSuggestionIds = useRef(new Set<string>());

  const jobId = state.home?.currentJobId ?? state.home?.assignedJob?.id ?? null;

  // Surface each newly-seen suggestion once, with Confirm/Dismiss - the same
  // Alert pattern already used for the outside-geofence confirmation below.
  useEffect(() => {
    const next = state.suggestions.find((s) => !shownSuggestionIds.current.has(s.id));
    if (!next) return;
    shownSuggestionIds.current.add(next.id);
    promptSuggestion(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.suggestions]);

  const promptSuggestion = useCallback(
    (suggestion: PendingSuggestionDto) => {
      const action = suggestion.eventType === 'clock_in' ? 'clocking in' : 'clocking out';
      Alert.alert(
        'Confirm your clock',
        `Looks like you ${suggestion.eventType === 'clock_in' ? 'arrived at' : 'left'} ${
          suggestion.siteName ?? 'a job site'
        } at ${formatTime(suggestion.deviceTime)}. Confirm you were ${action}?`,
        [
          {
            text: "That wasn't me",
            style: 'destructive',
            onPress: () => void dismissSuggestion(suggestion.id, 'Worker said this was not them'),
          },
          {
            text: 'Confirm',
            onPress: () => void confirmSuggestion(suggestion.id),
          },
        ],
      );
    },
    [confirmSuggestion, dismissSuggestion],
  );

  const onToggleAutoDetect = useCallback(
    async (next: boolean) => {
      try {
        await toggleAutoDetect(next);
      } catch (err) {
        Alert.alert(
          "Couldn't turn that on",
          err instanceof Error
            ? err.message
            : 'Location permission is needed for auto-detect to work.',
        );
      }
    },
    [toggleAutoDetect],
  );

  /**
   * Runs a clock event, asking for a reason first if the worker is outside the
   * fence. "Clock on anyway" is always available — the brief is explicit that
   * GPS must not stop someone starting work.
   */
  const runClockEvent = useCallback(
    async (eventType: AttendanceEventType, options: PressOptions = {}) => {
      if (busy) return;
      setBusy(true);
      try {
        const needsFix = eventType === 'clock_in' || eventType === 'clock_out';
        if (!needsFix) {
          const result = await press(eventType, options);
          if (!result.ok) Alert.alert('Cannot do that yet', result.message);
          return;
        }

        const { fix, prompt } = await checkGeofence(options.jobId ?? jobId);

        if (!prompt) {
          const result = await press(eventType, { ...options, jobId: options.jobId ?? jobId }, fix);
          if (!result.ok) Alert.alert('Cannot do that yet', result.message);
          return;
        }

        Alert.alert(
          'You are away from the site',
          `You are about ${formatDistance(prompt.distanceM)} from ${prompt.siteName ?? 'the site'}. ` +
            'You can still clock on — your supervisor will just be asked to confirm it.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Clock on anyway',
              onPress: () => {
                void press(
                  eventType,
                  {
                    ...options,
                    jobId: options.jobId ?? jobId,
                    outsideReason: `Worker confirmed off-site clock, ${prompt.distanceM}m away`,
                  },
                  fix,
                );
              },
            },
          ],
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, press, checkGeofence, jobId],
  );

  if (state.loading) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={colors.text} size="large" />
      </View>
    );
  }

  const { home, clockState, availableActions, pending, online, syncing } = state;
  const canClockIn = availableActions.includes('clock_in');
  const canClockOut = availableActions.includes('clock_out');
  const canStartBreak = availableActions.includes('break_start');
  const canEndBreak = availableActions.includes('break_end');

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      refreshControl={
        <RefreshControl
          refreshing={syncing}
          onRefresh={() => {
            void refresh();
            void sync();
          }}
          tintColor={colors.textMuted}
        />
      }
    >
      {state.banner && (
        <Pressable
          onPress={dismissBanner}
          style={[
            styles.banner,
            {
              backgroundColor:
                state.banner.tone === 'error'
                  ? colors.error
                  : state.banner.tone === 'warn'
                    ? colors.warn
                    : colors.surfaceRaised,
            },
          ]}
        >
          <Text style={styles.bannerText}>{state.banner.text}</Text>
          <Text style={styles.bannerDismiss}>Tap to dismiss</Text>
        </Pressable>
      )}

      <ConnectionStrip online={online} pending={pending.length} syncing={syncing} />

      <View style={styles.card}>
        <Text style={styles.label}>TODAY'S JOB</Text>
        {home?.assignedJob ? (
          <>
            <Text style={styles.jobNumber}>Job {home.assignedJob.jobNumber}</Text>
            {home.assignedJob.customerName && (
              <Text style={styles.body}>{home.assignedJob.customerName}</Text>
            )}
            <Text style={styles.muted}>
              {home.assignedJob.siteAddress ?? home.assignedJob.siteName ?? 'No address on file'}
            </Text>
            {home.assignedJob.scheduledStart && (
              <Text style={styles.muted}>
                Start {formatTime(home.assignedJob.scheduledStart)}
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.muted}>
            No job assigned for today. You can still clock on — tell your supervisor.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>STATUS</Text>
        <Text style={[styles.status, { color: statusColour(clockState) }]}>
          {statusLabel(clockState)}
        </Text>
        <Text style={styles.hours}>{home?.hoursWorkedLabel ?? '0h 00m'}</Text>
        <Text style={styles.muted}>
          worked today{home && home.breakMinutes > 0 ? ` · ${home.breakMinutes}m break` : ''}
        </Text>
      </View>

      {canClockIn && (
        <BigButton
          label="CLOCK ON"
          colour={colors.on}
          pressedColour={colors.onPressed}
          disabled={busy}
          onPress={() => void runClockEvent('clock_in')}
        />
      )}

      {canClockOut && (
        <BigButton
          label="CLOCK OFF"
          colour={colors.off}
          pressedColour={colors.offPressed}
          disabled={busy}
          onPress={() =>
            Alert.alert('Knock off?', 'This ends your shift for today.', [
              { text: 'Not yet', style: 'cancel' },
              { text: 'Clock off', onPress: () => void runClockEvent('clock_out') },
            ])
          }
        />
      )}

      <View style={styles.row}>
        {canStartBreak && (
          <SecondaryButton
            label="Start break"
            disabled={busy}
            onPress={() => void runClockEvent('break_start')}
          />
        )}
        {canEndBreak && (
          <SecondaryButton
            label="Finish break"
            disabled={busy}
            onPress={() => void runClockEvent('break_end')}
          />
        )}
      </View>

      {clockState !== 'off' && state.activities.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>WHAT ARE YOU DOING?</Text>
          <View style={styles.chips}>
            {state.activities.map((activity) => {
              const selected = home?.currentActivityId === activity.id;
              return (
                <Pressable
                  key={activity.id}
                  disabled={busy}
                  onPress={() =>
                    void runClockEvent('activity_change', { workActivityId: activity.id })
                  }
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                    {activity.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {pending.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>WAITING TO SEND ({pending.length})</Text>
          {pending.map((item) => (
            <View key={item.idempotencyKey} style={styles.pendingRow}>
              <Text style={styles.body}>
                {labelForEvent(item.eventType)} · {formatTime(item.deviceTime)}
              </Text>
              <Text style={item.status === 'rejected' ? styles.pendingBad : styles.muted}>
                {item.status === 'rejected' ? (item.lastError ?? 'Rejected') : 'Queued'}
              </Text>
            </View>
          ))}
          <Text style={styles.muted}>
            These are saved on your phone and will send themselves when you have signal.
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <View style={styles.autoDetectRow}>
          <View style={styles.autoDetectText}>
            <Text style={styles.label}>AUTO-DETECT ARRIVAL</Text>
            <Text style={styles.muted}>
              Suggest a clock-in/out when your phone notices you've arrived at or left a job
              site — even if SkelClock isn't open. Every suggestion needs your confirmation
              before it counts.
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: state.autoDetectEnabled }}
            onPress={() => void onToggleAutoDetect(!state.autoDetectEnabled)}
            style={[styles.toggle, state.autoDetectEnabled && styles.toggleOn]}
          >
            <View style={[styles.toggleKnob, state.autoDetectEnabled && styles.toggleKnobOn]} />
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>PRIVACY</Text>
        <Text style={styles.muted}>
          Your location is recorded when you clock on and clock off. If you turn on auto-detect
          above, SkelClock also checks your location in the background to suggest a clock event
          near a job site — you can turn it off any time, and it never clocks you on or off by
          itself without you confirming.
        </Text>
      </View>

      <Pressable style={styles.signOut} onPress={() => void signOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

// --- pieces -----------------------------------------------------------------

function ConnectionStrip({
  online,
  pending,
  syncing,
}: {
  online: boolean;
  pending: number;
  syncing: boolean;
}) {
  const text = syncing
    ? 'Sending…'
    : !online
      ? pending > 0
        ? `Offline · ${pending} saved on this phone`
        : 'Offline · your clocks are saved on this phone'
      : pending > 0
        ? `${pending} waiting to send`
        : 'All sent';

  const tone = !online ? colors.warn : pending > 0 ? colors.warn : colors.ok;

  return (
    <View style={styles.strip}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.stripText}>{text}</Text>
      {syncing && <ActivityIndicator size="small" color={colors.textMuted} />}
    </View>
  );
}

function BigButton({
  label,
  colour,
  pressedColour,
  disabled,
  onPress,
}: {
  label: string;
  colour: string;
  pressedColour: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.bigButton,
        { backgroundColor: pressed ? pressedColour : colour, opacity: disabled ? 0.6 : 1 },
      ]}
    >
      <Text style={styles.bigButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        { opacity: disabled ? 0.6 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

// --- formatting -------------------------------------------------------------

const statusLabel = (s: string): string =>
  s === 'working' ? 'ON THE JOB' : s === 'on_break' ? 'ON BREAK' : 'NOT CLOCKED ON';

const statusColour = (s: string): string =>
  s === 'working' ? colors.on : s === 'on_break' ? colors.breakColour : colors.textMuted;

const labelForEvent = (t: string): string =>
  ({
    clock_in: 'Clock on',
    clock_out: 'Clock off',
    break_start: 'Break start',
    break_end: 'Break end',
    job_change: 'Job change',
    activity_change: 'Activity change',
  })[t] ?? t;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${metres}m`;
}

// --- styles -----------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md, gap: spacing.md },

  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  stripText: { ...type.body, color: colors.textMuted, flex: 1 },

  banner: { padding: spacing.md, borderRadius: radius.md, gap: spacing.xs },
  bannerText: { ...type.body, color: '#fff', fontWeight: '600' },
  bannerDismiss: { ...type.label, color: 'rgba(255,255,255,0.75)' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.xs },
  jobNumber: { ...type.title, color: colors.text },
  body: { ...type.body, color: colors.text },
  muted: { ...type.body, color: colors.textMuted },

  status: { ...type.heading, letterSpacing: 1 },
  hours: { ...type.display, color: colors.text },

  bigButton: {
    minHeight: 140,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigButtonText: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: 2 },

  row: { flexDirection: 'row', gap: spacing.sm },
  secondaryButton: {
    flex: 1,
    minHeight: MIN_TAP + 12,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { ...type.heading, color: colors.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: MIN_TAP,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: { backgroundColor: colors.on, borderColor: colors.on },
  chipText: { ...type.body, color: colors.text },
  chipTextSelected: { color: '#fff', fontWeight: '700' },

  pendingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  pendingBad: { ...type.body, color: colors.error },

  signOut: { minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center' },
  signOutText: { ...type.body, color: colors.textMuted },

  autoDetectRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  autoDetectText: { flex: 1, gap: spacing.xs },
  toggle: {
    width: 56,
    height: MIN_TAP * 0.6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    padding: 3,
  },
  toggleOn: { backgroundColor: colors.on, borderColor: colors.on },
  toggleKnob: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
    alignSelf: 'flex-start',
  },
  toggleKnobOn: { alignSelf: 'flex-end' },
});
