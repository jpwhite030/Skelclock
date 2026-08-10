/**
 * Acting on exceptions.
 *
 * Detection lives in @skelclock/core and re-runs on every rebuild; this file
 * is the office's side of the conversation — marking a row acknowledged
 * ("seen it, chasing it") or resolved ("dealt with, here's what happened").
 *
 * Deliberately NOT delete: the dedupe constraint on attendance_exception
 * means a resolved row also stops the detector re-raising the same thing on
 * the next rebuild, which is exactly the behaviour the office expects from
 * "I've dealt with this".
 */

import { oneOrFail, type Db } from './db.js';

export class ExceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExceptionError';
  }
}

export type ExceptionAction = 'acknowledge' | 'resolve' | 'reopen';

export async function updateExceptionStatus(
  db: Db,
  args: {
    companyId: string;
    exceptionId: string;
    action: ExceptionAction;
    actorUserId: string;
    /** Required when resolving — "resolved" with no story is an audit hole. */
    note?: string | null;
  },
): Promise<void> {
  if (args.action === 'resolve' && !args.note?.trim()) {
    throw new ExceptionError('Say how it was resolved — the note is the audit trail.');
  }

  const next =
    args.action === 'acknowledge' ? 'acknowledged' : args.action === 'resolve' ? 'resolved' : 'open';

  await oneOrFail<{ id: string }>(
    db,
    `update attendance_exception
        set status = $3::text::exception_status,
            resolved_by = case when $3::text = 'resolved' then $4::uuid else null end,
            resolved_at = case when $3::text = 'resolved' then now() else null end,
            resolution_note = case when $3::text = 'resolved' then $5 else resolution_note end
      where id = $1 and company_id = $2
      returning id`,
    [args.exceptionId, args.companyId, next, args.actorUserId, args.note?.trim() ?? null],
    'Exception',
  );
}
