import Link from 'next/link';

import type { DashboardSession } from '../lib/session';

export function NoSession() {
  return (
    <main>
      <div className="sht">
        <h1 className="dsp">Not signed in</h1>
        <span className="lbl no">SHT — / No datum</span>
      </div>
      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '52ch' }}>
        <Link href="/login" style={{ color: 'var(--bone)' }}>Sign in</Link> with an office
        account to see attendance. If this is a fresh install, run the migrations and
        import employees from Odoo first.
      </p>
    </main>
  );
}

/**
 * Loud on purpose, but not louder than the page title.
 *
 * The development fallback picks the first company in the database with no
 * login at all, and the office should never see this without knowing exactly
 * what it means. In the previous build this was a full-width amber bar sitting
 * *above* the page title — the loudest thing on screen, on every screen.
 */
export function SessionWarning({ session }: { session: DashboardSession }) {
  if (!session.unauthenticated) return null;

  return (
    <p
      className="lbl"
      style={{
        color: 'var(--cad-yellow)',
        borderLeft: '3px solid var(--cad-yellow)',
        paddingLeft: 'var(--r-4)',
        margin: 'var(--r-2) 0',
        lineHeight: 1.5,
      }}
    >
      Development mode — no Supabase session. Showing the first company in the database.
    </p>
  );
}
