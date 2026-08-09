/**
 * The clock screen, drawn as a sheet.
 *
 * Everything a worker needs before 6am, in one view and without scrolling on a
 * normal handset: which job, where it is, whether they are on, how long they
 * have been on, whether anything is waiting to sync, and one very large button.
 *
 * SETOUT, on paper. There is not a rounded corner on this screen. Structure is
 * carried by rules and bands the way a drawing carries it, hierarchy by the
 * five ink steps rather than by five type sizes, and there is exactly one
 * numeral set at figure size — the hours, which is the number the whole app
 * exists to get right.
 *
 * The CAD legend keeps its meanings, so colour is never decoration:
 *   green   boards down     → clocked on, and everything sent
 *   yellow  still in hand   → on a break, queued, awaiting a confirmation
 *   magenta crossed a line  → off-site, rejected, refused
 *
 * Magenta is deliberately not used for the Knock Off button. Knocking off is
 * not an exception, and spending the exception colour on the most-pressed
 * control on the screen would leave nothing left to say when something has
 * genuinely crossed a line.
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
import { useRouter } from 'expo-router';

import type { AttendanceEventType } from '@skelclock/core';

import type { PendingSuggestionDto } from '../src/api';
import { useClock, type PressOptions } from '../src/useClock';
import { SitePlan } from '../src/site-plan';
import { SiteMap } from '../src/site-map';
import { describeProblem } from '../src/location';
import { getSession, signOut } from '../src/auth';
import { colors, r, type as t, MIN_TAP } from '../src/theme';

export default function ClockScreen() {
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  useEffect(() => {
    // The app_user row carries the employee link, and the server is what
    // resolves it — the client does not get to name whose shift this is.
    void getSession().then((session) => setEmployeeId(session?.employeeId ?? null));
  }, []);

  const {
    state,
    press,
    refresh,
    sync,
    checkGeofence,
    dismissBanner,
    confirmSuggestion,
    dismissSuggestion,
  } = useClock(employeeId);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
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

      // Two (or more) sites matched at once - the phone genuinely does not
      // know which one, so the worker picks rather than the app guessing.
      if (suggestion.candidateJobIds && suggestion.candidateJobIds.length > 1) {
        const candidates = suggestion.candidateJobIds.map(
          (id) => state.jobs.find((j) => j.id === id) ?? { id, siteName: null, jobNumber: id },
        );
        Alert.alert(
          'Which site?',
          `You ${suggestion.eventType === 'clock_in' ? 'arrived near' : 'left near'} ${
            candidates.length
          } job sites at once at ${formatTime(suggestion.deviceTime)}. Which one were you ${action.replace('ing', 'ing at')}?`,
          [
            ...candidates.map((c) => ({
              text: c.siteName ?? `Job ${c.jobNumber}`,
              onPress: () => void confirmSuggestion(suggestion.id, c.id),
            })),
            {
              text: "Neither — wasn't me",
              style: 'destructive' as const,
              onPress: () => void dismissSuggestion(suggestion.id, 'Worker said this was not them'),
            },
          ],
        );
        return;
      }

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
    [confirmSuggestion, dismissSuggestion, state.jobs],
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

        const check = await checkGeofence(options.jobId ?? jobId);
        const away = formatDistance(check.distanceM ?? 0);
        const where = check.siteName ?? 'the site';

        if (check.blocked) {
          // Clocking ON is refused off-site. Clocking OFF never is: a worker
          // who has already left must always be able to end their shift, or
          // the fence traps them on the clock and the hours run all night.
          if (eventType === 'clock_in') {
            Alert.alert(
              'You are outside the site',
              `You are about ${away} from ${where}, and you have to be on site to clock on.\n\n` +
                'If you are on site and this is wrong, tell your supervisor — the site boundary ' +
                'may need moving.',
            );
            return;
          }

          Alert.alert(
            'You are away from the site',
            `You are about ${away} from ${where}. You can still knock off — your supervisor ` +
              'will just be asked to confirm it.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Knock off anyway',
                onPress: () => {
                  void press(
                    eventType,
                    {
                      ...options,
                      jobId: options.jobId ?? jobId,
                      outsideReason: `Worker confirmed off-site clock, ${Math.round(check.distanceM ?? 0)}m away`,
                    },
                    check.fix,
                  );
                },
              },
            ],
          );
          return;
        }

        const result = await press(
          eventType,
          { ...options, jobId: options.jobId ?? jobId },
          check.fix,
        );
        if (!result.ok) Alert.alert('Cannot do that yet', result.message);
      } finally {
        setBusy(false);
      }
    },
    [busy, press, checkGeofence, jobId],
  );

  /**
   * One fix, because the worker asked for one. checkGeofence takes it and
   * records it; the prompt it returns is ignored here on purpose — asking
   * "where am I" is not an attempt to clock on, and should not be answered
   * with a dialog about clocking on.
   */
  const locate = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { fix } = await checkGeofence(jobId);
      // A fix that did not arrive has to say so. Silence here reads as a dead
      // button, and the worker is left guessing whether the plan is stale or
      // the phone simply never looked.
      if (fix.latitude == null || fix.longitude == null) {
        Alert.alert(
          'No position',
          describeProblem(fix.problem) ??
            'Could not get a position just now. Try again in the open.',
        );
      }
    } finally {
      setLocating(false);
    }
  }, [locating, checkGeofence, jobId]);

  if (state.loading) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={colors.ink} size="large" />
      </View>
    );
  }

  const { home, clockState, availableActions, online, syncing } = state;
  const canClockIn = availableActions.includes('clock_in');
  const canClockOut = availableActions.includes('clock_out');
  const canStartBreak = availableActions.includes('break_start');
  const canEndBreak = availableActions.includes('break_end');

  return (
    <View style={styles.screen}>
      {/* Title block. Who the sheet belongs to, and for which day. */}
      <View style={[styles.titleBlock, { paddingTop: insets.top + r.r4 }]}>
        <Text style={styles.wordmark}>SKELCLOCK</Text>
        <View style={styles.titleRight}>
          <Text style={styles.titleName}>{home?.employeeName ?? '—'}</Text>
          <Text style={styles.lbl}>{formatSheetDate(home?.workDate)}</Text>
        </View>
      </View>

      <ScrollView
        style={styles.sheet}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + r.lift }]}
        refreshControl={
          <RefreshControl
            refreshing={syncing}
            onRefresh={() => {
              void refresh();
              void sync();
            }}
            tintColor={colors.inkFaint}
          />
        }
      >
        {state.banner && (
          <Pressable onPress={dismissBanner} style={[styles.notice, noticeTone(state.banner.tone)]}>
            <Text style={[styles.lbl, { color: noticeInk(state.banner.tone) }]}>
              {state.banner.tone === 'error' ? 'Refused' : 'Notice'}
            </Text>
            <Text style={styles.lead}>{state.banner.text}</Text>
            <Text style={styles.dat}>Tap to dismiss</Text>
          </Pressable>
        )}

        {/*
          The map leads the sheet. Customer and address ride on it rather than
          under it, so the first thing on screen answers "which site, and am I
          on it" in one look.
        */}
        {home?.assignedJob && (
          <View style={styles.mapBlock}>
            {(() => {
              const site =
                home.assignedJob.latitude != null && home.assignedJob.longitude != null
                  ? {
                      latitude: home.assignedJob.latitude,
                      longitude: home.assignedJob.longitude,
                    }
                  : null;
              const fix =
                state.lastFix?.latitude != null && state.lastFix.longitude != null
                  ? {
                      latitude: state.lastFix.latitude,
                      longitude: state.lastFix.longitude,
                      accuracyM: state.lastFix.accuracyM,
                    }
                  : null;

              // Tiles need the network. With no reception the map is a grey
              // rectangle, which is worse than useless on the one screen a
              // worker needs when they are somewhere without signal — so the
              // drawn plan takes over, and it needs nothing but the numbers
              // the app already has.
              return online && site ? (
                <SiteMap
                  siteName={home.assignedJob.siteName}
                  customerName={home.assignedJob.customerName}
                  siteAddress={home.assignedJob.siteAddress}
                  site={site}
                  radiusM={home.assignedJob.geofenceRadiusM}
                  fix={fix}
                  live={clockState !== 'off'}
                />
              ) : (
                <View style={styles.planInset}>
                  <SitePlan
                    siteName={home.assignedJob.siteName}
                    customerName={home.assignedJob.customerName}
                    siteAddress={home.assignedJob.siteAddress}
                    site={site}
                    radiusM={home.assignedJob.geofenceRadiusM}
                    fix={fix}
                    fixAt={state.lastFixAt}
                  />
                </View>
              );
            })()}
          </View>
        )}

        {/* What the plate does not carry: the job number and the start time. */}
        <View style={styles.block}>
          {home?.assignedJob ? (
            <>
              <Datum label="Job" value={home.assignedJob.jobNumber} strong />
              {home.assignedJob.scheduledStart && (
                <Datum label="Start" value={formatTime(home.assignedJob.scheduledStart)} />
              )}
            </>
          ) : (
            <View style={styles.emptyJob}>
              <Text style={styles.lbl}>No job assigned</Text>
              <Text style={styles.lead}>
                You can still clock on — tell your supervisor.
              </Text>
            </View>
          )}
        </View>

        {/* The one figure on the sheet. */}
        <View style={styles.figureBlock}>
          <View style={styles.figureHead}>
            <Text style={styles.lbl}>Hours today</Text>
            <Text style={[styles.statusMark, { color: statusInk(clockState) }]}>
              {statusLabel(clockState)}
            </Text>
          </View>
          <Text style={styles.figure}>{formatFigure(home?.hoursWorkedLabel)}</Text>
          {/*
            Anything already taken out of the figure above is named here. A
            worker who is short half an hour and cannot see why has no way to
            tell a deduction from a bug, and the auto-deducted lunch is the one
            nobody pressed a button for.
          */}
          {home && (home.breakMinutes > 0 || home.autoLunchMinutes > 0) && (
            <Text style={styles.dat}>
              {[
                home.breakMinutes > 0 ? `${home.breakMinutes} min unpaid break` : null,
                home.autoLunchMinutes > 0
                  ? `${home.autoLunchMinutes} min lunch deducted automatically`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          )}
        </View>

        {/* Only a supervisor's phone grows a second screen. The crew routes
            re-check the role server-side; this is wayfinding, not security. */}
        {home && home.role !== 'worker' && (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/crew')}
            style={({ pressed }) => [styles.crewLink, pressed && styles.crewLinkPressed]}
          >
            <Text style={styles.crewLinkText}>MY CREW — clock the whole crew on or off →</Text>
          </Pressable>
        )}

        {canClockIn && (
          <ClockBand
            label="Clock on"
            ground={colors.green}
            disabled={busy}
            onPress={() => void runClockEvent('clock_in')}
          />
        )}

        {canClockOut && (
          <ClockBand
            label="Knock off"
            ground={colors.ink}
            disabled={busy}
            onPress={() =>
              Alert.alert('Knock off?', 'This ends your shift for today.', [
                { text: 'Not yet', style: 'cancel' },
                { text: 'Clock off', onPress: () => void runClockEvent('clock_out') },
              ])
            }
          />
        )}

        {(canStartBreak || canEndBreak) && (
          <View style={styles.row}>
            {canStartBreak && (
              <Secondary
                label="Start break"
                disabled={busy}
                onPress={() => void runClockEvent('break_start')}
              />
            )}
            {canEndBreak && (
              <Secondary
                label="Finish break"
                disabled={busy}
                onPress={() => void runClockEvent('break_end')}
              />
            )}
          </View>
        )}

        {home?.assignedJob && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: locating }}
            disabled={locating}
            onPress={() => void locate()}
            style={({ pressed }) => [
              styles.ghost,
              { opacity: locating ? 0.45 : 1 },
              pressed && styles.ghostPressed,
            ]}
          >
            {locating ? (
              <ActivityIndicator size="small" color={colors.ink} />
            ) : (
              <Text style={styles.ghostText}>
                {state.lastFix ? 'Check again' : 'Check my position'}
              </Text>
            )}
          </Pressable>
        )}

        <Pressable style={styles.signOut} onPress={() => void signOut()}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// --- pieces -----------------------------------------------------------------

