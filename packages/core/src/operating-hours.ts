/**
 * Operating-hours check, phone-side.
 *
 * The authoritative copy of this rule is checkOperatingHours in
 * packages/server/src/settings.ts, which converts the event's instant into
 * the company's timezone inside Postgres. This mirror exists so the phone can
 * refuse a clock-on at press time with the same answer the server would give
 * — which matters most offline: a 4am clock-in queued all day and rejected at
 * sync would silently cost the whole shift, because every event after it
 * fails "not clocked in" too.
 *
 * The device's own clock is trusted for "what time is it here", same doctrine
 * as device_time everywhere else: the phone is standing on the site, so its
 * local time is site local time.
 */

export interface OperatingHoursWindow {
  /** "HH:MM" or "HH:MM:SS". Null on either end means no restriction. */
  start: string | null;
  end: string | null;
}

const parseHM = (value: string): number | null => {
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export function minutesSinceLocalMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Start inclusive, end exclusive — matching the server's string comparison.
 * A window that closes earlier than it opens (22:00 → 06:00) wraps past
 * midnight rather than being an error, same as the server.
 */
export function isWithinOperatingHours(
  localMinutes: number,
  window: OperatingHoursWindow,
): boolean {
  if (!window.start || !window.end) return true;
  const start = parseHM(window.start);
  const end = parseHM(window.end);
  if (start === null || end === null) return true;
  // Equal start and end is 24 hours, not zero. start<=end below would read it
  // as "the window from X to X", which is never true — every clock-in would
  // be permanently refused for an admin who set matching times almost
  // certainly meaning "no restriction."
  if (start === end) return true;

  return start <= end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}
