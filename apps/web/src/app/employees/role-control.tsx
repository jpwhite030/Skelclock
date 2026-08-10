'use client';

/**
 * The role cell, for an admin.
 *
 * Changing a role asks for a reason before it commits. That is not ceremony:
 * the audit trigger records the reason alongside the before/after pair, and
 * "why is Dean an admin" is a question that gets asked months later by someone
 * who was not in the room. A blank reason is refused by the server anyway.
 */

import { useState, useTransition } from 'react';

import { changeRole, syncRolesNow, type ActionResult } from './server-actions';

const ROLES = ['worker', 'supervisor', 'admin'] as const;

export function RoleControl({
  appUserId,
  role,
  roleSource,
  name,
}: {
  appUserId: string;
  role: string;
  roleSource: string | null;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(role);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const save = () => {
    startTransition(async () => {
      const outcome = await changeRole({ appUserId, role: next, reason });
      setResult(outcome);
      if (outcome.ok) {
        setOpen(false);
        setReason('');
      }
    });
  };

  if (!open) {
    return (
      <span className="role-cell">
        <button className="act" onClick={() => setOpen(true)}>
          {role}
        </button>
        {/* Where the role came from, because it decides whether the next Odoo
            sync is allowed to change it back. */}
        {roleSource === 'odoo' && (
          <span className="lbl" style={{ color: 'var(--faintest)' }} title="Set by the Odoo org chart. A sync can change this.">
            org chart
          </span>
        )}
        {result && !result.ok && <span className="mk mk-breach">{result.message}</span>}
      </span>
    );
  }

  return (
    <div className="role-edit">
      <span className="lbl">{name}</span>
      <select value={next} onChange={(e) => setNext(e.target.value)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={reason}
        placeholder="Why?"
        onChange={(e) => setReason(e.target.value)}
        aria-label="Reason for the role change"
      />
      <button className="btn" disabled={pending || !reason.trim() || next === role} onClick={save}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <button
        className="act"
        onClick={() => {
          setOpen(false);
          setResult(null);
        }}
      >
        Cancel
      </button>
      {result && !result.ok && <span className="mk mk-breach">{result.message}</span>}
    </div>
  );
}

/**
 * Runs the org-chart sync on demand.
 *
 * Deliberately a button rather than something the nightly Odoo import does on
 * its own. Roles decide who can approve a timesheet, and an import quietly
 * changing that overnight is how somebody discovers at 6am that they can no
 * longer sign off their crew.
 */
export function RoleSyncButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="role-sync">
      <button
        className="act"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await syncRolesNow());
          })
        }
      >
        {pending ? 'Syncing…' : 'Sync roles from the Odoo org chart'}
      </button>
      <p className="lbl" style={{ color: 'var(--faint)', textTransform: 'none' }}>
        Anyone Odoo says has direct reports becomes a supervisor. Roles you set
        by hand are never touched, and admin is never granted this way.
      </p>
      {result && (
        <span className={`mk ${result.ok ? 'mk-approved' : 'mk-breach'}`}>{result.message}</span>
      )}
    </div>
  );
}
