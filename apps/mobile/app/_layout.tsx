import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { Session } from '@supabase/supabase-js';

// Side-effect only: registers TaskManager.defineTask(GEOFENCE_TASK_NAME, ...)
// at the true app entry, unconditionally. It already runs whenever useClock
// (mounted from app/index.tsx) pulls it in transitively, but a background
// geofence trigger can relaunch the app headless — via a path that may not
// render index.tsx first — and the OS needs the task already registered the
// moment that JS context finishes evaluating. Importing it here, outside any
// component, is the belt-and-suspenders placement Expo's own docs recommend.
import '../src/geofence';
import { supabase } from '../src/supabase';
import { colors } from '../src/theme';

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const onLogin = segments[0] === 'login';
    // Redirect in an effect rather than rendering a <Redirect>: the router is
    // not mounted on the first pass and would drop the navigation.
    if (!session && !onLogin) router.replace('/login');
    if (session && onLogin) router.replace('/');
  }, [ready, session, segments, router]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'SkelClock' }} />
        <Stack.Screen name="crew" options={{ title: 'My crew' }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
