/**
 * Working Now — who is on the tools right now, and where.
 *
 * The screen the office has open all day, so it self-refreshes and leads with
 * the two things that need action: someone clocked on well away from their
 * site, and anything that has not reached Odoo.
 */

import { getWorkingNow } from '@skelclock/server';

import { db } from '../lib/db';
import { getDashboardSession } from '../lib/session';
import { NoSession, SessionWarning } from '../components/session-state';

// Live shift state — never served from a cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function WorkingNowPage() {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const rows = await getWorkingNow(db, { companyId: session.companyId });

  const onBreak = rows.filter((r) => r.onBreak).length;
  const offSite = rows.filter((r) => r.locationStatus === 'outside').length;
  const unknownLocation = rows.filter((r) => r.locationStatus === 'unknown').length;

  return (
    <>
      {/* Cheap client-free auto-refresh: the office leaves this on a wall screen. */}
      <meta httpEquiv="refresh" content="60" />

      <SessionWarning session={session} />

      <h1>Working now</h1>
      <p className="subtitle">
        {session.companyName} · refreshed {new Date().toLocaleTimeString('en-AU')}
      </p>

      <div className="cards">
        <Stat value={rows.length} label="On the tools" />
        <Stat value={rows.length - onBreak} label="Working" />
        <Stat value={onBreak} label="On break" />
        <Stat value={offSite} label="Clocked on off-site" tone={offSite > 0 ? 'warn' : undefined} />
        <Stat
          value={unknownLocation}
          label="No location"
          tone={unknownLocation > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Crew</th>
                <th>Job</th>
                <th>Site</th>
                <th>Activity</th>
                <th>Clocked on</th>
                <th>Hours</th>
                <th>Location</th>
                <th>Sync</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employeeId}>
                  <td>
                    <strong>{r.employeeName}</strong>
                    {r.onBreak && <> <span className="pill info">On break</span></>}
                  </td>
                  <td className="muted">{r.crewName ?? '—'}</td>
                  <td className="nowrap">{r.jobNumber ?? <span className="pill warn">No job</span>}</td>
                  <td className="muted">{r.siteName ?? '—'}</td>
                  <td className="muted">{r.activityName ?? '—'}</td>
                  <td className="mono nowrap">{formatTime(r.clockInTime)}</td>
                  <td className="mono nowrap">{r.hoursWorkedLabel}</td>
                  <td className="nowrap">
                    <LocationPill status={r.locationStatus} distanceM={r.distanceM} />
                  </td>
                  <td className="nowrap">
                    <SyncPill status={r.syncStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="empty">
            Nobody is clocked on. This fills up as the crews start their day.
          </div>
        )}
      </div>
    </>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'warn' | 'error';
}) {
  return (
    <div className="card">
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  );
}

function LocationPill({
  status,
  distanceM,
}: {
  status: 'inside' | 'outside' | 'unknown';
  distanceM: number | null;
}) {
  if (status === 'inside') return <span className="pill ok">On site</span>;
  if (status === 'outside') {
    return (
      <span className="pill warn">
        {distanceM != null ? `${formatDistance(distanceM)} away` : 'Off site'}
      </span>
    );
  }
  return <span className="pill neutral">No GPS</span>;
}

function SyncPill({ status }: { status: string }) {
  const tone =
    status === 'success'
      ? 'ok'
      : status === 'failed' || status === 'dead'
        ? 'error'
        : status === 'not_queued'
          ? 'neutral'
          : 'info';
  const label =
    status === 'not_queued' ? 'Not queued' : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`pill ${tone}`}>{label}</span>;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m`;
}
