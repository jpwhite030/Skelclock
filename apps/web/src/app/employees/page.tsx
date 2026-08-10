/**
 * SHT 07 — EMPLOYEES · the crew list.
 *
 * Read-only on purpose. Employees are mastered in Odoo (see import.ts) and
 * nothing here creates or edits one — an "Add employee" button would be the
 * second employee list the whole integration exists to prevent.
 *
 * So this screen answers the questions the office actually asks about people,
 * which are mostly about the app rather than about employment: who has never
 * signed in, who has a login but has never clocked, who has gone quiet. Those
 * three are invisible in Odoo and were invisible here too.
 */

import { getWorkingNow, listEmployees, type EmployeeRow } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';
import { RoleControl, RoleSyncButton } from './role-control';

export const dynamic = 'force-dynamic';

/**
 * The tabs, in the order the office needs them.
 *
 * Deliberately not one tab per employment status — that is Odoo's job and it
 * already does it. These are cuts that only SkelClock can make, because they
 * are about whether the app is working for that person.
 */
const TABS = [
  { key: 'all', label: 'All' },
  { key: 'on_shift', label: 'On shift' },
  { key: 'no_login', label: 'No login' },
  { key: 'never_clocked', label: 'Never clocked' },
  { key: 'quiet', label: 'Gone quiet' },
  { key: 'inactive', label: 'Left' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function matchesTab(row: EmployeeRow, tab: TabKey, onShift: Set<string>): boolean {
  switch (tab) {
    case 'on_shift':
      return onShift.has(row.id);
    case 'no_login':
      return row.active && row.appState === 'no_login';
    case 'never_clocked':
      return row.active && row.appState === 'never_clocked';
    // Has clocked before, has a login, but nothing in the last fortnight.
    // A phone that stopped reporting looks exactly like a quiet week, and the
    // office would rather be told and dismiss it than not be told.
    case 'quiet':
      return row.active && row.appState === 'active' && row.daysWorkedRecently === 0;
    case 'inactive':
      return !row.active;
    case 'all':
    default:
      return true;
  }
}

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const params = await searchParams;
  const tab = (TABS.find((t) => t.key === params.tab)?.key ?? 'all') as TabKey;
  const query = (params.q ?? '').trim().toLowerCase();
  const crew = params.crew ?? '';

  const [rows, working] = await Promise.all([
    listEmployees(db, { companyId: session.companyId }),
    getWorkingNow(db, { companyId: session.companyId }),
  ]);

  const onShift = new Set(working.map((w) => w.employeeId));
  const crews = [...new Set(rows.map((r) => r.crewName).filter((c): c is string => !!c))].sort();

  const visible = rows.filter((r) => {
    if (!matchesTab(r, tab, onShift)) return false;
    if (crew && r.crewName !== crew) return false;
    if (!query) return true;
    // Number as well as name: the office knows people by both, and typing a
    // payroll number is faster than spelling a surname.
    return (
      r.fullName.toLowerCase().includes(query) ||
      (r.employeeNumber ?? '').toLowerCase().includes(query)
    );
  });

  const canEditRoles = session.role === 'admin';

  const counts = Object.fromEntries(
    TABS.map((t) => [t.key, rows.filter((r) => matchesTab(r, t.key, onShift)).length]),
  ) as Record<TabKey, number>;

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Employees</h1>
        <span className="lbl no">SHT 07 / Crew list</span>
      </div>

      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        Mastered in Odoo — names, numbers and who reports to whom all come from
        there, and this screen never writes back. What it adds is whether the app
        is actually working for each person.
      </p>

      {canEditRoles && <RoleSyncButton />}

      <form className="spec" method="get">
        <input type="hidden" name="tab" value={tab} />
        <span>Find</span>
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Name or number"
          aria-label="Search by name or employee number"
        />
        <span className="sep">·</span>
        <label>
          Crew
          <select name="crew" defaultValue={crew}>
            <option value="">All</option>
            {crews.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit">
          Apply
        </button>
      </form>

      <div className="emp-tabs">
        {TABS.map((t) => {
          const href = new URLSearchParams();
          href.set('tab', t.key);
          if (params.q) href.set('q', params.q);
          if (crew) href.set('crew', crew);
          return (
            <a
              key={t.key}
              className="site-chip"
              data-off={t.key === tab ? undefined : ''}
              href={`/employees?${href.toString()}`}
            >
              {t.label}
              <span className="site-chip__n">{counts[t.key]}</span>
            </a>
          );
        })}
      </div>

      <div className="panel">
        <table className="sheet">
          <thead>
            {/* One thing per column. `.sheet td` clips with an ellipsis, so a
                badge sitting inside the name cell is invisible by design — it
                needs its own column or it does not exist. */}
            <tr>
              <th>Name</th>
              <th />
              <th>No.</th>
              <th>Crew</th>
              <th>Reports to</th>
              <th>Access</th>
              <th className="num">Days / 14</th>
              <th>Last clock</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} data-hold={onShift.has(r.id) ? '' : undefined}>
                <td className="name">{r.fullName}</td>
                <td>
                  {onShift.has(r.id) && <span className="mk mk-approved">On shift</span>}
                  {!r.active && <span className="mk mk-setout">Left</span>}
                </td>
                <td>{r.employeeNumber ?? '—'}</td>
                <td>{r.crewName ?? '—'}</td>
                <td>{r.supervisorName ?? '—'}</td>
                <td>
                  {canEditRoles && r.appUserId ? (
                    <RoleControl
                      appUserId={r.appUserId}
                      role={r.role ?? 'worker'}
                      roleSource={r.roleSource}
                      name={r.fullName}
                    />
                  ) : (
                    <AccessCell row={r} />
                  )}
                </td>
                <td className="num">{r.daysWorkedRecently}</td>
                <td>{formatWhen(r.lastClockAt)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: 'var(--faint)' }}>
                  Nobody matches. Try another tab, or clear the search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/**
 * Whether this person can actually use the app, which is a different question
 * from what their role is. A supervisor who has never signed in is not a
 * working supervisor, and the role alone would say otherwise.
 */
function AccessCell({ row }: { row: EmployeeRow }) {
  if (row.appState === 'no_login') {
    return <span style={{ color: 'var(--cad-yellow)' }}>No login</span>;
  }
  if (row.appState === 'never_clocked') {
    return <span style={{ color: 'var(--cad-yellow)' }}>Never clocked</span>;
  }
  return <span style={{ color: 'var(--muted)' }}>{row.role ?? 'worker'}</span>;
}

/** Relative for anything recent, because "3 days ago" is the shape of the
 * question; an absolute date once it is old enough that the day matters. */
function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return then.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: '2-digit' });
}
