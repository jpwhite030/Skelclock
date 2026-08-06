/**
 * SHT 04 — ODOO SYNC · a transmittal sheet.
 *
 * "Transmittal" is what a drawing office calls sending documents out. That is
 * exactly what an Odoo push is.
 *
 * This is acceptance criterion 7 in the brief, and the screen that decides
 * whether the office trusts the system: a failure that is visible with a
 * readable error and a working retry is a minor annoyance, whereas a shift
 * that silently never reached payroll is what got ConstructionClock replaced.
 *
 * Green is spent here, unlike the glance screens — this is a reconciliation
 * screen, and the load bar needs a green mass to read as healthy from across
 * the room.
 */

import { getSyncSummary, listSyncJobs } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { RetryButton, RunAllButton } from './actions';

export const dynamic = 'force-dynamic';

const SEGMENTS = [
  { key: 'pending', label: 'Pending' },
  { key: 'running', label: 'In progress' },
  { key: 'success', label: 'Successful' },
  { key: 'failed', label: 'Failed' },
  { key: 'dead', label: 'Given up' },
] as const;

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
    <main>
      {/* A. Hazard band. Ignores the shell entirely and runs under the rail,
             edge to edge. Rendered only when something is actually stuck. */}
      {stuck > 0 && (
        <div className="hazard">
          <p>
            <strong>
              {stuck} record{stuck === 1 ? '' : 's'} did not reach Odoo.
            </strong>{' '}
            Those hours are recorded here but not in payroll. Fix the cause and push it
            again.
          </p>
        </div>
      )}

      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Odoo sync</h1>
        <span className="lbl no">SHT 05 / Transmittal</span>
      </div>

      <form className="spec" method="get">
        <label>
          Showing
          <select name="status" defaultValue={params.status ?? 'all'}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="success">Successful</option>
            <option value="failed">Failed</option>
            <option value="dead">Given up</option>
          </select>
        </label>
        <button type="submit" className="btn">Apply</button>
        <span className="grow" />
        <RunAllButton />
      </form>

      {/* B. One bar, replacing five stat cards. Every non-zero segment keeps a
             6px floor so the state that matters most does not vanish exactly
             when it is rarest; zero segments stay as a 2px hairline so you can
             see the state exists. */}
      <div
        className="loadbar"
        role="img"
        aria-label={SEGMENTS.map((s) => `${summary[s.key]} ${s.label}`).join(', ')}
      >
        {SEGMENTS.map((s) => {
          const count = summary[s.key];
          return (
            <i
              key={s.key}
              data-seg={s.key}
              style={
                count > 0
                  ? { flex: `${count} 1 0`, minWidth: 6 }
                  : { flex: '0 0 2px', opacity: 0.35 }
              }
            />
          );
        })}
      </div>

      {/* The legend does not move. One you must re-read after every refresh
          has stopped being a legend. */}
      <div className="legend">
        {SEGMENTS.map((s) => (
          <div key={s.key}>
            <span className="n">{summary[s.key]}</span>
            <span className="lbl">{s.label}</span>
          </div>
        ))}
      </div>

      {/* C. Six columns. Failed rows spawn an always-open console sub-row —
             <details> hides the one thing this screen exists for. */}
      <table className="sheet">
        <colgroup>
          <col style={{ width: '16%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: '12%' }} />
          <col className="opt" style={{ width: '16%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Status</th>
            <th>Employee</th>
            <th>Date</th>
            <th className="opt">Op</th>
            <th>Odoo id</th>
            <th className="num">Att</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr className="empty">
              <td colSpan={6}>Nothing queued. Everything approved has reached Odoo.</td>
            </tr>
          )}

          {rows.map((r) => {
            const broken = r.status === 'failed' || r.status === 'dead';
            return (
              <Row key={r.id} row={r} broken={broken} />
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

// --- pieces -----------------------------------------------------------------

type SyncJob = Awaited<ReturnType<typeof listSyncJobs>>[number];

function Row({ row, broken }: { row: SyncJob; broken: boolean }) {
  return (
    <>
      <tr data-breach={broken ? '' : undefined}>
        <td>
          <span className={`mk ${markFor(row.status)}`}>{statusWord(row.status)}</span>
        </td>
        <td className="name">{row.employeeName ?? '—'}</td>
        <td>{row.workDate ? formatDate(row.workDate) : '—'}</td>
        <td className="opt" style={{ color: 'var(--muted)' }}>{row.operation}</td>
        <td>
          {row.odooRecordId ?? '—'}
          {row.status === 'failed' && row.nextAttemptAt && (
            <span className="sub">Next {formatWhen(row.nextAttemptAt)}</span>
          )}
        </td>
        <td className="num">
          {broken ? (
            <RetryButton jobId={row.id} />
          ) : (
            <span style={{ color: 'var(--faint)' }}>{row.attempts}</span>
          )}
        </td>
      </tr>

      {broken && (
        <tr className="console">
          <td colSpan={6} id={`err-${row.id}`}>
            {row.lastError ?? 'No error text was recorded.'}
            <span className="next">
              Attempt {row.attempts} · {statusWord(row.status)}
              {row.nextAttemptAt && row.status === 'failed'
                ? ` · retries ${formatWhen(row.nextAttemptAt)}`
                : ''}
            </span>
          </td>
        </tr>
      )}
    </>
  );
}

// --- formatting -------------------------------------------------------------

const statusWord = (s: string): string =>
  ({
    pending: 'Pending',
    running: 'In progress',
    success: 'Success',
    failed: 'Failed',
    dead: 'Given up',
  })[s] ?? s;

const markFor = (s: string): string =>
  ({
    pending: 'mk-setout',
    running: 'mk-setout',
    success: 'mk-synced',
    failed: 'mk-breach',
    dead: 'mk-breach',
  })[s] ?? 'mk-void';

function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}
