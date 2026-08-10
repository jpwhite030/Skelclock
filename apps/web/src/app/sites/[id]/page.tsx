/**
 * SHT 04a — one site, in full.
 *
 * The list answers "where are my sites". This answers "what is going on at
 * this one", which needed three screens and a guess before it existed: the
 * fence was on Sites, the jobs were in a Timesheets dropdown, the people were
 * on Working now, and the lockouts were in a panel at the bottom of a
 * different page.
 *
 * Everything here is read-only. Editing a fence means dragging a pin, and
 * dragging a pin belongs on the map — sending someone back to SHT 04 to do it
 * is the correct outcome, not a missing feature.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getSiteDetail, getWorkingNow } from '@skelclock/server';

import { db } from '../../../lib/db';
import { getDashboardSession } from '../../../lib/session';
import { NoSession, SessionWarning } from '../../../components/session-state';

export const dynamic = 'force-dynamic';

export default async function SiteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const { id } = await params;
  const site = await getSiteDetail(db, { companyId: session.companyId, siteId: id });
  // Not found and not-yours are answered identically on purpose: a different
  // response for another company's id would confirm the id exists.
  if (!site) notFound();

  const working = await getWorkingNow(db, { companyId: session.companyId });
  const here = working.filter((w) => w.siteId === site.id);

  const placed = site.latitude != null && site.longitude != null;

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">{site.name}</h1>
        <span className="lbl no">SHT 04a / Site</span>
      </div>

      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        {site.address ?? 'No address on file.'}
      </p>

      <div className="setout-counts">
        <span className="counts__item">
          <span className="dsp dim" style={here.length > 0 ? { color: 'var(--cad-green)' } : undefined}>
            {here.length}
          </span>
          <span className="lbl">On site now</span>
        </span>
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span className="dsp dim">{formatHours(site.minutesRecently)}</span>
          <span className="lbl">Hours / 14d</span>
        </span>
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span className="dsp dim">{site.peopleRecently}</span>
          <span className="lbl">People / 14d</span>
        </span>
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span className="dsp dim">{site.daysRecently}</span>
          <span className="lbl">Days / 14d</span>
        </span>
      </div>

      <section className="panel">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>The fence</h2>
        {placed ? (
          <dl className="site-facts">
            <Fact k="Radius" v={`${site.geofenceRadiusM} m`} />
            <Fact k="Latitude" v={site.latitude!.toFixed(6)} />
            <Fact k="Longitude" v={site.longitude!.toFixed(6)} />
            <Fact
              k="Operating hours"
              v={
                site.operatingHoursStart && site.operatingHoursEnd
                  ? `${site.operatingHoursStart.slice(0, 5)} → ${site.operatingHoursEnd.slice(0, 5)}`
                  : 'Company default'
              }
            />
          </dl>
        ) : (
          <p className="lead" style={{ color: 'var(--cad-yellow)', fontSize: 14 }}>
            No pin. Without coordinates there is no fence, so nobody here can be
            clocked on automatically and no clock can be judged on or off site.
          </p>
        )}
        <p>
          <Link className="act" href="/sites">
            {placed ? 'Move the pin on the map' : 'Place it on the map'}
          </Link>
        </p>
      </section>

      <section className="panel">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>On site now</h2>
        {here.length === 0 ? (
          <p className="lead" style={{ color: 'var(--faint)', fontSize: 14 }}>
            Nobody clocked on here.
          </p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th>Name</th>
                <th>Job</th>
                <th>Since</th>
                <th className="num">Hours</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {here.map((w) => (
                <tr key={w.employeeId}>
                  <td className="name">{w.employeeName}</td>
                  <td>{w.jobNumber ?? '—'}</td>
                  <td>{w.clockInTime ? formatTime(w.clockInTime) : '—'}</td>
                  <td className="num">{w.hoursWorkedLabel}</td>
                  <td>
                    {/* The privacy rule from working-map.tsx holds here too:
                        an off-site worker is a distance, never a location. */}
                    {w.locationStatus === 'inside'
                      ? 'Inside the fence'
                      : w.locationStatus === 'outside'
                        ? `${formatDistance(w.distanceM)} away`
                        : 'No fix'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Jobs at this site</h2>
        {site.jobs.length === 0 ? (
          <p className="lead" style={{ color: 'var(--faint)', fontSize: 14 }}>
            No jobs point at this site. It came from a job import that has since
            moved on, or the site was created by hand and nothing uses it yet.
          </p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th>Job</th>
                <th>Customer</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {site.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="name">{j.jobNumber}</td>
                  <td>{j.customerName ?? '—'}</td>
                  <td style={{ color: j.status === 'active' ? 'var(--bone-700)' : 'var(--faint)' }}>
                    {j.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {site.exclusions.length > 0 && (
        <section className="panel">
          <h2 className="lbl" style={{ color: 'var(--bone)' }}>Locked out</h2>
          <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
            A hard stop — no clock method works for these people at this site, and
            the job does not appear on their phone at all.
          </p>
          <table className="sheet">
            <thead>
              <tr>
                <th>Name</th>
                <th>Reason</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {site.exclusions.map((x) => (
                <tr key={x.id}>
                  <td className="name">{x.employeeName}</td>
                  <td>{x.reason}</td>
                  <td>{x.createdAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p>
        <Link className="act" href="/sites">
          ← All sites
        </Link>
      </p>
    </main>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="site-fact">
      <dt className="lbl">{k}</dt>
      <dd className="dat">{v}</dd>
    </div>
  );
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return '0h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

function formatDistance(metres: number | null): string {
  if (metres == null) return 'unknown distance';
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)}km`;
  return `${Math.round(metres)}m`;
}
