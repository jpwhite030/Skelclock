/**
 * Company payroll settings.
 *
 * Auto-lunch and travel allocation change how a day is *built*
 * (packages/core/src/segments.ts), and operating hours change whether a
 * clock is *accepted* at all (ingest.ts) — not just how either is displayed.
 * Every caller that builds or ingests a day loads this once and threads it
 * through, rather than each place guessing at company policy on its own.
 */

import type { TravelAllocation } from '@skelclock/core';

import { oneOrFail, type Db } from './db.js';

export type { TravelAllocation };

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface CompanySettings {
  companyId: string;
  timezone: string;
  autoLunchEnabled: boolean;
  autoLunchThresholdMinutes: number;
  autoLunchDurationMinutes: number;
  travelAllocation: TravelAllocation;
  /** "HH:MM:SS", local to `timezone`. Null on either end means no restriction. */
  operatingHoursStart: string | null;
  operatingHoursEnd: string | null;
}

function toSettings(r: {
  id: string;
  timezone: string;
  auto_lunch_enabled: boolean;
  auto_lunch_threshold_minutes: number;
  auto_lunch_duration_minutes: number;
  travel_allocation: string;
  operating_hours_start: string | null;
  operating_hours_end: string | null;
}): CompanySettings {
  return {
    companyId: r.id,
    timezone: r.timezone,
    autoLunchEnabled: r.auto_lunch_enabled,
    autoLunchThresholdMinutes: r.auto_lunch_threshold_minutes,
    autoLunchDurationMinutes: r.auto_lunch_duration_minutes,
    travelAllocation: r.travel_allocation as TravelAllocation,
    operatingHoursStart: r.operating_hours_start,
    operatingHoursEnd: r.operating_hours_end,
  };
}

/** segments.ts options derived from company payroll settings — shared by
 * every read model that builds a day (getWorkerHome, getWorkingNow,
 * rebuildTimesheet), so none of them can disagree about what auto-lunch or
 * travel policy did to a shift. */
export async function payrollSegmentOptions(
  db: Db,
  companyId: string,
): Promise<{
  travelAllocation: TravelAllocation;
  autoLunch: { thresholdMinutes: number; durationMinutes: number } | null;
}> {
  const settings = await getCompanySettings(db, companyId);
  return {
    travelAllocation: settings.travelAllocation,
    autoLunch: settings.autoLunchEnabled
      ? {
          thresholdMinutes: settings.autoLunchThresholdMinutes,
          durationMinutes: settings.autoLunchDurationMinutes,
        }
      : null,
  };
}

export async function getCompanySettings(db: Db, companyId: string): Promise<CompanySettings> {
  const row = await oneOrFail<Parameters<typeof toSettings>[0]>(
    db,
    `select id, timezone, auto_lunch_enabled, auto_lunch_threshold_minutes,
            auto_lunch_duration_minutes, travel_allocation,
            operating_hours_start, operating_hours_end
       from company where id = $1`,
    [companyId],
    'Company',
  );
  return toSettings(row);
}

export interface UpdateCompanySettingsInput {
  companyId: string;
  autoLunchEnabled: boolean;
  autoLunchThresholdMinutes: number;
  autoLunchDurationMinutes: number;
  travelAllocation: TravelAllocation;
  /** "HH:MM" from a <input type="time">; null clears the restriction. */
  operatingHoursStart: string | null;
  operatingHoursEnd: string | null;
}

export async function updateCompanySettings(
  db: Db,
  input: UpdateCompanySettingsInput,
): Promise<CompanySettings> {
  if (input.autoLunchThresholdMinutes <= 0 || input.autoLunchDurationMinutes <= 0) {
    throw new SettingsError('Auto-lunch threshold and duration must both be greater than zero.');
  }
  if ((input.operatingHoursStart == null) !== (input.operatingHoursEnd == null)) {
    throw new SettingsError('Operating hours need both a start and an end, or neither.');
  }

  const row = await oneOrFail<Parameters<typeof toSettings>[0]>(
    db,
    `update company
        set auto_lunch_enabled = $2,
            auto_lunch_threshold_minutes = $3,
            auto_lunch_duration_minutes = $4,
            travel_allocation = $5,
            operating_hours_start = $6,
            operating_hours_end = $7
      where id = $1
      returning id, timezone, auto_lunch_enabled, auto_lunch_threshold_minutes,
                auto_lunch_duration_minutes, travel_allocation,
                operating_hours_start, operating_hours_end`,
    [
      input.companyId,
      input.autoLunchEnabled,
      input.autoLunchThresholdMinutes,
      input.autoLunchDurationMinutes,
      input.travelAllocation,
      input.operatingHoursStart,
      input.operatingHoursEnd,
    ],
    'Company',
  );
  return toSettings(row);
}

export interface OperatingHoursCheck {
  allowed: boolean;
  message: string;
}

/**
 * Whether a clock-in at this instant is inside operating hours — site
 * override if the job's site has one, else the company default, else no
 * restriction at all. Time-of-day is computed in Postgres against the
 * company's IANA timezone (`at time zone`), not hand-rolled in JS, so AEST/
 * AEDT and any other DST transition are exactly as correct as the server's
 * own tzdata rather than a second copy of that logic to keep in sync.
 *
 * Handles an overnight window (e.g. 22:00-06:00) by wrapping: allowed when
 * the local time is at or after start OR before end.
 */
export async function checkOperatingHours(
  db: Db,
  args: {
    companyId: string;
    deviceTime: string;
    /** The job's site override, if any. Undefined/null both mean "none". */
    siteHoursStart?: string | null;
    siteHoursEnd?: string | null;
  },
): Promise<OperatingHoursCheck> {
  const row = await oneOrFail<{
    operating_hours_start: string | null;
    operating_hours_end: string | null;
    local_time: string;
  }>(
    db,
    `select operating_hours_start, operating_hours_end,
            ($2::timestamptz at time zone timezone)::time::text as local_time
       from company where id = $1`,
    [args.companyId, args.deviceTime],
    'Company',
  );

  const start = args.siteHoursStart ?? row.operating_hours_start;
  const end = args.siteHoursEnd ?? row.operating_hours_end;
  // Equal start and end is 24 hours, not zero — see the identical guard and
  // its reasoning in packages/core/src/operating-hours.ts, the phone-side
  // mirror of this exact check.
  if (!start || !end || start === end) return { allowed: true, message: '' };

  const withinHours =
    start <= end
      ? row.local_time >= start && row.local_time < end
      : row.local_time >= start || row.local_time < end; // overnight wrap

  return {
    allowed: withinHours,
    message: withinHours
      ? ''
      : `Clock-in is only accepted between ${start.slice(0, 5)} and ${end.slice(0, 5)}.`,
  };
}
