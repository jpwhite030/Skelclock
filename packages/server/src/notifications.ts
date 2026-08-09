/**
 * Outbound notifications: push nudges and the weekly emailed summary.
 *
 * One sweep, run from the same cron as the Odoo sync worker, covering the
 * three messages the system sends:
 *
 *   missing_clock_out  push   — still clocked on past site close (or 12h
 *                               with no hours configured). One per day.
 *   stale_suggestion   push   — an auto clock has sat unconfirmed >24h.
 *                               One per suggested event, ever.
 *   weekly_summary     email  — last week's hours, sent Monday morning
 *                               local time. One per employee per ISO week.
 *
 * Exactly-once is the notification_log table's unique constraint, not this
 * code being careful: a message claims its row first and only then sends,
 * and a failed send releases the claim so the next sweep retries.
 *
 * Senders are injected. Push goes to Expo's public push API; email defaults
 * to a log-only sender until a real provider (EMAIL_MODE=live + Resend key)
 * is configured — the machinery is identical either way, which is the same
 * "works without the external system" rule the ERP integration follows.
 */

import { one, type Db } from './db.js';
import { getWorkingNow } from './queries.js';

// --- senders -----------------------------------------------------------------

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export type PushSender = (messages: PushMessage[]) => Promise<void>;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /** Recorded in notification_log so "sent" can't be mistaken for "logged". */
  channel: 'email' | 'log';
  send: (message: EmailMessage) => Promise<void>;
}

/** Expo's push API — free, no credentials, addressed by the ExponentPushToken
 * each device registers at check-in. Chunked at Expo's documented limit. */
export const expoPushSender: PushSender = async (messages) => {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100).map((m) => ({
      to: m.to,
      title: m.title,
      body: m.body,
      data: m.data,
      sound: 'default',
    }));
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!response.ok) {
      throw new Error(`Expo push failed: ${response.status} ${await response.text()}`);
    }
  }
};

/** Dev default: the email is composed and logged, never sent. */
export const logEmailSender: EmailSender = {
  channel: 'log',
  send: async (message) => {
    console.log(`[email:log-only] to=${message.to} subject="${message.subject}"`);
  },
};

