/**
 * Stable per-install device identifier.
 *
 * Goes into every idempotency key so a bad sync can be traced back to the
 * handset it came from. Not a hardware id — those are restricted on both
 * platforms and are more identifying than this needs to be. A random id
 * generated on first launch and kept in SecureStore is enough.
 */

import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const KEY = 'skelclock.device_id';

let cached: string | null = null;

export async function deviceId(): Promise<string> {
  if (cached) return cached;

  const existing = await SecureStore.getItemAsync(KEY);
  if (existing) {
    cached = existing;
    return existing;
  }

  // Model prefix so the id is legible in a sync log: "pixel8-3f2a...".
  const model = (Device.modelName ?? Platform.OS)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  const created = `${model || Platform.OS}-${randomHex(8)}`;

  await SecureStore.setItemAsync(KEY, created);
  cached = created;
  return created;
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceDescription(): string {
  return [Device.manufacturer, Device.modelName, `${Platform.OS} ${Device.osVersion}`]
    .filter(Boolean)
    .join(' · ');
}
