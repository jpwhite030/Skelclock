/**
 * Site geofences — view and correct where each job site's pin actually sits.
 *
 * Odoo only ever supplies an address; `import.ts` geocodes nothing, so the
 * lat/lng it writes is whatever came from the mapping layer (often absent).
 * This screen is where the office fixes that by hand, which is also the only
 * write path outside of the Odoo import.
 */

import { listSites } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { SitesMapLoader } from './sites-map-loader';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const sites = await listSites(db, { companyId: session.companyId });
  const canEdit = session.role === 'admin' || session.role === 'supervisor';

  return (
    <>
      <SessionWarning session={session} />

      <h1>Site geofences</h1>
      <p className="subtitle">
        {canEdit
          ? 'Drag a pin to where the gate actually is, or place one for a site that has none yet. The mobile app watches this exact point and radius for auto clock-in.'
          : 'Where each job site is watched for auto clock-in. Ask an admin or supervisor to correct a pin.'}
      </p>

      <SitesMapLoader sites={sites} canEdit={canEdit} />
    </>
  );
}