/** Resend (resend.com) — a plain REST call, no SDK. */
export function resendEmailSender(apiKey: string, from: string): EmailSender {
  return {
    channel: 'email',
    send: async (message) => {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
      });
      if (!response.ok) {
        throw new Error(`Resend failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}

/** Builds the email sender the environment asks for. */
export function emailSenderFromEnv(env: Record<string, string | undefined>): EmailSender {
  if (env.EMAIL_MODE === 'live' && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return resendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM);
  }
  return logEmailSender;
}

// --- local time --------------------------------------------------------------

interface LocalParts {
  /** YYYY-MM-DD in the company's timezone. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** ISO day of week, 1 = Monday. */
  isoDow: number;
}

function localParts(now: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dows: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // "24" is what en-CA emits for midnight with hour12: false.
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    isoDow: dows[parts.weekday!] ?? 1,
  };
}

/** The Monday starting the ISO week `weeksAgo` before the one containing `date`. */
function mondayOf(date: string, weeksAgo: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1) - weeksAgo * 7);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- the sweep ---------------------------------------------------------------

export interface SweepOptions {
  now?: Date;
  push?: PushSender;
  email?: EmailSender;
  /** Grace after site close before the nudge, minutes. */
  clockOutGraceMinutes?: number;
  /** Fallback shift length that triggers the nudge when no hours are set. */
  clockOutFallbackMinutes?: number;
}

export interface SweepResult {
  pushSent: number;
  emailsSent: number;
  failed: number;
}

export async function runNotificationSweep(db: Db, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const push = options.push ?? expoPushSender;
  const email = options.email ?? logEmailSender;
  const grace = options.clockOutGraceMinutes ?? 30;
  const fallback = options.clockOutFallbackMinutes ?? 12 * 60;

  const result: SweepResult = { pushSent: 0, emailsSent: 0, failed: 0 };

  const { rows: companies } = await db.query<{
    id: string;
    timezone: string;
    operating_hours_end: string | null;
  }>('select id, timezone, operating_hours_end from company');

  for (const company of companies) {
    const local = localParts(now, company.timezone);

    await sweepMissingClockOuts(db, { company, local, now, grace, fallback, push, result });
    await sweepStaleSuggestions(db, { companyId: company.id, push, result });
    await sweepWeeklySummaries(db, { company, local, email, result });
  }

  return result;
}

/** Claims the dedupe row. Null means another sweep already sent this. */
async function claim(
  db: Db,
  args: {
    companyId: string;
    employeeId: string | null;
    kind: string;
    dedupeKey: string;
    channel: string;
    detail?: Record<string, unknown>;
  },
): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `insert into notification_log (company_id, employee_id, kind, dedupe_key, channel, detail)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (company_id, kind, dedupe_key) do nothing
     returning id`,
    [args.companyId, args.employeeId, args.kind, args.dedupeKey, args.channel, JSON.stringify(args.detail ?? {})],
  );
  return row?.id ?? null;
}

async function release(db: Db, claimId: string): Promise<void> {
  await db.query('delete from notification_log where id = $1', [claimId]);
}

/** The freshest push token for an employee's most recently seen device. */
async function pushTokenFor(db: Db, employeeId: string): Promise<string | null> {
  const row = await one<{ push_token: string }>(
    db,
    `select d.push_token
       from device d
       join app_user u on u.id = d.app_user_id
      where u.employee_id = $1 and d.push_token is not null
      order by d.last_seen_at desc nulls last
      limit 1`,
    [employeeId],
  );
  return row?.push_token ?? null;
}

async function sweepMissingClockOuts(
  db: Db,
  args: {
    company: { id: string; timezone: string; operating_hours_end: string | null };
    local: LocalParts;
    now: Date;
    grace: number;
    fallback: number;
    push: PushSender;
    result: SweepResult;
  },
): Promise<void> {
  const { company, local, now, grace, fallback, push, result } = args;
  const working = await getWorkingNow(db, { companyId: company.id, now });

  for (const row of working) {
    // Which window applies is the same site-else-company resolution the
    // ingest refusal uses. No window at all -> the 12h fallback.
    let end = company.operating_hours_end;
    if (row.jobId) {
      const site = await one<{ operating_hours_end: string | null }>(
        db,
        `select s.operating_hours_end from job j join site s on s.id = j.site_id where j.id = $1`,
        [row.jobId],
      );
      end = site?.operating_hours_end ?? end;
    }

    // Measured from this shift's own clock-in, not "is `now` inside today's
    // window" — a fixed same-day window reads a legitimate 22:00-to-06:00
    // overnight shift as "past close" within minutes of starting, since
    // every hour from close-plus-grace to midnight falls outside it. Instead:
    // how many minutes from the clock-in itself to the next occurrence of the
    // closing time (wrapping past midnight exactly as an overnight shift
    // does), compared against how many minutes have actually elapsed.
    const pastClose = ((): boolean => {
      if (end == null || !row.clockInTime) return row.minutesWorked >= fallback;

      const clockInDate = new Date(row.clockInTime);
      const clockInLocalMinutes = localParts(clockInDate, company.timezone).minutes;
      const endMinutes = hmToMinutes(end);
      const minutesUntilClose =
        endMinutes > clockInLocalMinutes
          ? endMinutes - clockInLocalMinutes
          : 24 * 60 - clockInLocalMinutes + endMinutes;
      const elapsedMinutes = (now.getTime() - clockInDate.getTime()) / 60_000;
      return elapsedMinutes >= minutesUntilClose + grace;
    })();

    if (!pastClose) continue;

    const token = await pushTokenFor(db, row.employeeId);
    if (!token) continue;

    const claimId = await claim(db, {
      companyId: company.id,
      employeeId: row.employeeId,
      kind: 'missing_clock_out',
      dedupeKey: `${row.employeeId}:${local.date}`,
      channel: 'push',
      detail: { minutesWorked: row.minutesWorked, jobNumber: row.jobNumber },
    });
    if (!claimId) continue;

    try {
      await push([
        {
          to: token,
          title: 'Still clocked on?',
          body: `You've been on for ${Math.floor(row.minutesWorked / 60)}h ${row.minutesWorked % 60}m. If you've knocked off, open SkelClock and clock off so today's hours are right.`,
          data: { kind: 'missing_clock_out' },
        },
      ]);
      result.pushSent += 1;
    } catch {
      await release(db, claimId);
      result.failed += 1;
    }
  }
}

