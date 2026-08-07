/**
 * SHT 02 — TIMESHEETS · a grouped ledger on paper.
 *
 * This is the only light surface in the app, and it is a whole screen rather
 * than a widget. The rule: light where a person reads for twenty minutes, dark
 * where a person glances or where the machine talks. Reconciling a fortnight is
 * the longest continuous read in the product, and ink-on-paper at 13px beats
 * bone-on-black at 13px for sustained scanning.
 *
 * If a second paper surface ever appears anywhere in this app, this one stops
 * meaning anything.
 *
 * Rows are grouped BY EMPLOYEE, because payroll reconciles per person. The
 * previous build sorted by date, which scattered each person's shifts across
 * nineteen date blocks.
 */

import Link from 'next/link';

import { listTimesheets, type TimesheetRow } from '@skelclock/server';

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

  // Defaults to the last fortnight — one pay period, the window payroll works
  // in.
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

  const groups = groupByEmployee(rows);

  const totalPaid = rows.reduce((sum, r) => sum + r.totalPaidMinutes, 0);
  const awaiting = rows.filter(
    (r) => r.status === 'draft' || r.status === 'worker_confirmed',
  ).length;
  const synced = rows.filter((r) => r.status === 'synced' || r.status === 'locked').length;

  return (
    <main className="paper">
      {/* A. Title block. These four numbers are the reason anyone opens this
             screen, so they are the first thing on it and they stay pinned. */}
      <div className="title-block">
        <Cell k="Total paid" v={formatMinutes(totalPaid)} />
        <Cell k="Days" v={String(rows.length)} />
        <Cell k="Awaiting" v={String(awaiting)} hold={awaiting > 0} />
        <Cell k="Synced" v={String(synced)} />
      </div>

      <SessionWarning session={session} />

      <div className="sht" style={{ paddingTop: 'var(--r-2)' }}>
        <h1 className="dsp">Timesheets</h1>
        <span className="lbl no">SHT 02 / Schedule — pay period</span>
      </div>

      {/* B. Spec line. Not boxed inputs in a card — inline mono controls read
             as one sentence. Every control keeps a persistent chevron, a
             visible rule, a hover ground and a real APPLY button, so nobody
             has to guess whether it took. */}
      <form className="spec" method="get">
        <span>Period</span>
        <input type="date" name="from" defaultValue={from} aria-label="From date" />
        <span className="sep">→</span>
        <input type="date" name="to" defaultValue={to} aria-label="To date" />

        <span className="sep">·</span>
        <label>
          Emp
          <select name="employee" defaultValue={params.employee ?? ''}>
            <option value="">All</option>
            {employees.rows.map((e) => (
              <option key={e.id} value={e.id}>{e.full_name}</option>
            ))}
          </select>
        </label>

        <span className="sep">·</span>
        <label>
          Crew
          <select name="crew" defaultValue={params.crew ?? ''}>
            <option value="">All</option>
            {crews.rows.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        <span className="sep">·</span>
        <label>
          Job
          <select name="job" defaultValue={params.job ?? ''}>
            <option value="">All</option>
            {jobs.rows.map((j) => (
              <option key={j.id} value={j.id}>{j.job_number}</option>
            ))}
          </select>
        </label>

        <span className="sep">·</span>
        <label>
          Status
          <select name="status" defaultValue={params.status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{statusWord(s)}</option>
            ))}
          </select>
        </label>

        <span className="grow" />
        <button type="submit" className="btn">Apply</button>
      </form>

      {/* C. The grouped ledger. Vertical rules track a value across six
             columns; every 5th row takes the counting rule. */}
      <table className="sheet">
        <colgroup>
          <col style={{ width: '14%' }} />
          <col style={{ width: '22%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '26%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Jobs</th>
            <th className="num">Shift</th>
            <th className="num">Break</th>
            <th className="num">Paid</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr className="empty">
              <td colSpan={6}>No timesheets match those filters.</td>
            </tr>
          )}

          {groups.map((group) => (
            <Group key={group.employeeId} group={group} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

// --- pieces -----------------------------------------------------------------

function Cell({ k, v, hold }: { k: string; v: string; hold?: boolean }) {
  return (
    <div className="title-block__cell">
      <span className="lbl title-block__k">{k}</span>
      <span className="dsp title-block__v" data-hold={hold ? '' : undefined}>
        {v}
      </span>
    </div>
  );
}

/**
 * One employee's fortnight.
 *
 * The band carries that person's total, right-aligned under the PAID column.
 * There is exactly one total per person and no hanging subtotal — two totals
 * for the same person with no stated distinction is a reconciliation hazard
 * the moment they disagree.
 */
function Group({ group }: { group: EmployeeGroup }) {
  return (
    <>
      <tr className="group-band">
        <td colSpan={4}>
          <span className="dsp group-band__name">{group.employeeName}</span>
        </td>
        <td className="num">
          <span className="group-band__total">{formatMinutes(group.totalPaidMinutes)}</span>
        </td>
        <td>
          <span className="lbl" style={{ color: 'var(--ink-faint)' }}>
            {group.rows.length} day{group.rows.length === 1 ? '' : 's'}
          </span>
        </td>
      </tr>

      {group.rows.map((r) => (
        <tr key={r.id} data-breach={r.openExceptions > 0 ? '' : undefined}>
          <td>
            <Link href={`/timesheets/${r.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              {formatDate(r.workDate)}
            </Link>
            {r.openExceptions > 0 && (
              <span className="exc-flag" title={`${r.openExceptions} open exception(s)`}>
                ▲{r.openExceptions}
              </span>
            )}
          </td>
          <td>{r.jobNumbers.join(', ') || '—'}</td>
          <td className="num">{formatMinutes(r.totalShiftMinutes)}</td>
          <td className="num" style={{ color: 'var(--ink-faint)' }}>
            {/* Mutually exclusive by construction: the auto-lunch only ever
                applies to a day with no clocked break at all. */}
            {r.autoLunchMinutes > 0 ? (
              <span title="No break was clocked; unpaid lunch deducted automatically">
                {r.autoLunchMinutes}m auto
              </span>
            ) : (
              formatMinutes(r.totalBreakMinutes)
            )}
          </td>
          <td className="num" style={{ fontWeight: 500, color: 'var(--ink)' }}>
            {r.paidHoursLabel}
          </td>
          <td>
            <span className={`mk ${markFor(r.status)}`}>{statusWord(r.status)}</span>
            {/* Alongside, not beneath: a `.sub` line overflowed the 30px
                ledger row and collided with the next row's rule. */}
            {r.odooIds.length > 0 && (
              <span className="beside">Odoo {r.odooIds.join(', ')}</span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

// --- grouping ---------------------------------------------------------------

interface EmployeeGroup {
  employeeId: string;
  employeeName: string;
  rows: TimesheetRow[];
  totalPaidMinutes: number;
}

function groupByEmployee(rows: readonly TimesheetRow[]): EmployeeGroup[] {
  const byEmployee = new Map<string, EmployeeGroup>();

  for (const r of rows) {
    const existing = byEmployee.get(r.employeeId);
    if (existing) {
      existing.rows.push(r);
      existing.totalPaidMinutes += r.totalPaidMinutes;
    } else {
      byEmployee.set(r.employeeId, {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        rows: [r],
        totalPaidMinutes: r.totalPaidMinutes,
      });
    }
  }

  const groups = [...byEmployee.values()];
  for (const g of groups) g.rows.sort((a, b) => a.workDate.localeCompare(b.workDate));
  return groups.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

// --- formatting -------------------------------------------------------------

const statusWord = (status: string): string =>
  ({
    draft: 'Draft',
    worker_confirmed: 'Confirmed',
    supervisor_approved: 'Approved',
    synced: 'Synced',
    locked: 'Locked',
  })[status] ?? status;

/* Five states, five marks, weight increasing — "further along" is legible
   before the word is read. */
const markFor = (status: string): string =>
  ({
    draft: 'mk-draft',
    worker_confirmed: 'mk-confirmed',
    supervisor_approved: 'mk-approved',
    synced: 'mk-synced',
    locked: 'mk-locked',
  })[status] ?? 'mk-setout';

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/* "Thu 06.08" — nobody reconciling payroll reads 2026-08-06 as a Thursday. */
function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.toLocaleDateString('en-AU', { weekday: 'short' });
  return `${day} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}
