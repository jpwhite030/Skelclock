'use client';

import { useState, useTransition } from 'react';

import { retryOne, runAll } from './server-actions';

/**
 * Retry one failed push.
 *
 * Reports the outcome inline rather than as a toast — someone working through
 * a list of failures needs to see which row succeeded, next to that row.
 */
export function RetryButton({ jobId }: { jobId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            setResult(await retryOne(jobId));
          });
        }}
      >
        {pending ? 'Retrying…' : 'Retry'}
      </button>
      {result && (
        <span className={`pill ${result.ok ? 'ok' : 'error'}`}>{result.message}</span>
      )}
    </span>
  );
}

/** Drains the whole due queue now, rather than waiting for the cron. */
export function RunAllButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button
        className="primary"
        disabled={pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            setResult(await runAll());
          });
        }}
      >
        {pending ? 'Syncing…' : 'Sync now'}
      </button>
      {result && (
        <span className={`pill ${result.ok ? 'ok' : 'error'}`}>{result.message}</span>
      )}
    </span>
  );
}
