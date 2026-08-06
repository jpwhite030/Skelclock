/**
 * Exceptions — the office's work queue.
 *
 * Sorted by severity, because the point of this screen is "what do I have to
 * chase before payroll runs", not "everything that has ever been odd".
 */

import { listExceptions } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  missing_clock_in: 'Missing clock-in',
  missing_clock_out: 'Missing clock-out',
  outside_geofence: 'Clocked off-site',
  overlapping_shift: 'Overlapping shifts',
  very_long_shift: 'Very long shift',
  offline_event: 'Recorded offline',
  unassigned_job: 'No job selected',
  odoo_sync_failure: 'Odoo sync failed',
};

/** What the office should actually do about each kind. */
const GUIDANCE: Record<string, string> = {
  missing_clock_in: 'Ask the supervisor what time they started, then add the missing time.',
  missing_clock_out: 'Ask the supervisor what time they knocked off, then add the missing time.',
  outside_geofence: 'Check with the supervisor. Site coordinates may also need correcting.',
  overlapping_shift: 'The same hours are claimed twice. One of the two needs correcting.',
  very_long_shift: 'Usually a forgotten clock-out. Confirm before it reaches payroll.',
  offline_event: 'No action needed. The times came from the device clock, as designed.',
  unassigned_job: 'Assign the job so the hours can be costed.',
  odoo_sync_failure: 'See the Odoo sync tab for the error and the retry button.',
};

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const params = await searchParams;
  const status = params.status ?? 'open';

  const rows = await listExceptions(db, {
    companyId: session.companyId,
    status: status === 'all' ? undefined : status,
  });

  const bySeverity = {
    1: rows.filter((r) => r.severity === 1).length,
    2: rows.filter((r) => r.severity === 2).length,
    3: rows.filter((r) => r.severity === 3).length,
  };

  return (
    <>
      <SessionWarning session={session} />

      <h1>Exceptions</h1>
      <p className="subtitle">
        Attendance that needs a human decision before it reaches payroll.
      </p>

      <div className="cards">
        <div className="card">
          <div className="value" style={bySeverity[1] > 0 ? { color: 'var(--error)' } : undefined}>
            {bySeverity[1]}
          </div>
          <div className="label">Chase today</div>
        </div>
        <div className="card">
          <div className="value" style={bySeverity[2] > 0 ? { color: 'var(--warn)' } : undefined}>
            {bySeverity[2]}
          </div>
          <div className="label">Review at approval</div>
        </div>
        <div className="card">
          <div className="value muted">{bySeverity[3]}</div>
          <div className="label">Informational</div>
        </div>
      </div>

      <form className="filters" method="get">
        <label>
          Status
          <select name="status" defaultValue={status}>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="submit" className="primary">
          Apply
        </button>
      </form>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Type</th>
                <th>Employee</th>
                <th>Date</th>
                <th>What happened</th>
                <th>What to do</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`pill ${severityTone(r.severity)}`}>
                      {severityLabel(r.severity)}
                    </span>
                  </td>
                  <td className="nowrap">{TYPE_LABELS[r.type] ?? r.type}</td>
                  <td>{r.employeeName ?? '—'}</td>
                  <td className="mono nowrap">{r.workDate ?? '—'}</td>
                  <td>{r.message}</td>
                  <td className="muted">{GUIDANCE[r.type] ?? ''}</td>
                  <td className="nowrap">
                    <span className={`pill ${r.status === 'open' ? 'warn' : 'neutral'}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="empty">
            Nothing to chase. Every shift in this view looks clean.
          </div>
        )}
      </div>
    </>
  );
}

const severityLabel = (s: number): string => (s === 1 ? 'High' : s === 2 ? 'Medium' : 'Info');
const severityTone = (s: number): string => (s === 1 ? 'error' : s === 2 ? 'warn' : 'neutral');
