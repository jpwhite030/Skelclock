/**
 * SHT 08 — PROJECTS · the job board.
 *
 * Jobs existed only as a dropdown on the Timesheets filter. You could book
 * time to one and never look at one.
 *
 * A card rather than a table row, because the questions here are not
 * comparative. Nobody scans jobs looking for the largest number; they look at
 * one job and ask whether it is set up and whether anyone is on it. Three
 * facts answer that — is there a fence, has anyone booked time this fortnight,
 * is anyone standing there now — and all three were previously spread across
 * three screens.
 *
 * Read-only. Jobs are mastered in Odoo (import.ts); the site pin is the one
 * thing SkelClock owns, so that is the only thing a card links out to.
 */

import Link from 'next/link';

import {
  getWorkingNow,
  listProjects,
  projectHealth,
  type ProjectCard,
  type ProjectHealth,
} from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';
import { NoSession, SessionWarning } from '../../components/session-state';

export const dynamic = 'force-dynamic';

/* The CAD legend again, and for the same reasons it means what it means on the
   site map: green is boards down and someone is standing on it, yellow is
   still in hand — the office owes this job a pin — steel is set and quiet. */
const HEALTH: Record<ProjectHealth, { label: string; colour: string; hint: string }> = {
  working: { label: 'Working', colour: 'var(--cad-green)', hint: 'Time booked in the last fortnight.' },
  idle: { label: 'Idle', colour: 'var(--steel-lit)', hint: 'Set up, but nothing booked in a fortnight.' },
  no_pin: {
    label: 'No pin',
    colour: 'var(--cad-yellow)',
    hint: 'The site has no coordinates, so there is no fence and no automatic clock-on.',
  },
  no_site: {
    label: 'No site',
    colour: 'var(--cad-magenta)',
    hint: 'No site record at all — this job cannot be geofenced or reported on by location.',
  },
  closed: { label: 'Closed', colour: 'var(--faintest)', hint: 'Odoo has this finished or on hold.' },
};

const ORDER: ProjectHealth[] = ['no_site', 'no_pin', 'working', 'idle', 'closed'];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const params = await searchParams;
  const query = (params.q ?? '').trim().toLowerCase();
  const only = params.health ?? '';

  const [cards, working] = await Promise.all([
    listProjects(db, { companyId: session.companyId }),
    getWorkingNow(db, { companyId: session.companyId }),
  ]);

  const onNow = new Map<string, number>();
  for (const row of working) {
    if (row.jobId) onNow.set(row.jobId, (onNow.get(row.jobId) ?? 0) + 1);
  }

  const withHealth = cards.map((c) => ({
    card: c,
    onSiteNow: onNow.get(c.id) ?? 0,
    health: projectHealth(c, onNow.get(c.id) ?? 0),
  }));

  const counts = Object.fromEntries(
    ORDER.map((h) => [h, withHealth.filter((w) => w.health === h).length]),
  ) as Record<ProjectHealth, number>;

  const visible = withHealth.filter((w) => {
    if (only && w.health !== only) return false;
    if (!query) return true;
    return (
      w.card.jobNumber.toLowerCase().includes(query) ||
      (w.card.customerName ?? '').toLowerCase().includes(query) ||
      (w.card.siteName ?? '').toLowerCase().includes(query)
    );
  });

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">Projects</h1>
        <span className="lbl no">SHT 08 / Job board</span>
      </div>

      <p className="lead" style={{ color: 'var(--muted)', maxWidth: '62ch' }}>
        Jobs come from Odoo. What SkelClock adds is whether each one is set up to
        be clocked against — a job with no pin cannot raise an automatic
        clock-on, and nothing else in the app says so.
      </p>

      <form className="spec" method="get">
        <span>Find</span>
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Job, customer or site"
          aria-label="Search jobs"
        />
        <button className="btn" type="submit">
          Apply
        </button>
      </form>

      <div className="emp-tabs">
        <a className="site-chip" data-off={only ? '' : undefined} href="/projects">
          All<span className="site-chip__n">{cards.length}</span>
        </a>
        {ORDER.map((h) => (
          <a
            key={h}
            className="site-chip"
            data-off={only === h ? undefined : ''}
            href={`/projects?health=${h}${params.q ? `&q=${encodeURIComponent(params.q)}` : ''}`}
            title={HEALTH[h].hint}
          >
            <span className="site-chip__dot" style={{ background: HEALTH[h].colour }} aria-hidden="true" />
            {HEALTH[h].label}
            <span className="site-chip__n">{counts[h]}</span>
          </a>
        ))}
      </div>

      <div className="job-grid">
        {visible.map(({ card, health, onSiteNow }) => (
          <JobCard key={card.id} card={card} health={health} onSiteNow={onSiteNow} />
        ))}
        {visible.length === 0 && (
          <div className="panel empty">No jobs match. Clear the search, or pick another filter.</div>
        )}
      </div>
    </main>
  );
}

