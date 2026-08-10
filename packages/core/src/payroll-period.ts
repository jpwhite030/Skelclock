/**
 * Payroll periods — which week, or which fortnight, a day belongs to.
 *
 * Everything here works on plain `YYYY-MM-DD` local dates rather than
 * instants, on purpose. A payroll period is a run of calendar days in the
 * company's own timezone, and the moment you represent that as a pair of
 * timestamps you have to decide what "start of Monday" means during a DST
 * change — a question payroll does not have and should not be made to answer.
 * The caller converts to instants at the edge, once, where the timezone is
 * already known.
 *
 * A fortnight is not derivable. Two companies both paying fortnightly can be
 * a week out of step with each other, so the boundary has to come from a
 * recorded anchor rather than from arithmetic on the epoch — which is why
 * `payroll_anchor_date` is a required column for a fortnightly company (see
 * migration 0008) instead of something each screen works out for itself.
 */

export type PayrollPeriodKind = 'weekly' | 'fortnightly';

export interface PayrollPeriodSettings {
  period: PayrollPeriodKind;
  /** ISO day numbering: 1 = Monday … 7 = Sunday. */
  weekStartsOn: number;
  /** `YYYY-MM-DD` in a period-one week. Required when fortnightly. */
  anchorDate: string | null;
}

export interface PayrollPeriod {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive — the last day worked, not the next boundary. */
  end: string;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → a UTC midnight instant. UTC throughout so the arithmetic
 * below never crosses a daylight-saving boundary; these are calendar days,
 * not times of day. */
function toUtc(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday … 7 = Sunday. `getUTCDay` counts from Sunday = 0. */
function isoDayOfWeek(ms: number): number {
  return ((new Date(ms).getUTCDay() + 6) % 7) + 1;
}

/** The most recent `weekStartsOn` on or before `ms`. */
function weekStart(ms: number, weekStartsOn: number): number {
  const back = (isoDayOfWeek(ms) - weekStartsOn + 7) % 7;
  return ms - back * DAY_MS;
}

/**
 * The period containing `date`.
 *
 * Weekly is just the containing week. Fortnightly counts whole weeks from the
 * anchor's own week start and pairs them up — `Math.floor` on a negative
 * difference is what makes a date *before* the anchor land in the right half
 * rather than rounding toward zero and skipping a fortnight.
 *
 * A fortnightly company with no anchor falls back to weekly rather than
 * throwing. The constraint in 0008 means that state should not exist, and a
 * timesheet screen that renders a slightly wrong range beats one that crashes
 * on a row of data somebody has to go and fix.
 */
export function payrollPeriodFor(date: string, settings: PayrollPeriodSettings): PayrollPeriod {
  const start = weekStart(toUtc(date), settings.weekStartsOn);

  if (settings.period === 'weekly' || !settings.anchorDate) {
    return { start: toIso(start), end: toIso(start + 6 * DAY_MS) };
  }

  const anchor = weekStart(toUtc(settings.anchorDate), settings.weekStartsOn);
  const weeksFromAnchor = Math.round((start - anchor) / (7 * DAY_MS));
  const offsetWeeks = ((weeksFromAnchor % 2) + 2) % 2;
  const periodStart = start - offsetWeeks * 7 * DAY_MS;

  return { start: toIso(periodStart), end: toIso(periodStart + 13 * DAY_MS) };
}

/** The period `n` periods before the one containing `date` (0 = that one). */
export function payrollPeriodBefore(
  date: string,
  settings: PayrollPeriodSettings,
  n: number,
): PayrollPeriod {
  const current = payrollPeriodFor(date, settings);
  const lengthDays = settings.period === 'fortnightly' && settings.anchorDate ? 14 : 7;
  const shifted = toUtc(current.start) - n * lengthDays * DAY_MS;
  return payrollPeriodFor(toIso(shifted), settings);
}

/** The most recent `count` periods, newest first — the shape a period picker
 * wants. */
export function recentPayrollPeriods(
  date: string,
  settings: PayrollPeriodSettings,
  count: number,
): PayrollPeriod[] {
  const out: PayrollPeriod[] = [];
  for (let n = 0; n < count; n++) out.push(payrollPeriodBefore(date, settings, n));
  return out;
}

/** Whether a `YYYY-MM-DD` falls inside a period. Both ends inclusive. */
export function isInPayrollPeriod(date: string, period: PayrollPeriod): boolean {
  return date >= period.start && date <= period.end;
}
