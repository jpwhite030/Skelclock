/**
 * SHT 06 — SETTINGS · payroll policy.
 *
 * Admin only, company-wide. Everything here changes how a day is built or
 * whether a clock is accepted at all (packages/core/src/segments.ts,
 * packages/server/src/ingest.ts) — not just how it's displayed.
 */

import { getCompanySettings } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { SettingsForm } from './settings-form';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  if (session.role !== 'admin') {
    return (
      <main>
        <SessionWarning session={session} />
        <div className="sht">
          <h1 className="dsp">Admin only</h1>
          <span className="lbl no">SHT 06 / Payroll policy</span>
        </div>
        <p className="lead" style={{ color: 'var(--muted)' }}>
          Payroll settings change how every employee's pay is computed. Ask an admin.
        </p>
      </main>
    );
  }

  const settings = await getCompanySettings(db, session.companyId);

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Settings</h1>
        <span className="lbl no">SHT 06 / Payroll policy</span>
      </div>

      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        Company-wide defaults. A site can override operating hours on its own row on
        the Sites screen — this is what applies everywhere that doesn&apos;t.
      </p>

      <SettingsForm settings={settings} />
    </main>
  );
}
