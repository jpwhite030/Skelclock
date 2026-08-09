'use client';

/**
 * Office sign-in — email, magic link, done.
 *
 * Same decision as the phone app's number-plus-code: nothing to remember, no
 * password to reset on a Monday morning. The link Supabase emails lands on
 * /auth/callback, which writes the session cookie and forwards to the
 * dashboard.
 *
 * Deliberately does not offer sign-up: a login only works if the office has
 * already created an app_user for that address, and telling a stranger
 * whether an email exists is not this page's job — the sent-state below is
 * identical either way.
 */

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'input' | 'sent'>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error: sendError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          // No implicit account creation — see the header comment.
          shouldCreateUser: false,
        },
      });
      // "Signups not allowed" is what shouldCreateUser:false returns for an
      // unknown address. Deliberately shown as success — see header comment.
      if (sendError && !/signup/i.test(sendError.message)) {
        setError(sendError.message);
      } else {
        setPhase('sent');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <div className="sht">
        <h1 className="dsp">Sign in</h1>
        <span className="lbl no">SHT — / Datum</span>
      </div>

      {phase === 'input' ? (
        <div className="login-form">
          <p className="lead" style={{ color: 'var(--muted)', maxWidth: '52ch' }}>
            Enter your work email and we&apos;ll send you a sign-in link. No password.
          </p>
          <form
            className="login-form__row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && email.includes('@')) void send();
            }}
          >
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@skelscaff.com.au"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Work email"
              autoFocus
            />
            <button className="btn" type="submit" disabled={busy || !email.includes('@')}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </form>
          {error && (
            <p className="lbl" style={{ color: 'var(--cad-magenta)' }}>{error}</p>
          )}
        </div>
      ) : (
        <p className="lead" style={{ color: 'var(--muted)', maxWidth: '52ch' }}>
          If <span style={{ color: 'var(--bone)' }}>{email.trim()}</span> has an office
          account, a sign-in link is on its way. Open it on this device. Nothing arrived
          after a few minutes? Check spam, or ask an admin to confirm the address on your
          account.
        </p>
      )}
    </main>
  );
}
