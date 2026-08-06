import type { DashboardSession } from '../lib/session';

export function NoSession() {
  return (
    <div className="panel">
      <div className="empty">
        <h1>Not signed in</h1>
        <p className="muted">
          Sign in with an office account to see attendance. If this is a fresh install, run the
          migrations and import employees from Odoo first.
        </p>
      </div>
    </div>
  );
}

/**
 * Loud on purpose. The development fallback picks the first company in the
 * database with no login at all, and the office should never see this screen
 * without knowing exactly what it means.
 */
export function SessionWarning({ session }: { session: DashboardSession }) {
  if (!session.unauthenticated) return null;
  return (
    <div className="banner warn">
      <strong>Development mode.</strong> No Supabase session — showing the first company in the
      database. Set SUPABASE_URL and SUPABASE_ANON_KEY to require a real login.
    </div>
  );
}
