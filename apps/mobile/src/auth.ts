/**
 * Sign-in, whichever way this build is configured.
 *
 * Two paths sit behind one interface so no screen has to know which is in use:
 *
 *   Supabase   mobile number + SMS one-time code, the real thing.
 *   Demo       no Supabase project configured, so there is no SMS provider and
 *              no JWT. The number is taken at face value and the bearer token
 *              becomes `demo:+61...`, which the web app resolves straight to
 *              an app_user — see requireCaller() in apps/web/src/lib/auth.ts,
 *              which refuses those tokens in production and whenever a real
 *              Supabase project is configured.
 *
 * The demo path exists so the phone app runs against the seeded database on a
 * clean clone. It is a complete authentication bypass by construction, which
 * is why the server, not the client, is what refuses it in production — the
 * client is the part an attacker controls.
 *
 * The employee id is never taken from the client. Both paths ask the server
 * who the token belongs to (GET /api/me), because the id is what every queued
 * event is stamped with and it decides whose pay record a shift lands on.
 */

import * as SecureStore from 'expo-secure-store';

import { ApiClient } from './api';
import { stop as stopTracking } from './tracking';
import { isSupabaseConfigured, requireSupabase, toE164 } from './supabase';

export { toE164 };

/** True when this build has no Supabase project and falls back to demo login. */
export const IS_DEMO = !isSupabaseConfigured;

/**
 * The crew the demo seed creates, listed on the login screen of a demo build.
 *
 * Employee numbers included because they are what the office and the workers
 * both actually use — the same identifier the seed writes to employee_number
 * and that Odoo knows them by. A crew list without them is a list of strangers.
 */
export const DEMO_NUMBERS = [
  { name: 'Dean Whitmore', number: 'SS-114', crew: 'Crew A', mobile: '+61412555208' },
  { name: 'Tobias Renner', number: 'SS-118', crew: 'Crew A', mobile: '+61412555209' },
  { name: 'Ana Petrovic', number: 'SS-121', crew: 'Crew A', mobile: '+61412555210' },
  { name: 'Mikhail Dvorak', number: 'SS-126', crew: 'Crew B', mobile: '+61412555211' },
  { name: 'Priya Raghavan', number: 'SS-130', crew: 'Crew B', mobile: '+61412555212' },
];

export interface AppSession {
  employeeId: string | null;
  fullName: string | null;
}

const DEMO_KEY = 'skelclock.demo.mobile';

/**
 * The resolved employee link, cached at sign-in.
 *
 * Resolving it costs a request, and a worker who opens the app in a dead spot
 * must still land on their clock screen rather than a login screen — being
 * signed in is not a fact about the network. So it is asked for once, when
 * signing in, and read locally from then on.
 */
const PROFILE_KEY = 'skelclock.session.profile';

type Listener = (session: AppSession | null) => void;

const listeners = new Set<Listener>();

function announce(session: AppSession | null): void {
  for (const listener of listeners) listener(session);
}

/** Subscribe to sign-in and sign-out. Returns the unsubscribe function. */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);

  // The Supabase client has its own notion of the session changing — a token
  // refresh failing, for instance — so that has to be forwarded too.
  let unsubscribeSupabase: (() => void) | undefined;
  if (!IS_DEMO) {
    const { data } = requireSupabase().auth.onAuthStateChange((_event, next) => {
      if (!next) {
        listener(null);
        return;
      }
      void getSession().then(listener);
    });
    unsubscribeSupabase = () => data.subscription.unsubscribe();
  }

  return () => {
    listeners.delete(listener);
    unsubscribeSupabase?.();
  };
}

/** The bearer token for API calls, or null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (IS_DEMO) {
    const mobile = await SecureStore.getItemAsync(DEMO_KEY);
    return mobile ? `demo:${mobile}` : null;
  }
  const { data } = await requireSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

const api = new ApiClient(accessToken);

async function cacheProfile(profile: AppSession): Promise<void> {
  await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(profile));
}

async function cachedProfile(): Promise<AppSession | null> {
  const raw = await SecureStore.getItemAsync(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppSession;
  } catch {
    return null;
  }
}

/** Asks the server who the current token belongs to, and remembers it. */
async function resolveProfile(): Promise<AppSession | null> {
  try {
    const me = await api.me();
    const profile: AppSession = { employeeId: me.employeeId, fullName: me.fullName };
    await cacheProfile(profile);
    return profile;
  } catch {
    return null;
  }
}

