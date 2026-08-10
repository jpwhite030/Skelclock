/**
 * Runtime polyfills. Imported first, before anything that might need them.
 *
 * Hermes has no global `crypto`, and Expo's own runtime polyfills do not add
 * one. Without it two things fail on device:
 *
 *   newIdempotencyKey()  throws outright rather than guessing — see the
 *                        comment in packages/core/src/idempotency.ts. That is
 *                        every clock on, clock off and break, so the app is
 *                        unusable without this.
 *   deviceId()           needs random bytes to mint the handset's id.
 *
 * expo-crypto is backed by the platform CSPRNG (SecRandomCopyBytes on iOS),
 * which is the property that matters: an idempotency key a third party could
 * predict would let one worker's retry collide with another worker's event.
 * Math.random() is not an acceptable substitute and is deliberately not used
 * as a fallback anywhere in this app.
 */

import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues },
    configurable: true,
    enumerable: false,
    writable: false,
  });
} else if (typeof globalThis.crypto.getRandomValues !== 'function') {
  // A runtime that has the namespace but not the method — patch just the gap.
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: getRandomValues,
    configurable: true,
  });
}
