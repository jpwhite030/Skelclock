/**
 * SHT 01 — WORKING NOW · a pictorial elevation.
 *
 * The wall screen, read from three metres. Dark ground.
 *
 * Three things make this screen unlike the other three: it is the only one
 * with a drawn diagram, the only one with a right-hand column, and the only
 * one whose stats are a mixed-size dimension run rather than a stat strip.
 *
 * "Good news is unlit" applies here — this is a glance screen. Three hundred
 * green "on site" pills would bury the four rows that are wrong, which is
 * exactly what the previous build did.
 */

import { getRosteredNotOn, getWorkingNow, listSites, type WorkingNowRow } from '@skelclock/server';

import { db } from '../lib/db';
import { getDashboardSession } from '../lib/session';
import { NoSession, SessionWarning } from '../components/session-state';
import { WorkingMapLoader } from './working-map-loader';

// Live shift state — never served from a cache. The rail's datum block
// re-fetches this every 30 seconds via router.refresh().
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function WorkingNowPage() {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const now = new Date();
  const workDate = localDate(now);

  const [rows, rosteredAll, sites] = await Promise.all([
    getWorkingNow(db, { companyId: session.companyId, now }),
    getRosteredNotOn(db, { companyId: session.companyId, workDate, now }),
    listSites(db, { companyId: session.companyId }),
  ]);

  // A night crew that started yesterday is rostered for today and has no
  // clock-in dated today, but is very much on the tools. Anyone Working Now
  // already lists is not absent.
  const onNow = new Set(rows.map((r) => r.employeeId));
  const rostered = rosteredAll.filter((r) => !onNow.has(r.employeeId));

  const working = rows.filter((r) => !r.onBreak).length;
  const onBreak = rows.filter((r) => r.onBreak).length;
  const offSite = rows.filter((r) => r.locationStatus === 'outside').length;
  const noGps = rows.filter((r) => r.locationStatus === 'unknown').length;

  const bays = buildBays(rows);

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Working now</h1>
        <span className="lbl no">SHT 01 / Elevation — live</span>
      </div>

      {/* A. Dimension line. No stat cards. The urgent number is physically
             larger, not merely recoloured. */}
      <div className="dimline">
        <div>
          <span className="dsp fig dimline__fig">{rows.length}</span>
          <span className="lbl dimline__figlbl">On the tools</span>
        </div>

        <div className="dimline__run">
          <Dim value={working} label="Working" />
          <Rule />
          <Dim value={onBreak} label="On break" />
          <Rule />
          <Dim value={offSite} label="Off-site" urgent={offSite > 0} />
          <Rule />
          <Dim value={noGps} label="No GPS" urgent={noGps > 0} />
        </div>
      </div>

      {/* B. Elevation band. Bay width is set by headcount off the real bay
             ladder, so a wider column genuinely means more people. */}
      {bays.length > 0 && (
        <div
          className="elev"
          role="img"
          aria-label={bays
            .map((b) => `${b.jobNumber ?? 'No job'}, ${b.people.length} on`)
            .join('. ')}
        >
          {bays.map((bay) => (
            <div
              key={bay.key}
              className="bay"
              style={{ width: bay.width }}
              data-narrow={bay.width <= 61 ? '' : undefined}
            >
              {/* People stack from the bottom up. Elevations build off the
                  ground. */}
              {[...bay.people].reverse().map((p) => (
                <div
                  key={p.employeeId}
                  className="bay__cell"
                  data-break={p.onBreak ? '' : undefined}
                  data-off={p.locationStatus === 'outside' ? '' : undefined}
                >
                  <span>{surname(p.employeeName)}</span>
                  <span>{p.hoursWorkedLabel.replace(' ', '')}</span>
                </div>
              ))}
              <div className="bay__ann">
                → {bay.bay} / {(bay.siteName ?? bay.jobNumber ?? '—').toUpperCase()} /{' '}
                {bay.people.length} ON
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="deck">
      {/* C. Six columns at table-layout:fixed. The previous build's nine
             pushed Location and Sync — the two actionable ones — off a 1080p
             monitor. */}
      <table className="sheet">
        <colgroup>
          <col style={{ width: '24%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '20%' }} />
          <col className="opt" style={{ width: '18%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Job</th>
            <th>On</th>
            <th className="num">Hours</th>
            <th>Location</th>
            <th className="opt">Sync</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr className="empty">
              <td colSpan={6}>
                Nobody is clocked on. This fills up as the crews start their day.
              </td>
            </tr>
          )}

          {rows.map((r) => (
            <tr
              key={r.employeeId}
              data-breach={r.locationStatus === 'outside' ? '' : undefined}
              data-hold={r.onBreak ? '' : undefined}
            >
              <td className="name">
                {r.employeeName}
                <span className="sub">
                  {r.onBreak ? 'On break' : [r.crewName, r.activityName].filter(Boolean).join(' · ') || '—'}
                </span>
              </td>
              <td>
                {r.jobNumber ?? <span className="mk mk-setout">No job</span>}
                {r.siteName && <span className="sub">{r.siteName}</span>}
              </td>
              <td>{formatTime(r.clockInTime)}</td>
              <td className="num">{r.hoursWorkedLabel}</td>
              <td>
                <Location status={r.locationStatus} distanceM={r.distanceM} />
              </td>
              <td className="opt">
                {/* Unlit on a glance screen — see "good news is unlit". The
                    office wants the rows that are wrong, and three hundred
                    green pills bury four magenta edges. */}
                <span className="mk-void">{syncWord(r.syncStatus)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* D. Rostered, not on. Starts one full lift below the table —
             deliberately misregistered — and bleeds past its last row with no
             closing rule. The only right-hand column in the app. */}
      {rostered.length > 0 && (
        <aside className="rostered">
          <div className="lbl rostered__k">Rostered, not on ({rostered.length})</div>
          <ul>
            {rostered.map((r) => (
              <li key={r.employeeId}>
                <span>{r.employeeName}</span>
                <span>{r.jobNumber ?? '—'}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
      </div>

      {/* E. The site plan. Only drawn when there is something to plot — an
             empty aerial photo is decoration, and this screen doesn't carry
             decoration. Positions are clock-event fixes, not tracking, and
             the caption says exactly that. */}
      {(rows.some((r) => r.lastLatitude != null) ||
        sites.some((s) => s.latitude != null)) && (
        <div className="working-map-block">
          <div className="lbl" style={{ padding: 'var(--r-4) 0' }}>
            Site plan — positions as recorded at each worker&apos;s last clock event
          </div>
          <WorkingMapLoader rows={rows} sites={sites} />
        </div>
      )}
    </main>
  );
}

// --- pieces -----------------------------------------------------------------

function Dim({
  value,
  label,
  urgent,
}: {
  value: number;
  label: string;
  urgent?: boolean;
}) {
  return (
    <span className="dimline__item" data-urgent={urgent ? '' : undefined}>
      <span className="dsp dimline__v">{value}</span>
      <span className="lbl dimline__k">{label}</span>
    </span>
  );
}

/* A drawn rule, not an em-dash character. */
const Rule = () => <span className="dimline__rule" aria-hidden="true" />;

function Location({
  status,
  distanceM,
}: {
  status: 'inside' | 'outside' | 'unknown';
  distanceM: number | null;
}) {
  if (status === 'outside') {
    // The number is the information — it reads as a distance, not a status
    // word. Position, colour and text all say the same thing, so it survives
    // colour blindness and survives being seen from the office door.
    return (
      <span className="mk mk-breach">
        {distanceM != null ? `${formatDistance(distanceM)} away` : 'Off site'}
      </span>
    );
  }
  if (status === 'unknown') return <span className="mk-void">No GPS</span>;
  return <span className="mk-void">On site</span>;
}

// --- the elevation band -----------------------------------------------------

interface Bay {
  key: string;
  jobNumber: string | null;
  siteName: string | null;
  people: WorkingNowRow[];
  width: number;
  bay: number;
}

/**
 * One column per active job, widths off the real Kwikstage bay ladder.
 *
 * This is the one place the metaphor does informational work: a wider column
 * genuinely means more people on that job, so the drawing *is* the data rather
 * than a theme laid over it.
 */
function buildBays(rows: readonly WorkingNowRow[]): Bay[] {
  const byJob = new Map<string, WorkingNowRow[]>();
  for (const r of rows) {
    const key = r.jobNumber ?? '—';
    const bucket = byJob.get(key);
    if (bucket) bucket.push(r);
    else byJob.set(key, [r]);
  }

  const bays = [...byJob.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([jobNumber, people]) => {
      const { width, bay } = bayFor(people.length);
      return {
        key: jobNumber,
        jobNumber: jobNumber === '—' ? null : jobNumber,
        siteName: people[0]?.siteName ?? null,
        people,
        width,
        bay,
      };
    });

  // Cap at eight; the drawing continues off-sheet and the table below carries
  // everything anyway.
  return bays.slice(0, 8);
}

function bayFor(headcount: number): { width: number; bay: number } {
  if (headcount >= 5) return { width: 195, bay: 2438 };
  if (headcount >= 3) return { width: 146, bay: 1829 };
  if (headcount === 2) return { width: 102, bay: 1270 };
  return { width: 61, bay: 762 };
}

// --- formatting -------------------------------------------------------------

function localDate(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m`;
}

/* The band cells are 61-195px wide. A surname fits; a full name does not. */
function surname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : fullName;
}

const syncWord = (status: string): string =>
  ({
    success: 'Sent',
    pending: 'Queued',
    running: 'Sending',
    failed: 'Failed',
    dead: 'Given up',
    not_queued: 'Not queued',
  })[status] ?? status;
