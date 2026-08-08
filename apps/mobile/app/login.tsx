/**
 * Sign in.
 *
 * Two paths, and which one shows depends on how the build is configured:
 *
 *   Demo    Tap your name. No number to type, no code to wait for. There was
 *           never an SMS behind either of those in a demo build — the code
 *           screen was theatre — and asking a scaffolder to key in a phone
 *           number to open a test build is an obstacle that buys nothing.
 *
 *   Real    Mobile number, then a one-time code. Nothing to choose, nothing to
 *           remember, no password to reset on a Monday morning. Kept intact
 *           and untouched: on a build with a real Supabase project, identity
 *           has to be something a worker proves, not something they pick off a
 *           list.
 *
 * The layout is the title block off a drawing sheet — a ruled frame, a rule
 * under every field, and the sheet's own name in the corner. Nothing here is a
 * rounded card, because a drawing does not have any.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  sendOtp,
  verifyOtp,
  signInAsDemoWorker,
  toE164,
  IS_DEMO,
  DEMO_NUMBERS,
} from '../src/auth';
import { colors, r, type as t, MIN_TAP } from '../src/theme';

export default function LoginScreen() {
  const [phase, setPhase] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const pickWorker = async (mobile: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setPending(mobile);
    setError(null);
    try {
      await signInAsDemoWorker(mobile);
      // The root layout notices the session and routes onward.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const requestCode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await sendOtp(phone);
      setPhase('code');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not send the code. Check the number and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(phone, code);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'That code did not work. Check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.inner,
          { paddingTop: insets.top + r.r2, paddingBottom: insets.bottom + r.r2 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title block. The sheet knows what it is and who drew it. */}
        <View style={styles.titleBlock}>
          <Text style={styles.wordmark}>SKELCLOCK</Text>
          <View style={styles.ruleHeavy} />
          <View style={styles.titleRow}>
            <Text style={styles.lbl}>SkelScaff</Text>
            <Text style={styles.lbl}>Site attendance</Text>
          </View>
        </View>

        {IS_DEMO ? (
          <>
            <Text style={styles.lbl}>Who are you</Text>

            <View style={styles.schedule}>
              {DEMO_NUMBERS.map((worker, i) => (
                <Pressable
                  key={worker.mobile}
                  accessibilityRole="button"
                  accessibilityLabel={`Sign in as ${worker.name}`}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={() => void pickWorker(worker.mobile)}
                  style={({ pressed }) => [
                    styles.scheduleRow,
                    // The counting rule off the drawing: every 5th line reads
                    // heavier, so a long list can be counted without landing
                    // on the wrong one.
                    (i + 1) % 5 === 0 && styles.scheduleRule5,
                    pressed && styles.rowPressed,
                    busy && pending !== worker.mobile && styles.rowDimmed,
                  ]}
                >
                  <Text style={styles.rowName}>{worker.name}</Text>
                  {pending === worker.mobile ? (
                    <ActivityIndicator size="small" color={colors.ink} />
                  ) : (
                    <Text style={styles.rowMark}>›</Text>
                  )}
                </Pressable>
              ))}
            </View>

            <View style={styles.hazard}>
              <Text style={[styles.lbl, styles.hazardTitle]}>Demo build</Text>
              <Text style={styles.lead}>
                This build has no Supabase project behind it, so anyone can sign in as
                anyone. It is for trying the app out, not for recording real hours.
              </Text>
            </View>
          </>
        ) : phase === 'phone' ? (
          <>
            <Field label="Your mobile number">
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="0412 345 678"
                placeholderTextColor={colors.inkFaint}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                autoFocus
                editable={!busy}
              />
            </Field>

            {phone.replace(/\D/g, '').length >= 9 && (
              <Text style={styles.dat}>Code goes to {toE164(phone)}</Text>
            )}

            <Action
              label="Send me a code"
              busy={busy}
              disabled={phone.replace(/\D/g, '').length < 9}
              onPress={() => void requestCode()}
            />
          </>
        ) : (
          <>
            <Field label="Enter the 6 digit code">
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={setCode}
                placeholder="000000"
                placeholderTextColor={colors.inkFaint}
                keyboardType="number-pad"
                autoComplete="sms-otp"
                textContentType="oneTimeCode"
                maxLength={6}
                autoFocus
                editable={!busy}
              />
            </Field>

            <Action
              label="Sign in"
              busy={busy}
              disabled={code.length < 6}
              onPress={() => void submitCode()}
            />

            <Pressable
              style={styles.link}
              onPress={() => {
                setPhase('phone');
                setCode('');
                setError(null);
              }}
            >
              <Text style={styles.linkText}>Use a different number</Text>
            </Pressable>
          </>
        )}

        {error && (
          <View style={styles.error}>
            <Text style={[styles.lbl, styles.errorTitle]}>Not signed in</Text>
            <Text style={styles.lead}>{error}</Text>
          </View>
        )}

        {!IS_DEMO && (
          <Text style={styles.footnote}>
            Your number has to match the one in the office system. If it does not, ask
            your supervisor to check it against Odoo.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A ruled field: label above, rule below. The drawing's own form. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.lbl}>{label}</Text>
      {children}
      <View style={styles.rule} />
    </View>
  );
}

