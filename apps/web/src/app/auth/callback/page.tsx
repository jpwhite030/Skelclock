'use client';

/**
 * Where a sign-in link lands.
 *
 * Supabase's hosted /auth/v1/verify redirects here carrying the session
 * either as an access/refresh token pair in the URL *fragment* — never sent
 * to a server, so this has to run in the browser — or, under the PKCE flow,
 * as a `code` in the query string instead. Handles both, since which one a
 * given project uses depends on its Auth settings.
 *
 * @supabase/ssr's browser client writes the resulting session to cookies
 * (not localStorage) in the same format getDashboardSession's server client
 * reads, which is the entire point of using it here instead of the plain
 * supabase-js client.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const hash = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');

    if (accessToken && refreshToken) {
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(
        ({ error: sessionError }) => {
          if (sessionError) setError(sessionError.message);
          else router.replace('/');
        },
      );
      return;
    }

    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error: sessionError }) => {
        if (sessionError) setError(sessionError.message);
        else router.replace('/');
      });
      return;
    }

    setError('No sign-in token found in this link.');
  }, [router]);

  return (
    <main style={{ padding: 'var(--r-4)' }}>
      <p className="lead" style={{ color: 'var(--muted)' }}>
        {error ? `Sign-in failed: ${error}` : 'Signing you in…'}
      </p>
    </main>
  );
}
