'use client';

/**
 * Office sign-in — email and password, or a magic link.
 *
 * The link is still the better door: nothing to remember, no password to reset
 * on a Monday morning, and nothing to reuse from another site. It stays the
 * default. But it only works when mail actually reaches the person, and a
 * project without SMTP configured, or an account whose address nobody reads,
 * leaves the office locked out of its own dashboard with no way back in. The
 * password path is the way back in.
 *
 * Deliberately does not offer sign-up or a reset: a login only works if the
 * office has already created an app_user for that address, and telling a
 * stranger whether an email exists is not this page's job — the sent-state
 * below is identical either way, and a wrong password says only that.
 */

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [method, setMethod] = useState<'link' | 'password'>('link');
  const [phase, setPhase] = useState<'input' | 'sent'>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        // Never distinguishes "no such account" from "wrong password" — same
        // reason the link path shows one sent-state for both.
        setError('That email and password did not match.');
        return;
      }
      // The session cookie is written by the browser client; a full navigation
      // rather than a router push, so the server components re-render with it.
      window.location.assign('/');
    } finally {
      setBusy(false);
    }
  };

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
            {method === 'link'
              ? "Enter your work email and we'll send you a sign-in link. No password."
              : 'Enter your work email and password.'}
          </p>
          <form
            className="login-form__row"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !email.includes('@')) return;
              if (method === 'link') void send();
              else if (password) void signInWithPassword();
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
            {method === 'password' && (
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="Password"
              />
            )}
            <button
              className="btn"
              type="submit"
              disabled={busy || !email.includes('@') || (method === 'password' && !password)}
            >
              {busy ? (method === 'link' ? 'Sending…' : 'Signing in…') : method === 'link' ? 'Send link' : 'Sign in'}
            </button>
          </form>
          {error && (
            <p className="lbl" style={{ color: 'var(--cad-magenta)' }}>{error}</p>
          )}
          <button
            type="button"
            className="lbl"
            onClick={() => {
              setMethod(method === 'link' ? 'password' : 'link');
              setError(null);
            }}
            style={{
              background: 'none',
              border: 0,
              padding: 0,
              color: 'var(--muted)',
              textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            {method === 'link' ? 'Use a password instead' : 'Email me a link instead'}
          </button>
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
