'use client';

/**
 * The two verbs an exception row offers.
 *
 * Acknowledge is one tap — it means "seen, being chased" and moves the row
 * out of the default Open view. Resolve demands a note via prompt, because a
 * resolution with no story is exactly the audit hole this system exists to
 * close. Reopen appears only on non-open rows, for the change of mind.
 */

import { useState, useTransition } from 'react';

import { actOnException } from './server-actions';

export function ExceptionActions({
  exceptionId,
  status,
}: {
  exceptionId: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const run = (action: 'acknowledge' | 'resolve' | 'reopen', note?: string) =>
    startTransition(async () => {
      const result = await actOnException({ exceptionId, action, note });
      setMessage(result.ok ? null : result.message);
    });

  return (
    <span className="exc-actions">
      {status === 'open' && (
        <button className="act" disabled={pending} onClick={() => run('acknowledge')}>
          Acknowledge
        </button>
      )}
      {status !== 'resolved' && (
        <button
          className="act"
          disabled={pending}
          onClick={() => {
            const note = window.prompt('How was this resolved? (kept as the audit note)');
            if (note?.trim()) run('resolve', note.trim());
          }}
        >
          Resolve
        </button>
      )}
      {status !== 'open' && (
        <button className="act" disabled={pending} onClick={() => run('reopen')}>
          Reopen
        </button>
      )}
      {message && <span className="lbl" style={{ color: 'var(--cad-magenta)' }}>{message}</span>}
    </span>
  );
}
