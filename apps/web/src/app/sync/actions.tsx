'use client';

import { useState, useTransition } from 'react';

import { retryOne, runAll } from './server-actions';

/**
 * Retry one failed push.
 *
 * A text action, not a boxed button. The busy state changes three things at
 * once — label, colour, and the bottom rule going dashed — so it is legible
 * without relying on colour.
 *
 * There is no disclosure here: the error is already on screen in the
 * always-open console sub-row directly beneath the row, which this button is
 * `aria-describedby`-linked to.
 */
export function RetryButton({ jobId }: { jobId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <>
      <button
        className="act"
        data-busy={pending ? '' : undefined}
        disabled={pending}
        aria-describedby={`err-${jobId}`}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            setResult(await retryOne(jobId));
          });
        }}
      >
        {pending ? 'Pushing…' : 'Retry'}
      </button>

      {/* Announced, not drawn — the row's own status mark is the visible
          outcome once the server action revalidates. */}
      <p role="status" aria-live="polite" className="sr-only">
        {result?.message ?? ''}
      </p>
    </>
  );
}

/** Drains the whole due queue now, rather than waiting for the cron. */
export function RunAllButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: 'inline-flex', gap: 'var(--r-4)', alignItems: 'baseline' }}>
      <button
        className="act"
        data-busy={pending ? '' : undefined}
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            setResult(await runAll());
          });
        }}
      >
        {pending ? 'Pushing…' : 'Run all'}
      </button>
      {result && (
        <span
          className="lbl"
          style={{ color: result.ok ? 'var(--cad-green)' : 'var(--cad-magenta)' }}
        >
          {result.message}
        </span>
      )}
    </span>
  );
}
