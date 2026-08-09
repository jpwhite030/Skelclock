/**
 * GET /timesheets/export — the pay-period ledger as a CSV download.
 *
 * A route handler rather than a server action because the response *is* the
 * file: same session cookie, same filters as SHT 02 (the form submits here
 * unchanged via formAction), same rows — just with decimal hours and CRLF
 * endings for the payroll spreadsheet. See packages/server/src/export.ts for
 * why this exists alongside the Odoo push.
 */

import { exportTimesheetsCsv } from '@skelclock/server';

import { db } from '../../../lib/db';
import { getDashboardSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const session = await getDashboardSession();
  if (!session || (session.role !== 'admin' && session.role !== 'supervisor')) {
    return new Response('Sign in with an office account to export timesheets.', { status: 403 });
  }

  const params = new URL(request.url).searchParams;

  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
  const from = params.get('from') || defaultFrom;
  const to = params.get('to') || today.toISOString().slice(0, 10);

  const { filename, csv } = await exportTimesheetsCsv(db, {
    companyId: session.companyId,
    from,
    to,
    employeeId: params.get('employee') || undefined,
    crewId: params.get('crew') || undefined,
    jobId: params.get('job') || undefined,
    status: params.get('status') || undefined,
  });

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
