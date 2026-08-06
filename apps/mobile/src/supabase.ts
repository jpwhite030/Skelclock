/**
 * Supabase auth.
 *
 * Tokens go in SecureStore (Keychain / Android Keystore), not AsyncStorage —
 * a session token is a credential for someone's pay record.
 *
 * Login is by mobile number and one-time code. Workers on site have a phone
 * number and often no email they check; an SMS code is the shortest path from
 * "new starter" to "clocked on", which is the under-five-minutes onboarding
 * target in the brief.
 */

import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

const url =
  (Constants.expoConfig?.extra?.supabaseUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  '';
const anonKey =
  (Constants.expoConfig?.extra?.supabaseAnonKey as string | undefined) ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  '';

/**
 * SecureStore rejects values over 2048 bytes. A Supabase session with a long
 * JWT can exceed that, so it is chunked rather than silently failing to
 * persist — which would log the worker out every time the app restarted.
 */
const CHUNK_SIZE = 1800;

const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(`${key}.0`);
    if (head === null) return SecureStore.getItemAsync(key);

    let value = head;
    for (let i = 1; ; i += 1) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part === null) break;
      value += part;
    }
    return value;
  },

  async setItem(key: string, value: string): Promise<void> {
    await secureStorage.removeItem(key);
    for (let i = 0; i * CHUNK_SIZE < value.length; i += 1) {
      await SecureStore.setItemAsync(
        `${key}.${i}`,
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      );
    }
  },

  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key).catch(() => undefined);
    for (let i = 0; i < 16; i += 1) {
      await SecureStore.deleteItemAsync(`${key}.${i}`).catch(() => undefined);
    }
  },
};

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    // No URL session detection: this is a native app, not a browser.
    detectSessionInUrl: false,
  },
});

export async function sendOtp(phone: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ phone: toE164(phone) });
  if (error) throw new Error(error.message);
}

export async function verifyOtp(phone: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    phone: toE164(phone),
    token,
    type: 'sms',
  });
  if (error) throw new Error(error.message);
}

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/**
 * Australian mobiles to E.164. Mirrors normaliseMobile() on the server so the
 * number a worker types matches the one imported from Odoo.
 */
export function toE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('61')) return `+${digits}`;
  if (digits.startsWith('0')) return `+61${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith('4')) return `+61${digits}`;
  return digits;
}