/**
 * One ruled line of the title block.
 *
 * Short fields sit inline, label left and value right, which is what makes a
 * column of times and job numbers scannable. Anything that runs to a second
 * line is stacked under its label instead: right-aligned wrapping strands the
 * last word on its own ("Pty / Ltd"), and a title block does not do that.
 */
function Datum({
  label,
  value,
  strong,
  stacked,
}: {
  label: string;
  value: string;
  strong?: boolean;
  stacked?: boolean;
}) {
  return (
    <View style={[styles.datum, stacked && styles.datumStacked]}>
      <Text style={styles.lbl}>{label}</Text>
      <Text
        style={[
          styles.datumValue,
          stacked && styles.datumValueStacked,
          strong && styles.datumStrong,
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

/** The one very large button. Three rosettes tall. */
function ClockBand({
  label,
  ground,
  disabled,
  onPress,
}: {
  label: string;
  ground: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.band,
        { backgroundColor: ground, opacity: disabled ? 0.45 : pressed ? 0.86 : 1 },
      ]}
    >
      <Text style={styles.bandText}>{label}</Text>
    </Pressable>
  );
}

function Secondary({
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
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondary,
        { opacity: disabled ? 0.45 : 1 },
        pressed && styles.secondaryPressed,
      ]}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

// --- formatting -------------------------------------------------------------

const statusLabel = (s: string): string =>
  s === 'working' ? 'On the job' : s === 'on_break' ? 'On break' : 'Not clocked on';

const statusInk = (s: string): string =>
  s === 'working' ? colors.green : s === 'on_break' ? colors.yellow : colors.inkFaint;

const noticeTone = (tone: string) =>
  tone === 'error' ? styles.noticeBad : tone === 'warn' ? styles.noticeWarn : styles.noticeFlat;

const noticeInk = (tone: string): string =>
  tone === 'error' ? colors.magenta : tone === 'warn' ? colors.yellow : colors.inkFaint;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${metres}m`;
}

/**
 * "3h 17m" arrives from the server; the sheet wants "3:17". A drawing writes a
 * duration as a figure, not as a sentence with units in it.
 */
function formatFigure(label: string | undefined): string {
  if (!label) return '0:00';
  const match = /(\d+)h\s*(\d+)m/.exec(label);
  if (!match) return label;
  return `${match[1]}:${match[2]!.padStart(2, '0')}`;
}

function formatSheetDate(workDate: string | undefined): string {
  const d = workDate ? new Date(`${workDate}T00:00:00`) : new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// --- styles -----------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  centre: { alignItems: 'center', justifyContent: 'center' },
  sheet: { flex: 1 },
  content: { paddingHorizontal: r.r2, gap: r.r2, paddingTop: r.r2 },

  /* ── title block ─────────────────────────────────────────────────────── */
  titleBlock: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: r.r2,
    paddingBottom: r.r4,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    backgroundColor: colors.paper,
  },
  wordmark: { ...t.dim, color: colors.brand },
  titleRight: { alignItems: 'flex-end', gap: 2 },
  titleName: { ...t.dat, color: colors.ink },

  /* ── shared ink ──────────────────────────────────────────────────────── */
  lbl: { ...t.lbl, color: colors.inkFaint },
  lead: { ...t.lead, color: colors.ink700 },
  dat: { ...t.dat, color: colors.inkFaint },

  /* ── datum lines ─────────────────────────────────────────────────────── */
  block: { borderBottomWidth: 1, borderBottomColor: colors.line },
  datum: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: r.r2,
    paddingVertical: r.r4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  datumStacked: { flexDirection: 'column', alignItems: 'stretch', gap: r.r8 },
  datumValue: { ...t.dat, fontSize: 15, color: colors.ink, flexShrink: 1, textAlign: 'right' },
  datumValueStacked: { textAlign: 'left' },
  datumStrong: { ...t.dim, fontSize: 22, color: colors.ink },
  emptyJob: { paddingVertical: r.r4, gap: r.r8, borderTopWidth: 1, borderTopColor: colors.line },

  /* ── the figure ──────────────────────────────────────────────────────── */
  figureBlock: { paddingTop: r.r4, gap: r.r8 },
  figureHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  statusMark: { ...t.lbl },
  figure: { ...t.fig, color: colors.ink },

  /* ── the band ────────────────────────────────────────────────────────── */
  band: { height: r.r3, alignItems: 'center', justifyContent: 'center' },
  bandText: { ...t.act, fontSize: 24, letterSpacing: 3, color: colors.paper },

  row: { flexDirection: 'row', gap: r.r4 },
  secondary: {
    flex: 1,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.yellow,
  },
  secondaryPressed: { backgroundColor: colors.fillYellow },
  secondaryText: { ...t.act, fontSize: 15, color: colors.yellow },

  /* ── site plan ───────────────────────────────────────────────────────── */
  // Cancels the sheet's own margin so the map runs edge to edge. The content
  // container pads every child by half a rosette; the map is the one thing
  // that should not be inset.
  mapBlock: { marginHorizontal: -r.r2 },
  planInset: { paddingHorizontal: r.r2 },
  ghost: {
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.ink,
  },
  ghostPressed: { backgroundColor: colors.paper200 },
  ghostText: { ...t.act, fontSize: 15, color: colors.ink },

  /* ── the crew link — a supervisor's second screen ───────────────────── */
  crewLink: {
    minHeight: MIN_TAP,
    justifyContent: 'center',
    paddingHorizontal: r.r4,
    borderWidth: 1,
    borderColor: colors.ink,
  },
  crewLinkPressed: { backgroundColor: colors.paper200 },
  crewLinkText: { ...t.act, fontSize: 15, color: colors.ink },

  /* ── banded notices ──────────────────────────────────────────────────── */
  notice: { padding: r.r4, gap: r.r8, borderLeftWidth: r.r8 },
  noticeBad: { backgroundColor: colors.fillMagenta, borderLeftColor: colors.magenta },
  noticeWarn: { backgroundColor: colors.fillYellow, borderLeftColor: colors.yellow },
  noticeFlat: { backgroundColor: colors.paper200, borderLeftColor: colors.steel },

  signOut: {
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  signOutText: { ...t.dat, color: colors.inkFaint, textDecorationLine: 'underline' },
});
