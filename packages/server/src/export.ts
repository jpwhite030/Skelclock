/**
 * Payroll export — the no-ERP path.
 *
 * The system's design position is that the client's ERP is the source of
 * truth and the Odoo push is the primary way hours leave here. This export
 * exists for the other case: a company with no ERP connected (or one not
 * live yet) runs payroll from a CSV instead. Same reads as the Timesheets
 * ledger, so what's exported is exactly what the office approved on screen —
 * and when an ERP is connected the export stays useful as a reconciliation
 * document, not a second source of truth.
 */

import { listTimesheets, type TimesheetFilter, type TimesheetRow } from './queries.js';
import { type Db } from './db.js';

/** Decimal hours with two places — what payroll tools expect, not "7h 36m". */
const hours = (minutes: number): string => (minutes / 60).toFixed(2);

const csvField = (value: string | number | null): string => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export interface TimesheetExport {
  filename: string;
  csv: string;
  rowCount: number;
}

export async function exportTimesheetsCsv(
  db: Db,
  filter: TimesheetFilter,
): Promise<TimesheetExport> {
  const rows = await listTimesheets(db, filter);

  // Employee numbers are the join key an accounting system actually wants —
  // names collide, numbers don't. One query, not one per row.
  const { rows: numberRows } = await db.query<{ id: string; employee_number: string | null }>(
    'select id, employee_number from employee where company_id = $1',
    [filter.companyId],
  );
  const numbers = new Map(numberRows.map((r) => [r.id, r.employee_number]));

  const header = [
    'Date',
    'Employee number',
    'Employee',
    'Jobs',
    'Shift hours',
    'Break hours',
    'Auto lunch minutes',
    'Paid hours',
    'Status',
    'Open exceptions',
    'Odoo attendance ids',
  ];

  const lines = [header.join(',')];
  for (const r of rows as TimesheetRow[]) {
    lines.push(
      [
        csvField(r.workDate),
        csvField(numbers.get(r.employeeId) ?? ''),
        csvField(r.employeeName),
        csvField(r.jobNumbers.join(' ')),
        csvField(hours(r.totalShiftMinutes)),
        csvField(hours(r.totalBreakMinutes)),
        csvField(r.autoLunchMinutes || ''),
        csvField(hours(r.totalPaidMinutes)),
        csvField(r.status),
        csvField(r.openExceptions || ''),
        csvField(r.odooIds.join(' ')),
      ].join(','),
    );
  }

  return {
    filename: `skelclock-timesheets-${filter.from}-to-${filter.to}.csv`,
    // CRLF endings per RFC 4180 — Excel on Windows is the audience here.
    csv: lines.join('\r\n') + '\r\n',
    rowCount: rows.length,
  };
}