function JobCard({
  card,
  health,
  onSiteNow,
}: {
  card: ProjectCard;
  health: ProjectHealth;
  onSiteNow: number;
}) {
  const meta = HEALTH[health];

  return (
    <article className="job-card" style={{ borderLeftColor: meta.colour }}>
      <header className="job-card__head">
        <span className="job-card__no">{card.jobNumber}</span>
        <span className="lbl" style={{ color: meta.colour }}>
          {meta.label}
        </span>
      </header>

      {card.customerName && <p className="job-card__customer">{card.customerName}</p>}

      {/* The site line is the one thing on this card SkelClock owns, so it is
          the one thing that links out — straight to where the pin gets fixed. */}
      <p className="job-card__site">
        {card.siteId ? (
          <Link href={`/sites/${card.siteId}`}>{card.siteName ?? 'Unnamed site'}</Link>
        ) : (
          <span style={{ color: 'var(--cad-magenta)' }}>No site record</span>
        )}
        {card.siteAddress && <span className="job-card__addr">{card.siteAddress}</span>}
      </p>

      {/* Says what is wrong and what to do, rather than only colouring the
          edge and leaving the office to work out which of five things it is. */}
      {(health === 'no_pin' || health === 'no_site') && (
        <p className="job-card__warn">{meta.hint}</p>
      )}

      {/* "Last 14 days" said once, as a caption, rather than smuggled into a
          column header where it made the label wrap and pushed "65h 06m" onto
          two lines. */}
      <div>
        <dl className="job-card__stats">
          <Stat k="On now" v={String(onSiteNow)} lit={onSiteNow > 0} />
          <Stat k="Hours" v={formatHours(card.minutesRecently)} />
          <Stat k="People" v={String(card.peopleRecently)} />
          <Stat k="Days" v={String(card.daysRecently)} />
        </dl>
        <p className="job-card__since">On now, and the last 14 days</p>
      </div>

      <footer className="job-card__foot">
        <span>
          {card.startsOn ? `${card.startsOn}${card.endsOn ? ` → ${card.endsOn}` : ' →'}` : 'No dates'}
        </span>
        <span>{card.lastActivityAt ? `Last clock ${formatWhen(card.lastActivityAt)}` : 'Never clocked'}</span>
      </footer>
    </article>
  );
}

function Stat({ k, v, lit }: { k: string; v: string; lit?: boolean }) {
  return (
    <div className="job-card__stat">
      <dt className="lbl">{k}</dt>
      <dd className="dim" style={lit ? { color: 'var(--cad-green)' } : undefined}>
        {v}
      </dd>
    </div>
  );
}

/** Whole hours only. A card is a glance, and "65h" answers it as well as
 * "65h 06m" while fitting in a quarter of a card. The exact figure is on the
 * timesheet, which is where anyone reconciling it is going to be anyway. */
function formatHours(minutes: number): string {
  if (minutes <= 0) return '0h';
  return `${Math.round(minutes / 60)}h`;
}

function formatWhen(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}
