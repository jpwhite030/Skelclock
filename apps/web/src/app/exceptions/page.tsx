/**
 * SHT 03 — EXCEPTIONS · a redline mark-up.
 *
 * There is no <table> anywhere on this screen, deliberately. Exceptions are
 * annotations about records, not records in a grid — and the guidance text is
 * an annotation about a row rather than a column of it.
 *
 * The previous build dropped an 80-character guidance sentence into an
 * unconstrained <td> and repeated it verbatim on every row of that type:
 * twelve missing clock-ins printed the same sentence twelve times in muted
 * grey. That is fixed structurally, by deleting the premise that this screen
 * is a table.
 *
 * Three groups, three arrangements, weight decreasing down the page. A bad
 * morning is physically tall; a clean day collapses to a short run of thin
 * grey lines. You read the shape of the page before you read a word.
 */

import { listExceptions, listStaleSuggestions, type ExceptionRow } from '@skelclock/server';

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
  stale_suggestion: 'Unconfirmed auto-clock',
};

/** What the office should actually do. One sentence, never a column. */
const GUIDANCE: Record<string, string> = {
  missing_clock_in: 'Ask the supervisor what time they started, then add the missing time.',
  missing_clock_out: 'Ask the supervisor what time they knocked off, then add the missing time.',
  outside_geofence: 'Check with the supervisor. The site coordinates may also need correcting.',
  overlapping_shift: 'The same hours are claimed twice. One of the two needs correcting.',
  very_long_shift: 'Usually a forgotten clock-out. Confirm it before it reaches payroll.',
  offline_event: 'No action. The times came from the device clock, as designed.',
  unassigned_job: 'Assign the job so the hours can be costed.',
  odoo_sync_failure: 'See Odoo sync for the error and the retry.',
  stale_suggestion: "Chase the worker — it's still sitting on their phone unconfirmed.",
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

  // Computed live, not stored — see listStaleSuggestions. Only relevant next
  // to 'open', the same status every one of these synthetic rows carries.
  if (status === 'open' || status === 'all') {
    rows.push(...(await listStaleSuggestions(db, { companyId: session.companyId })));
  }

  const high = rows.filter((r) => r.severity === 1);
  const medium = rows.filter((r) => r.severity === 2);
  const info = rows.filter((r) => r.severity === 3);

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Exceptions</h1>
        <span className="lbl no">SHT 03 / Mark-up</span>
      </div>

      <form className="spec" method="get">
        <label>
          Showing
          <select name="status" defaultValue={status}>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
        <span className="grow" />
        <button type="submit" className="btn">Apply</button>
      </form>

      {/* A. Three counts at three sizes on one baseline. The hierarchy is the
             size, not the colour — the urgent count is 9.2x the least urgent,
             and size survives every form of colour blindness. */}
      <div className="counts">
        <span className="counts__item">
          <span
            className="dsp fig counts__high"
            data-zero={high.length === 0 ? 'true' : undefined}
          >
            {high.length}
          </span>
          <span className="lbl">Chase today</span>
        </span>

        <span className="counts__rule" aria-hidden="true" />

        <span className="counts__item">
          <span
            className="dsp counts__med"
            data-zero={medium.length === 0 ? 'true' : undefined}
          >
            {medium.length}
          </span>
          <span className="lbl">Review at approval</span>
        </span>

        <span className="counts__rule" aria-hidden="true" />

        <span className="counts__item">
          <span className="counts__info">{info.length}</span>
          <span className="lbl">Info</span>
        </span>
      </div>

      {rows.length === 0 && (
        <p
          className="lead"
          style={{ color: 'var(--muted)', textAlign: 'center', padding: 'var(--lift) 0' }}
        >
          Nothing to chase. Every shift in this view looks clean.
        </p>
      )}

      {/* B. HIGH — full-width annotation blocks, generous, guidance hanging in
             the right margin on a leader line. */}
      {high.length > 0 && (
        <section className="markgroup">
          <div className="markgroup__hd">
            <span className="lbl" style={{ color: 'var(--cad-magenta)' }}>
              Chase today
            </span>
          </div>
          {high.map((r) => (
            <article key={r.id} className="mark">
              <span className="mark__glyph" aria-hidden="true" />
              <div className="mark__who">{r.employeeName ?? 'Unassigned'}</div>
              <div className="mark__meta">
                {TYPE_LABELS[r.type] ?? r.type}
                {r.workDate && <> · {formatDate(r.workDate)}</>} · {r.status}
              </div>
              <p className="mark__what">{r.message}</p>
              {GUIDANCE[r.type] && <p className="mark__todo">{GUIDANCE[r.type]}</p>}
            </article>
          ))}
        </section>
      )}

      {/* C. MEDIUM — a flat two-column grid at half the weight. The guidance
             appears once in the group header, not per item: same information,
             one twelfth of the ink. */}
      {medium.length > 0 && (
        <section className="markgroup">
          <div className="markgroup__hd">
            <span className="lbl" style={{ color: 'var(--cad-yellow)' }}>
              Review at approval
            </span>
            <span className="lbl" style={{ color: 'var(--faint)' }}>
              {[...new Set(medium.map((r) => GUIDANCE[r.type]).filter(Boolean))].join(' ')}
            </span>
          </div>
          <div className="medgrid">
            {medium.map((r) => (
              <div key={r.id} className="medgrid__item">
                <div className="medgrid__hd">
                  {r.employeeName ?? '—'}
                  {r.workDate && <> · {formatDate(r.workDate)}</>} ·{' '}
                  {TYPE_LABELS[r.type] ?? r.type}
                </div>
                <div className="medgrid__msg">{r.message}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* D. INFO — collapses to a single run-on line. Not a details element,
             not a table, not a list. */}
      {info.length > 0 && (
        <section className="markgroup">
          <p className="inforun">{summariseInfo(info)}</p>
        </section>
      )}

      {/* Severity minimap — a scroll-position indicator, not a duplicate of a
          column. It states nothing the page does not already say. */}
      {high.length + medium.length > 0 && (
        <div className="minimap" aria-hidden="true">
          {[...high, ...medium].map((r, i, all) => (
            <i
              key={r.id}
              data-sev={r.severity}
              style={{ top: `${((i + 0.5) / all.length) * 100}%` }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// --- formatting -------------------------------------------------------------

/**
 * "RECORDED OFFLINE x3 — Whitmore 04.08, Dvorak 05.08. No action; the times
 * came from the device clock, as designed."
 */
function summariseInfo(rows: readonly ExceptionRow[]): string {
  const byType = new Map<string, ExceptionRow[]>();
  for (const r of rows) {
    const bucket = byType.get(r.type);
    if (bucket) bucket.push(r);
    else byType.set(r.type, [r]);
  }

  return [...byType.entries()]
    .map(([type, items]) => {
      const who = items
        .map((r) => `${surname(r.employeeName)} ${r.workDate ? formatDate(r.workDate) : ''}`.trim())
        .join(', ');
      const label = (TYPE_LABELS[type] ?? type).toUpperCase();
      return `${label} ×${items.length} — ${who}. ${GUIDANCE[type] ?? ''}`;
    })
    .join('  ');
}

function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function surname(fullName: string | null): string {
  if (!fullName) return '—';
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : fullName;
}
