'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The rail foot — the drawing's datum block, and the live refresh.
 *
 * Replaces `<meta http-equiv="refresh" content="60">`, which was a hard
 * document reload: it lost scroll position and flashed the office wall screen
 * every minute. `router.refresh()` re-fetches the server components and swaps
 * the data in place, so a half-scrolled timesheet stays where it was.
 *
 * The countdown is information, not decoration, so it keeps running under
 * prefers-reduced-motion — only its colour change is not animated.
 */

const PERIOD_S = 30;

export function RailDatum() {
  const router = useRouter();
  const [now, setNow] = useState<Date | null>(null);
  const [left, setLeft] = useState(PERIOD_S);

  useEffect(() => {
    // Set on the client only. Rendering a clock on the server guarantees a
    // hydration mismatch, because the two run a few hundred ms apart.
    setNow(new Date());

    const tick = setInterval(() => {
      setNow(new Date());
      setLeft((remaining) => {
        if (remaining <= 1) {
          router.refresh();
          return PERIOD_S;
        }
        return remaining - 1;
      });
    }, 1000);

    return () => clearInterval(tick);
  }, [router]);

  return (
    <dl className="rail__foot">
      <dt>Datum</dt>
      <dd>{now ? formatDate(now) : '——.——.——'}</dd>
      <dd>{now ? formatTime(now) : '——:——:——'}</dd>
      <dd>AEST · UTC+10</dd>
      <dd className="next" data-soon={left <= 5 ? '' : undefined}>
        NEXT ── {String(Math.floor(left / 60)).padStart(2, '0')}:
        {String(left % 60).padStart(2, '0')}
      </dd>
    </dl>
  );
}

const pad = (n: number): string => String(n).padStart(2, '0');

const formatDate = (d: Date): string =>
  `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;

const formatTime = (d: Date): string =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
