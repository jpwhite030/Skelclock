/**
 * The supervisor's crew sheet.
 *
 * One tap clocks the whole crew on or off; unticking a member means "not
 * here today" and leaves them alone. Every member still gets their own
 * event, their own idempotency key and their own state-machine check — so
 * "Dean is already clocked in" shows up as Dean's line item, not a failure
 * of the whole tap. Reached only when /api/home says the caller is a
 * supervisor or admin; the crew routes re-check regardless.
 */

import { useCallback, useEffect, useState } from 'react';
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

import { ApiClient, type CrewDto, type JobOption } from '../src/api';
import { captureFix } from '../src/location';
import { deviceId } from '../src/device';
import { accessToken } from '../src/supabase';
import { colors, radius, spacing, type, MIN_TAP } from '../src/theme';

const api = new ApiClient(accessToken);

interface MemberOutcome {
  employeeName: string;
  status: 'created' | 'duplicate' | 'rejected';
  message: string | null;
}

export default function CrewScreen() {
  const [crews, setCrews] = useState<CrewDto[] | null>(null);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [crewId, setCrewId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [outcomes, setOutcomes] = useState<MemberOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [crewList, jobList] = await Promise.all([api.crews(), api.jobs()]);
      setCrews(crewList);
      setJobs(jobList);
      setCrewId((current) => current ?? crewList[0]?.id ?? null);
      setJobId((current) => current ?? jobList[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your crews.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const crew = crews?.find((c) => c.id === crewId) ?? null;

  const toggleMember = (employeeId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const run = async (eventType: 'clock_in' | 'clock_out') => {
    if (!crew || busy) return;
    setBusy(true);
    setOutcomes(null);
    try {
      // The supervisor's position stands in for the crew's — one fix, not six.
      const fix = await captureFix();
      const result = await api.clockCrew({
        crewId: crew.id,
        eventType,
        jobId: eventType === 'clock_in' ? jobId : null,
        excludeEmployeeIds: [...excluded],
        deviceTime: new Date().toISOString(),
        latitude: fix.latitude,
        longitude: fix.longitude,
        gpsAccuracyM: fix.accuracyM,
        deviceId: await deviceId(),
      });
      setOutcomes(
        result.outcomes.map((o) => ({
          employeeName: o.employeeName,
          status: o.status,
          message: o.message,
        })),
      );
      await load();
    } catch (e) {
      Alert.alert(
        "That didn't go through",
        e instanceof Error ? e.message : 'Check your signal and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={colors.text} size="large" />
      </View>
    );
  }

  const included = crew ? crew.members.filter((m) => !excluded.has(m.employeeId)) : [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.textMuted} />
      }
    >
      {error && <Text style={styles.error}>{error}</Text>}

      {crews && crews.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.muted}>
            No crews are set up with you as supervisor. Ask the office to assign one.
          </Text>
        </View>
      )}

      {crews && crews.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.label}>CREW</Text>
          <View style={styles.chips}>
            {crews.map((c) => (
              <Chip
                key={c.id}
                label={c.name}
                selected={c.id === crewId}
                onPress={() => {
                  setCrewId(c.id);
                  setExcluded(new Set());
                  setOutcomes(null);
                }}
              />
            ))}
          </View>
        </View>
      )}

      {crew && (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>
              {crew.name.toUpperCase()} — {included.length} OF {crew.members.length} IN
            </Text>
            <Text style={styles.muted}>Untick anyone who isn&apos;t here today.</Text>
            {crew.members.map((m) => {
              const out = excluded.has(m.employeeId);
              return (
                <Pressable
                  key={m.employeeId}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: !out }}
                  style={styles.memberRow}
                  onPress={() => toggleMember(m.employeeId)}
                >
                  <View style={[styles.tick, !out && styles.tickOn]}>
                    {!out && <Text style={styles.tickMark}>✓</Text>}
                  </View>
                  <View style={styles.memberText}>
                    <Text style={[styles.body, out && styles.bodyOut]}>{m.fullName}</Text>
                    <Text style={styles.muted}>
                      {m.clockState === 'off'
                        ? 'Not clocked on'
                        : m.clockState === 'on_break'
                          ? `On break · ${m.hoursWorkedLabel ?? ''}`
                          : `On · ${m.hoursWorkedLabel ?? ''}`}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>JOB FOR CLOCK-ON</Text>
            {jobs.length === 0 && (
              <Text style={styles.muted}>No jobs available — clock-on will record no job.</Text>
            )}
            <View style={styles.chips}>
              {jobs.map((j) => (
                <Chip
                  key={j.id}
                  label={`Job ${j.jobNumber}`}
                  selected={j.id === jobId}
                  onPress={() => setJobId(j.id)}
                />
              ))}
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={busy || included.length === 0}
            onPress={() =>
              Alert.alert(
                `Clock ${included.length} on?`,
                `Starts a shift for everyone ticked${jobId ? '' : ' — with no job selected'}.`,
                [
                  { text: 'Not yet', style: 'cancel' },
                  { text: 'Clock crew on', onPress: () => void run('clock_in') },
                ],
              )
            }
            style={({ pressed }) => [
              styles.bigButton,
              {
                backgroundColor: pressed ? colors.onPressed : colors.on,
                opacity: busy || included.length === 0 ? 0.6 : 1,
              },
            ]}
          >
            <Text style={styles.bigButtonText}>
              {busy ? 'WORKING…' : `CLOCK ${included.length} ON`}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busy || included.length === 0}
            onPress={() =>
              Alert.alert(`Clock ${included.length} off?`, 'Ends the shift for everyone ticked.', [
                { text: 'Not yet', style: 'cancel' },
                { text: 'Clock crew off', onPress: () => void run('clock_out') },
              ])
            }
            style={({ pressed }) => [
              styles.bigButton,
              {
                backgroundColor: pressed ? colors.offPressed : colors.off,
                opacity: busy || included.length === 0 ? 0.6 : 1,
              },
            ]}
          >
            <Text style={styles.bigButtonText}>
              {busy ? 'WORKING…' : `CLOCK ${included.length} OFF`}
            </Text>
          </Pressable>

          {outcomes && (
            <View style={styles.card}>
              <Text style={styles.label}>RESULT</Text>
              {outcomes.map((o) => (
                <View key={o.employeeName} style={styles.outcomeRow}>
                  <Text style={styles.body}>{o.employeeName}</Text>
                  <Text
                    style={[
                      styles.muted,
                      o.status === 'rejected' && { color: colors.error },
                      o.status === 'created' && { color: colors.ok },
                    ]}
                  >
                    {o.status === 'created' ? 'Done' : o.status === 'duplicate' ? 'Already done' : (o.message ?? 'Refused')}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.md, gap: spacing.md },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  label: { ...type.label, color: colors.textMuted },
  body: { ...type.body, color: colors.text },
  bodyOut: { color: colors.textMuted, textDecorationLine: 'line-through' },
  muted: { ...type.body, color: colors.textMuted },
  error: { ...type.body, color: colors.error },

  memberRow: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  memberText: { flex: 1, gap: 2 },
  tick: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { borderColor: colors.on, backgroundColor: colors.on },
  tickMark: { color: '#fff', fontWeight: '700' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: MIN_TAP - 16,
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

  bigButton: {
    minHeight: 88,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigButtonText: { fontSize: 24, fontWeight: '800', color: '#fff', letterSpacing: 1.5 },

  outcomeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
});