function Action({
  label,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || disabled }}
      disabled={busy || disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.actionOff,
        pressed && styles.actionPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.paper} />
      ) : (
        <Text style={[styles.actionText, disabled && styles.actionTextOff]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: r.r2,
    gap: r.r2,
  },

  /* ── title block ─────────────────────────────────────────────────────── */
  titleBlock: { gap: r.r8 },
  wordmark: { ...t.fig, fontSize: 52, lineHeight: 54, color: colors.ink },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between' },
  ruleHeavy: { height: 2, backgroundColor: colors.ink, marginVertical: r.r8 },
  rule: { height: 1, backgroundColor: colors.line },

  lbl: { ...t.lbl, color: colors.inkFaint },
  lead: { ...t.lead, color: colors.ink700 },
  dat: { ...t.dat, color: colors.inkFaint },

  /* ── fields ──────────────────────────────────────────────────────────── */
  field: { gap: r.r8 },
  // Mono, not the display face: a phone number and a one-time code are data,
  // and data is mono. It also stops the digits shuffling sideways as they are
  // typed, which a proportional face does and which reads as a glitch when you
  // are checking a number against the one on your own handset.
  input: {
    minHeight: MIN_TAP,
    ...t.dat,
    fontSize: 24,
    lineHeight: 30,
    color: colors.ink,
    paddingVertical: r.r8,
  },
  codeInput: { letterSpacing: 14, textAlign: 'center' },

  /* ── the one action ──────────────────────────────────────────────────── */
  action: {
    minHeight: MIN_TAP,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPressed: { backgroundColor: colors.ink700 },
  actionOff: { backgroundColor: colors.paper200 },
  actionText: { ...t.act, color: colors.paper },
  actionTextOff: { color: colors.inkFaint },

  /* ── the crew, drawn as a schedule ───────────────────────────────────── */
  schedule: { borderTopWidth: 1, borderTopColor: colors.ink },
  scheduleRow: {
    minHeight: MIN_TAP + r.r4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  scheduleRule5: { borderBottomColor: colors.rule5 },
  rowPressed: { backgroundColor: colors.fillYellow },
  rowDimmed: { opacity: 0.35 },
  rowName: { ...t.dat, fontSize: 18, color: colors.ink },
  rowMark: { ...t.dim, fontSize: 22, color: colors.inkFaint },

  link: { minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center' },
  linkText: { ...t.dat, color: colors.ink700, textDecorationLine: 'underline' },

  /* ── banded notices. Magenta has crossed a line; yellow is in hand. ──── */
  hazard: {
    backgroundColor: colors.fillYellow,
    borderLeftWidth: r.r8,
    borderLeftColor: colors.yellow,
    padding: r.r4,
    gap: r.r8,
  },
  hazardTitle: { color: colors.yellow },
  error: {
    backgroundColor: colors.fillMagenta,
    borderLeftWidth: r.r8,
    borderLeftColor: colors.magenta,
    padding: r.r4,
    gap: r.r8,
  },
  errorTitle: { color: colors.magenta },

  footnote: { ...t.lead, fontSize: 14, color: colors.inkFaint },
});