async function sweepStaleSuggestions(
  db: Db,
  args: { companyId: string; push: PushSender; result: SweepResult },
): Promise<void> {
  // Same 24-hour line the Exceptions screen draws (listStaleSuggestions),
  // queried directly because the nudge needs the ids that screen doesn't.
  const { rows: stale } = await db.query<{ id: string; employee_id: string }>(
    `select id, employee_id from attendance_event
      where company_id = $1
        and is_suggested = true
        and voided_at is null
        and device_time < now() - interval '24 hours'`,
    [args.companyId],
  );

  for (const s of stale) {
    const token = await pushTokenFor(db, s.employee_id);
    if (!token) continue;

    const claimId = await claim(db, {
      companyId: args.companyId,
      employeeId: s.employee_id,
      kind: 'stale_suggestion',
      dedupeKey: s.id,
      channel: 'push',
    });
    if (!claimId) continue;

    try {
      await args.push([
        {
          to: token,
          title: 'Confirm your clock',
          body: 'An automatic clock from yesterday is still waiting on you. Open SkelClock to confirm or dismiss it — until then it counts for nothing.',
          data: { kind: 'stale_suggestion', eventId: s.id },
        },
      ]);
      args.result.pushSent += 1;
    } catch {
      await release(db, claimId);
      args.result.failed += 1;
    }
  }
}

async function sweepWeeklySummaries(
  db: Db,
  args: {
    company: { id: string; timezone: string };
    local: LocalParts;
    email: EmailSender;
    result: SweepResult;
  },
): Promise<void> {
  const { company, local, email, result } = args;

  // Monday morning, local. The sweep runs every few minutes; the dedupe row
  // is what makes only the first pass after 06:00 send anything.
  if (local.isoDow !== 1 || local.minutes < 6 * 60) return;

  const weekStart = mondayOf(local.date, 1);
  const weekEnd = addDays(weekStart, 6);

  const { rows: employees } = await db.query<{ id: string; full_name: string; email: string }>(
    `select id, full_name, email from employee
      where company_id = $1 and active and email is not null`,
    [company.id],
  );

  for (const emp of employees) {
    const { rows: days } = await db.query<{
      work_date: string;
      total_paid_minutes: number;
      total_break_minutes: number;
      total_auto_lunch_minutes: number;
    }>(
      `select work_date::text, total_paid_minutes, total_break_minutes, total_auto_lunch_minutes
         from timesheet
        where employee_id = $1 and work_date between $2 and $3
        order by work_date`,
      [emp.id, weekStart, weekEnd],
    );
    if (days.length === 0) continue;

    const totalPaid = days.reduce((sum, d) => sum + d.total_paid_minutes, 0);

    const claimId = await claim(db, {
      companyId: company.id,
      employeeId: emp.id,
      kind: 'weekly_summary',
      dedupeKey: `${emp.id}:${weekStart}`,
      channel: email.channel,
      detail: { weekStart, totalPaidMinutes: totalPaid },
    });
    if (!claimId) continue;

    const lines = days.map((d) => {
      const lunch = d.total_auto_lunch_minutes > 0 ? ` (incl. ${d.total_auto_lunch_minutes}m auto lunch deduction)` : '';
      return `  ${d.work_date}  ${fmtHours(d.total_paid_minutes)} paid${lunch}`;
    });

    try {
      await email.send({
        to: emp.email,
        subject: `Your hours, week of ${weekStart} — ${fmtHours(totalPaid)}`,
        text: [
          `Hi ${emp.full_name.split(' ')[0]},`,
          '',
          `Here are the hours SkelClock recorded for you last week (${weekStart} to ${weekEnd}):`,
          '',
          ...lines,
          '',
          `Total paid: ${fmtHours(totalPaid)}`,
          '',
          'Something look wrong? Tell your supervisor before payroll runs — corrections are quick now and painful later.',
        ].join('\n'),
      });
      result.emailsSent += 1;
    } catch {
      await release(db, claimId);
      result.failed += 1;
    }
  }
}

// --- small helpers -----------------------------------------------------------

const hmToMinutes = (hm: string): number => {
  const [h, m] = hm.split(':');
  return Number(h) * 60 + Number(m);
};

const fmtHours = (minutes: number): string =>
  `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
