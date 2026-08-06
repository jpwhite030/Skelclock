/**
 * Odoo sync — pending, successful and failed records, with a retry button.
 *
 * Acceptance criterion 7 in the brief, and the screen that decides whether the
 * office trusts the system: a failure that is visible with a readable error and
 * a working retry is a minor annoyance, whereas a shift that silently never
 * reached payroll is what got ConstructionClock replaced.
 */

import { getSyncSummary, listSyncJobs } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { RetryButton, RunAllButton } from './actions';

export const dynamic = 'force-dynamic';

export default async function SyncPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const params = await searchParams;
  const status = params.status && params.status !== 'all' ? params.status : undefined;

  const [summary, rows] = await Promise.all([
    getSyncSummary(db, session.companyId),
    listSyncJobs(db, { companyId: session.companyId, status }),
  ]);

  const stuck = summary.failed + summary.dead;

  return (
    <>
      <SessionWarning session={session} />

      <h1>Odoo sync</h1>
      <p className="subtitle">
        Approved days are pushed to Odoo as hr.attendance records. Nothing is ever deleted here —
        a failed push stays until it succeeds.
      </p>

      {stuck > 0 && (
        <div className="banner error">
          <strong>
            {stuck} record{stuck === 1 ? '' : 's'} did not reach Odoo.
          </strong>{' '}
          Those hours are recorded here but are not in payroll yet. Read the error, fix the
          cause, then retry.
        </div>
      )}

      <div className="cards">
        <Stat value={summary.pending} label="Pending" />
        <Stat value={summary.running} label="In progress" />
        <Stat value={summary.success} label="Successful" tone="ok" />
        <Stat value={summary.failed} label="Failed" tone={summary.failed > 0 ? 'warn' : undefined} />
        <Stat
          value={summary.dead}
          label="Given up"
          tone={summary.dead > 0 ? 'error' : undefined}
        />
      </div>

      <form className="filters" method="get">
        <label>
          Status
          <select name="status" defaultValue={params.status ?? 'all'}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="success">Successful</option>
            <option value="failed">Failed</option>
            <option value="dead">Given up</option>
          </select>
        </label>
        <button type="submit">Apply</button>
        <RunAllButton />
      </form>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Employee</th>
                <th>Date</th>
                <th>Operation</th>
                <th>Odoo record</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Next try</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">
                    <span className={`pill ${tone(r.status)}`}>{statusLabel(r.status)}</span>
                  </td>
                  <td>{r.employeeName ?? '—'}</td>
                  <td className="mono nowrap">{r.workDate ?? '—'}</td>
                  <td className="muted nowrap">{r.operation}</td>
                  <td className="mono nowrap">{r.odooRecordId ?? '—'}</td>
                  <td className="mono">{r.attempts}</td>
                  <td>
                    {r.lastError ? (
                      <details className="error-detail">
                        <summary>{firstLine(r.lastError)}</summary>
                        <pre>{r.lastError}</pre>
                      </details>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted mono nowrap">
                    {r.status === 'failed' ? formatWhen(r.nextAttemptAt) : '—'}
                  </td>
                  <td>
                    {(r.status === 'failed' || r.status === 'dead') && (
                      <RetryButton jobId={r.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 && (
          <div className="empty">Nothing queued. Everything approved has reached Odoo.</div>
        )}
      </div>
    </>
  );
}

function Stat({
  value,
  label,
  tone: toneName,
}: {
  value: number;
  label: string;
  tone?: 'ok' | 'warn' | 'error';
}) {
  return (
    <div className="card">
      <div
        className="value"
        style={toneName && value > 0 ? { color: `var(--${toneName})` } : undefined}
      >
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  );
}

const statusLabel = (s: string): string =>
  ({
    pending: 'Pending',
    running: 'In progress',
    success: 'Success',
    failed: 'Failed',
    dead: 'Given up',
  })[s] ?? s;

const tone = (s: string): string =>
  ({
    pending: 'info',
    running: 'info',
    success: 'ok',
    failed: 'warn',
    dead: 'error',
  })[s] ?? 'neutral';

const firstLine = (text: string): string => {
  const line = text.split('\n')[0]!;
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return 'due now';
  if (minutes < 60) return `in ${minutes}m`;
  return at.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}
