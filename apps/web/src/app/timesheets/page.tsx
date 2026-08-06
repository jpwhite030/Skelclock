/**
 * Timesheets — the payroll view, filtered the way payroll actually asks for it.
 *
 * Filters live in the query string rather than component state so a fortnight
 * view can be bookmarked and shared with the bookkeeper.
 */

import { listTimesheets } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';

export const dynamic = 'force-dynamic';

const STATUSES = [
  'draft',
  'worker_confirmed',
  'supervisor_approved',
  'synced',
  'locked',
] as const;

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const params = await searchParams;

  // Defaults to the last fortnight — one pay period, which is the window
  // payroll works in.
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
  const from = params.from || defaultFrom;
  const to = params.to || today.toISOString().slice(0, 10);

  const [employees, crews, jobs] = await Promise.all([
    db.query<{ id: string; full_name: string }>(
      'select id, full_name from employee where company_id = $1 and active order by full_name',
      [session.companyId],
    ),
    db.query<{ id: string; name: string }>(
      'select id, name from crew where company_id = $1 and active order by name',
      [session.companyId],
    ),
    db.query<{ id: string; job_number: string }>(
      `select id, job_number from job where company_id = $1
        and status in ('active','on_hold','complete') order by job_number`,
      [session.companyId],
    ),
  ]);

  const rows = await listTimesheets(db, {
    companyId: session.companyId,
    from,
    to,
    employeeId: params.employee || undefined,
    crewId: params.crew || undefined,
    jobId: params.job || undefined,
    status: params.status || undefined,
  });

  const totalPaidMinutes = rows.reduce((sum, r) => sum + r.totalPaidMinutes, 0);
  const needingApproval = rows.filter(
    (r) => r.status === 'draft' || r.status === 'worker_confirmed',
  ).length;

  return (
    <>
      <SessionWarning session={session} />

      <h1>Timesheets</h1>
      <p className="subtitle">
        {from} to {to} · {rows.length} day{rows.length === 1 ? '' : 's'}
      </p>

      <form className="filters" method="get">
        <label>
          From
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={to} />
        </label>
        <label>
          Employee
          <select name="employee" defaultValue={params.employee ?? ''}>
            <option value="">All</option>
            {employees.rows.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Crew
          <select name="crew" defaultValue={params.crew ?? ''}>
            <option value="">All</option>
            {crews.rows.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Job
          <select name="job" defaultValue={params.job ?? ''}>
            <option value="">All</option>
            {jobs.rows.map((j) => (
              <option key={j.id} value={j.id}>
                {j.job_number}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={params.status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          Apply
        </button>
      </form>

      <div className="cards">
        <div className="card">
          <div className="value mono">{formatMinutes(totalPaidMinutes)}</div>
          <div className="label">Paid hours in range</div>
        </div>
        <div className="card">
          <div
            className="value"
            style={needingApproval > 0 ? { color: 'var(--warn)' } : undefined}
          >
            {needingApproval}
          </div>
          <div className="label">Awaiting approval</div>
        </div>
        <div className="card">
          <div className="value">{rows.filter((r) => r.status === 'synced').length}</div>
          <div className="label">Synced to Odoo</div>
        </div>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Jobs</th>
                <th>Shift</th>
                <th>Break</th>
                <th>Paid</th>
                <th>Status</th>
                <th>Exceptions</th>
                <th>Odoo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono nowrap">{r.workDate}</td>
                  <td>{r.employeeName}</td>
                  <td className="muted">{r.jobNumbers.join(', ') || '—'}</td>
                  <td className="mono nowrap">{formatMinutes(r.totalShiftMinutes)}</td>
                  <td className="mono nowrap muted">{formatMinutes(r.totalBreakMinutes)}</td>
                  <td className="mono nowrap">
                    <strong>{r.paidHoursLabel}</strong>
                  </td>
                  <td className="nowrap">
                    <span className={`pill ${statusTone(r.status)}`}>{label(r.status)}</span>
                  </td>
                  <td className="nowrap">
                    {r.openExceptions > 0 ? (
                      <span className="pill warn">{r.openExceptions}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono muted nowrap">{r.odooIds.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="empty">No timesheets match those filters.</div>
        )}
      </div>
    </>
  );
}

const label = (status: string): string =>
  ({
    draft: 'Draft',
    worker_confirmed: 'Worker confirmed',
    supervisor_approved: 'Approved',
    synced: 'Synced',
    locked: 'Locked',
  })[status] ?? status;

const statusTone = (status: string): string =>
  ({
    draft: 'neutral',
    worker_confirmed: 'info',
    supervisor_approved: 'info',
    synced: 'ok',
    locked: 'ok',
  })[status] ?? 'neutral';

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
