/**
 * SHT 04 — SITE GEOFENCES · the setout sheet.
 *
 * Odoo only ever supplies an address; the import geocodes nothing, so the
 * lat/lng it writes is whatever came from the mapping layer, and often that is
 * nothing at all. This screen is where the office fixes that by hand, and it
 * is the only write path to a site's coordinates outside the Odoo import.
 *
 * Fitting for the drawing metaphor: setting out is exactly what a scaffolder
 * does before building — marking on the ground where every standard lands.
 */

import { listSiteExclusions, listSites } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { SiteAccessPanel } from './site-access-panel';
import { SitesMapLoader } from './sites-map-loader';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const sites = await listSites(db, { companyId: session.companyId });
  const canEdit = session.role === 'admin' || session.role === 'supervisor';

  const [exclusions, employees] = await Promise.all([
    listSiteExclusions(db, { companyId: session.companyId }),
    db.query<{ id: string; full_name: string }>(
      'select id, full_name from employee where company_id = $1 and active order by full_name',
      [session.companyId],
    ),
  ]);

  const placed = sites.filter((s) => s.latitude != null && s.longitude != null).length;
  const unplaced = sites.length - placed;

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Site geofences</h1>
        <span className="lbl no">SHT 04 / Setout</span>
      </div>

      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        {canEdit
          ? 'Drag a pin to where the gate actually is, or place one for a site that has none yet. The phone watches this exact point and radius to suggest a clock-on.'
          : 'Where each job site is watched for auto clock-in. Ask an admin or supervisor to correct a pin.'}
      </p>

      {/* Two counts, one baseline — deliberately not the dimension run on
          Working now nor the three-size stack on Exceptions. A site with no
          pin cannot raise a suggestion, so it is the number that matters. */}
      <div className="setout-counts">
        <span className="counts__item">
          <span className="dsp dim">{placed}</span>
          <span className="lbl">Placed</span>
        </span>
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span
            className="dsp dim"
            style={unplaced > 0 ? { color: 'var(--cad-yellow)' } : { color: 'var(--faint)' }}
          >
            {unplaced}
          </span>
          <span
            className="lbl"
            style={unplaced > 0 ? { color: 'var(--cad-yellow)' } : undefined}
          >
            No pin yet
          </span>
        </span>
      </div>

      <SitesMapLoader sites={sites} canEdit={canEdit} />

      <SiteAccessPanel
        sites={sites}
        exclusions={exclusions}
        employees={employees.rows.map((r) => ({ id: r.id, fullName: r.full_name }))}
        canEdit={canEdit}
      />
    </main>
  );
}
