/**
 * Mobile number + one-time code login.
 *
 * Two screens' worth of interaction, deliberately: number, then code. Nothing
 * to choose, nothing to remember, no password to reset on a Monday morning.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { sendOtp, verifyOtp, toE164 } from '../src/supabase';
import { colors, radius, spacing, type, MIN_TAP } from '../src/theme';

export default function LoginScreen() {
  const [phase, setPhase] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // The root layout notices the session and routes onward.
    } catch {
      setError('That code did not work. Check it and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.brand}>SkelClock</Text>
        <Text style={styles.muted}>SkelScaff site attendance</Text>

        {phase === 'phone' ? (
          <>
            <Text style={styles.label}>YOUR MOBILE NUMBER</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="0412 345 678"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
              editable={!busy}
            />
            {phone.length >= 9 && (
              <Text style={styles.muted}>We'll text a code to {toE164(phone)}</Text>
            )}
            <PrimaryButton
              label="Send me a code"
              busy={busy}
              disabled={phone.replace(/\D/g, '').length < 9}
              onPress={() => void requestCode()}
            />
          </>
        ) : (
          <>
            <Text style={styles.label}>ENTER THE 6 DIGIT CODE</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={6}
              autoFocus
              editable={!busy}
            />
            <PrimaryButton
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

        {error && <Text style={styles.error}>{error}</Text>}

        <Text style={styles.footnote}>
          Trouble signing in? Your number has to match the one in the office system — ask
          your supervisor to check it.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function PrimaryButton({
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
      disabled={busy || disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { opacity: busy || disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  inner: { padding: spacing.lg, gap: spacing.md },
  brand: { fontSize: 40, fontWeight: '800', color: colors.text },
  muted: { ...type.body, color: colors.textMuted },
  label: { ...type.label, color: colors.textMuted, marginTop: spacing.md },
  input: {
    minHeight: MIN_TAP + 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    fontSize: 22,
    color: colors.text,
  },
  codeInput: { letterSpacing: 12, textAlign: 'center', fontSize: 28 },
  button: {
    minHeight: MIN_TAP + 12,
    borderRadius: radius.md,
    backgroundColor: colors.on,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  buttonText: { ...type.heading, color: '#fff', letterSpacing: 0.5 },
  link: { minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center' },
  linkText: { ...type.body, color: colors.textMuted, textDecorationLine: 'underline' },
  error: { ...type.body, color: colors.error },
  footnote: { ...type.body, color: colors.textMuted, fontSize: 14, marginTop: spacing.lg },
});
