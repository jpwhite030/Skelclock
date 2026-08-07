// First import in the app: installs the crypto global that idempotency keys
// and the device id both depend on.
import '../src/polyfills';

import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
} from '@expo-google-fonts/ibm-plex-mono';
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans';

import { getSession, onSessionChange, type AppSession } from '../src/auth';
import { colors, fonts, FONT_ASSETS, type as t } from '../src/theme';

// Held until the faces are in memory. A first frame in the system font would
// be the exact defect SETOUT exists to fix, and on a cold start it is the
// frame a worker actually sees.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [ready, setReady] = useState(false);
  const segments = useSegments();
  const router = useRouter();

  const [fontsLoaded, fontError] = useFonts({
    ...FONT_ASSETS,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    InstrumentSans_400Regular,
  });

  useEffect(() => {
    getSession().then((next) => {
      setSession(next);
      setReady(true);
    });

    return onSessionChange(setSession);
  }, []);

  // A missing font file must not cost a worker their shift, so a load failure
  // falls through to the system face rather than holding the splash forever.
  const booted = ready && (fontsLoaded || fontError !== null);

  useEffect(() => {
    if (booted) void SplashScreen.hideAsync();
  }, [booted]);

  useEffect(() => {
    if (!ready) return;
    const onLogin = segments[0] === 'login';
    // Redirect in an effect rather than rendering a <Redirect>: the router is
    // not mounted on the first pass and would drop the navigation.
    if (!session && !onLogin) router.replace('/login');
    if (session && onLogin) router.replace('/');
  }, [ready, session, segments, router]);

  if (!booted) return null;

  return (
    <SafeAreaProvider>
      {/* Dark glyphs: the ground is paper. */}
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.paper },
          headerTintColor: colors.ink,
          headerShadowVisible: false,
          headerTitleStyle: {
            ...t.lbl,
            // The header title is chrome, and chrome is where brand is allowed.
            color: colors.brand,
            fontFamily: fonts.monoMedium,
          },
          contentStyle: { backgroundColor: colors.paper },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
