/**
 * Segments -> hr.attendance blocks.
 *
 * Odoo's hr.attendance is a flat check_in/check_out pair and computes
 * worked_hours as the difference. Our day is finer grained than that: several
 * jobs, several activities, breaks. This collapses it.
 *
 * The rule that matters: an *unpaid* break splits the day into two attendance
 * records, so Odoo's worked_hours comes out equal to our paid hours. Pushing
 * one record spanning the whole day would hand payroll a number 30 minutes too
 * high every single day, and reconciling that by hand is precisely the job the
 * MVP is meant to remove.
 *
 * Job and activity detail is deliberately *not* squeezed in here — it has no
 * home on hr.attendance. It goes to account.analytic.line in Phase 2, which is
 * what the segment rows are already shaped for.
 */

import type { AttendanceBlock } from './adapter.js';

export interface SegmentForPush {
  id: string;
  segmentType: 'work' | 'travel' | 'break';
  startTime: string;
  endTime: string | null;
  isPaid: boolean;
}

export interface BuildBlocksResult {
  blocks: AttendanceBlock[];
  /** Segments left out, with the reason, so the sync log can say why. */
  skipped: Array<{ id: string; reason: string }>;
}

export function buildAttendanceBlocks(
  segments: readonly SegmentForPush[],
): BuildBlocksResult {
  const skipped: Array<{ id: string; reason: string }> = [];

  const usable = segments
    .filter((s) => {
      if (s.endTime === null) {
        skipped.push({ id: s.id, reason: 'segment is still open' });
        return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));

  const blocks: AttendanceBlock[] = [];
  let current: { localRef: string; checkIn: string; checkOut: string } | null = null;

  const flush = (): void => {
    if (!current) return;
    // Zero-length blocks are noise in Odoo and make worked_hours look odd.
    if (Date.parse(current.checkOut) > Date.parse(current.checkIn)) {
      blocks.push({ ...current });
    } else {
      skipped.push({ id: current.localRef, reason: 'block has zero duration' });
    }
    current = null;
  };

  for (const s of usable) {
    if (!s.isPaid) {
      // Unpaid time — close the block before it and resume after.
      flush();
      continue;
    }

    if (current === null) {
      current = { localRef: s.id, checkIn: s.startTime, checkOut: s.endTime! };
      continue;
    }

    // Contiguous paid time extends the open block. A gap in the record (an
    // event we never received) also closes it, rather than silently paying
    // for the missing minutes.
    if (Date.parse(s.startTime) === Date.parse(current.checkOut)) {
      current.checkOut = s.endTime!;
    } else {
      flush();
      current = { localRef: s.id, checkIn: s.startTime, checkOut: s.endTime! };
    }
  }

  flush();
  return { blocks, skipped };
}
