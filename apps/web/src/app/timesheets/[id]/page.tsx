/**
 * Timesheet detail — correct, void, or add an event.
 *
 * Office-only, same as the rest of the dashboard. A supervisor sees and edits
 * only their own reports' days; an admin sees and edits anyone's. Corrections
 * and additions go straight through — no pending/approve step — because that
 * is what the role boundary already is: only someone with the authority to
 * act on this employee's hours can reach this page for them at all.
 */

import { canManageEmployee, getTimesheetDetail } from '@skelclock/server';

import { db } from '../../../lib/db';
import { getDashboardSession } from '../../../lib/session';
import { NoSession, SessionWarning } from '../../../components/session-state';
import { TimesheetDetailClient } from './timesheet-detail-client';

export const dynamic = 'force-dynamic';

export default async function TimesheetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getDashboardSession();
  if (!session) return <NoSession />;

  const { id } = await params;
  const detail = await getTimesheetDetail(db, { companyId: session.companyId, timesheetId: id });

  if (!detail) {
    return (
      <main>
        <SessionWarning session={session} />
        <div className="sht">
          <h1 className="dsp">Not found</h1>
          <span className="lbl no">SHT 02a / Correction</span>
        </div>
        <p className="lead" style={{ color: 'var(--muted)' }}>
          That timesheet doesn&apos;t exist, or isn&apos;t in your company.
        </p>
      </main>
    );
  }

  const canView =
    session.role === 'admin' ||
    (session.role === 'supervisor' &&
      (await canManageEmployee(db, {
        role: session.role,
        callerEmployeeId: session.employeeId,
        targetEmployeeId: detail.timesheet.employeeId,
      })));

  if (!canView) {
    return (
      <main>
        <SessionWarning session={session} />
        <div className="sht">
          <h1 className="dsp">Not your report</h1>
          <span className="lbl no">SHT 02a / Correction</span>
        </div>
        <p className="lead" style={{ color: 'var(--muted)' }}>
          {detail.timesheet.employeeName} isn&apos;t one of your reports.
        </p>
      </main>
    );
  }

  const [jobs, activities] = await Promise.all([
    db.query<{ id: string; job_number: string }>(
      `select id, job_number from job where company_id = $1
        and status in ('active','on_hold') order by job_number`,
      [session.companyId],
    ),
    db.query<{ id: string; name: string }>(
      'select id, name from work_activity where company_id = $1 and active order by sort_order, name',
      [session.companyId],
    ),
  ]);

  const t = detail.timesheet;

  return (
    <main>
      <SessionWarning session={session} />

      <div className="sht">
        <h1 className="dsp">{t.employeeName}</h1>
        <span className="lbl no">SHT 02a / Correction — {formatDate(t.workDate)}</span>
        <span className={`mk ${markFor(t.status)}`}>{statusWord(t.status)}</span>
      </div>

      {/* The numbers the corrections below actually move. Rebuilt (and this
          page revalidated) after every save, so a supervisor sees what an
          edit did to the day without leaving the screen. */}
      <div className="setout-counts">
        <span className="counts__item">
          <span className="dsp dim">{formatMinutes(t.totalShiftMinutes)}</span>
          <span className="lbl">Shift</span>
        </span>
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span className="dsp dim">{formatMinutes(t.totalBreakMinutes)}</span>
          <span className="lbl">Break</span>
        </span>
        {t.autoLunchMinutes > 0 && (
          <>
            <span className="counts__rule" aria-hidden="true" />
            <span className="counts__item">
              <span className="dsp dim" style={{ color: 'var(--cad-yellow)' }}>
                {formatMinutes(t.autoLunchMinutes)}
              </span>
              <span className="lbl">Auto lunch</span>
            </span>
          </>
        )}
        <span className="counts__rule" aria-hidden="true" />
        <span className="counts__item">
          <span className="dsp dim">{formatMinutes(t.totalPaidMinutes)}</span>
          <span className="lbl">Paid</span>
        </span>
      </div>

      <TimesheetDetailClient
        timesheet={t}
        events={detail.events}
        jobs={jobs.rows.map((r) => ({ id: r.id, jobNumber: r.job_number }))}
        activities={activities.rows}
      />
    </main>
  );
}

const statusWord = (status: string): string =>
  ({
    draft: 'Draft',
    worker_confirmed: 'Confirmed',
    supervisor_approved: 'Approved',
    synced: 'Synced',
    locked: 'Locked',
  })[status] ?? status;

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

function formatDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.toLocaleDateString('en-AU', { weekday: 'short' });
  return `${day} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
