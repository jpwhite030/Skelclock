/**
 * The supervisor's crew sheet, drawn in the same paper hand as the clock
 * screen — square corners, ink rules, the CAD legend (green = on and sent,
 * yellow = in hand, magenta = crossed a line).
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
import { accessToken } from '../src/auth';
import { colors, r, type as t, MIN_TAP } from '../src/theme';

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
        <ActivityIndicator color={colors.ink} size="large" />
      </View>
    );
  }

  const included = crew ? crew.members.filter((m) => !excluded.has(m.employeeId)) : [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.inkFaint} />
      }
    >
      {error && <Text style={styles.error}>{error}</Text>}

      {crews && crews.length === 0 && (
        <View style={styles.block}>
          <Text style={styles.lead}>
            No crews are set up with you as supervisor. Ask the office to assign one.
          </Text>
        </View>
      )}

      {crews && crews.length > 1 && (
        <Section label="Crew">
          <View style={styles.cells}>
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
        </Section>
      )}

      {crew && (
        <>
          <Section label={`${crew.name} — ${included.length} of ${crew.members.length} in`}>
            <Text style={styles.dat}>Untick anyone who isn&apos;t here today.</Text>
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
                    <Text style={[styles.memberName, out && styles.memberNameOut]}>
                      {m.fullName}
                    </Text>
                    <Text style={[styles.dat, { color: memberStateInk(m.clockState) }]}>
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
          </Section>

          <Section label="Job for clock-on">
            {jobs.length === 0 ? (
              <Text style={styles.dat}>No jobs available — clock-on will record no job.</Text>
            ) : (
              <View style={styles.cells}>
                {jobs.map((j) => (
                  <Chip
                    key={j.id}
                    label={`Job ${j.jobNumber}`}
                    selected={j.id === jobId}
                    onPress={() => setJobId(j.id)}
                  />
                ))}
              </View>
            )}
          </Section>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || included.length === 0 }}
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
              styles.band,
              { backgroundColor: colors.green, opacity: busy || included.length === 0 ? 0.45 : pressed ? 0.86 : 1 },
            ]}
          >
            <Text style={styles.bandText}>{busy ? 'WORKING' : `CLOCK ${included.length} ON`}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || included.length === 0 }}
            disabled={busy || included.length === 0}
            onPress={() =>
              Alert.alert(`Clock ${included.length} off?`, 'Ends the shift for everyone ticked.', [
                { text: 'Not yet', style: 'cancel' },
                { text: 'Clock crew off', onPress: () => void run('clock_out') },
              ])
            }
            style={({ pressed }) => [
              styles.band,
              { backgroundColor: colors.ink, opacity: busy || included.length === 0 ? 0.45 : pressed ? 0.86 : 1 },
            ]}
          >
            <Text style={styles.bandText}>{busy ? 'WORKING' : `CLOCK ${included.length} OFF`}</Text>
          </Pressable>

          {outcomes && (
            <Section label="Result">
              {outcomes.map((o) => (
                <View key={o.employeeName} style={styles.outcomeRow}>
                  <Text style={styles.dat}>{o.employeeName}</Text>
                  <Text
                    style={[
                      styles.dat,
                      o.status === 'rejected' && { color: colors.magenta },
                      o.status === 'created' && { color: colors.green },
                    ]}
                  >
                    {o.status === 'created' ? 'Done' : o.status === 'duplicate' ? 'Already done' : (o.message ?? 'Refused')}
                  </Text>
                </View>
              ))}
            </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.lbl}>{label}</Text>
      {children}
    </View>
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
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const memberStateInk = (state: string): string =>
  state === 'working' ? colors.green : state === 'on_break' ? colors.yellow : colors.inkFaint;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  centre: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: r.r2, paddingVertical: r.r2, gap: r.r2 },

  error: { ...t.dat, color: colors.magenta },

  block: { paddingVertical: r.r4, gap: r.r8 },
  lead: { ...t.lead, color: colors.ink700 },
  lbl: { ...t.lbl, color: colors.inkFaint, marginBottom: r.r8 },
  dat: { ...t.dat, color: colors.inkFaint },

  section: { gap: r.r8, paddingTop: r.r4, borderTopWidth: 1, borderTopColor: colors.line },

  memberRow: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: r.r4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  memberText: { flex: 1, gap: 2 },
  memberName: { ...t.dat, fontSize: 15, color: colors.ink },
  memberNameOut: { color: colors.inkFaint, textDecorationLine: 'line-through' },
  tick: {
    width: 24,
    height: 24,
    borderWidth: 1,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: colors.green, borderColor: colors.green },
  tickMark: { color: colors.paper, fontWeight: '700' },

  cells: { flexDirection: 'row', flexWrap: 'wrap', gap: r.r8 },
  chip: {
    minHeight: MIN_TAP - 12,
    justifyContent: 'center',
    paddingHorizontal: r.r4,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipOn: { borderColor: colors.yellow, backgroundColor: colors.fillYellow },
  chipText: { ...t.dat, color: colors.ink700 },
  chipTextOn: { color: colors.yellow },

  band: { height: r.r3 * 0.66, alignItems: 'center', justifyContent: 'center' },
  bandText: { ...t.act, fontSize: 22, letterSpacing: 2.5, color: colors.paper },

  outcomeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: r.r8,
    gap: r.r4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
