'use server';

/**
 * Acting on an exception from SHT 03.
 *
 * Same pattern as the sites and sync screens: the server component already
 * holds the session, so mutations go through actions rather than shipping a
 * token to the browser.
 */

import { revalidatePath } from 'next/cache';

import { ExceptionError, updateExceptionStatus, type ExceptionAction } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface ExceptionActionResult {
  ok: boolean;
  message: string;
}

export async function actOnException(args: {
  exceptionId: string;
  action: ExceptionAction;
  note?: string;
}): Promise<ExceptionActionResult> {
  const session = await getDashboardSession();
  if (!session || (session.role !== 'admin' && session.role !== 'supervisor')) {
    return { ok: false, message: 'You do not have access to update exceptions.' };
  }
  if (!session.appUserId) {
    return { ok: false, message: 'Development mode has no user to attribute this to.' };
  }

  try {
    await updateExceptionStatus(db, {
      companyId: session.companyId,
      exceptionId: args.exceptionId,
      action: args.action,
      actorUserId: session.appUserId,
      note: args.note ?? null,
    });
    revalidatePath('/exceptions');
    return {
      ok: true,
      message:
        args.action === 'acknowledge'
          ? 'Acknowledged.'
          : args.action === 'resolve'
            ? 'Resolved.'
            : 'Reopened.',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ExceptionError ? error.message : 'Could not update the exception.',
    };
  }
}