/**
 * The current session, or null.
 *
 * Answered locally. Whether someone is signed in is decided by the stored
 * credential alone, never by whether the API answered — this runs on every
 * app start, and a worker standing in a basement is still signed in.
 */
export async function getSession(): Promise<AppSession | null> {
  if (IS_DEMO) {
    if ((await SecureStore.getItemAsync(DEMO_KEY)) === null) return null;
  } else {
    const { data } = await requireSupabase().auth.getSession();
    if (!data.session) return null;

    // The real sign-in carries the employee link in the token itself.
    const metadata = data.session.user.user_metadata ?? {};
    const employeeId = metadata.employee_id as string | undefined;
    if (employeeId) {
      return { employeeId, fullName: (metadata.full_name as string | undefined) ?? null };
    }
  }

  // Signed in, but the credential does not name the employee — the demo token
  // never does. Cache first, network second, and if both come up empty stay
  // signed in with no employee rather than silently signing the worker out.
  return (await cachedProfile()) ?? (await resolveProfile()) ?? { employeeId: null, fullName: null };
}

export async function sendOtp(phone: string): Promise<void> {
  // Nothing to send in demo mode: there is no SMS provider configured. The
  // code screen still appears, so the flow being demonstrated is the real one.
  if (IS_DEMO) return;

  const { error } = await requireSupabase().auth.signInWithOtp({ phone: toE164(phone) });
  if (error) throw new Error(error.message);
}

/**
 * Sign in as a seeded worker by tapping their name. Demo builds only.
 *
 * There is no number to type and no code to wait for, because in demo mode
 * there was never an SMS behind either — the code screen was theatre, and
 * asking a scaffolder to type a phone number to look at a test build is a
 * pointless obstacle. The token minted is the same `demo:+61...` the OTP path
 * produced, so everything downstream is unchanged.
 *
 * Throws if called on a build with a real Supabase project configured: there,
 * identity has to come from something the worker proves, not something they
 * pick off a list.
 */
export async function signInAsDemoWorker(mobile: string): Promise<void> {
  if (!IS_DEMO) throw new Error('Demo sign-in is not available on this build.');
  await verifyOtp(mobile, '');
}

export async function verifyOtp(phone: string, token: string): Promise<void> {
  // Whoever signed in last must not leak into this session.
  await SecureStore.deleteItemAsync(PROFILE_KEY).catch(() => undefined);

  if (IS_DEMO) {
    const mobile = toE164(phone);
    await SecureStore.setItemAsync(DEMO_KEY, mobile);

    // Confirm the number matches a seeded worker before claiming a session,
    // so a typo says so here instead of on an empty clock screen. This is the
    // one point in the demo flow that needs the API to be reachable.
    const profile = await resolveProfile();
    if (!profile) {
      await SecureStore.deleteItemAsync(DEMO_KEY).catch(() => undefined);
      throw new Error(
        `No demo worker has the number ${mobile}, or the API is not running. Start it with: cd apps/web && npx next dev -p 3000`,
      );
    }
    announce(profile);
    return;
  }

  const { error } = await requireSupabase().auth.verifyOtp({
    phone: toE164(phone),
    token,
    type: 'sms',
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  // Signing out is one of the ways to stop being on shift, so it is one of the
  // ways location tracking has to stop. useClock covers the others.
  await stopTracking().catch(() => undefined);
  await SecureStore.deleteItemAsync(PROFILE_KEY).catch(() => undefined);

  if (IS_DEMO) {
    await SecureStore.deleteItemAsync(DEMO_KEY).catch(() => undefined);
    announce(null);
    return;
  }
  await requireSupabase().auth.signOut();
}
