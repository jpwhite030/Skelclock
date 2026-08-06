'use server';

/**
 * Server actions for the sync screen.
 *
 * The retry and run-now buttons go through here rather than the JSON API,
 * because a server component page already has the session and this keeps the
 * office UI working without shipping a token to the browser.
 */

import { revalidatePath } from 'next/cache';

import { createOdooAdapter } from '@skelclock/odoo';
import { retrySyncJob, runSyncWorker } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function retryOne(jobId: string): Promise<ActionResult> {
  const session = await getDashboardSession();
  if (!session || session.role !== 'admin') {
    return { ok: false, message: 'You do not have access to retry syncs.' };
  }

  try {
    await retrySyncJob(db, jobId);
    const result = await runSyncWorker(db, createOdooAdapter(process.env), {
      companyId: session.companyId,
      limit: 1,
    });

    revalidatePath('/sync');

    if (result.succeeded > 0) return { ok: true, message: 'Sent to Odoo.' };
    if (result.errors.length > 0) {
      return { ok: false, message: result.errors[0]!.error };
    }
    return { ok: true, message: 'Queued — it will be picked up on the next run.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Retry failed.',
    };
  }
}

export async function runAll(): Promise<ActionResult> {
  const session = await getDashboardSession();
  if (!session || session.role !== 'admin') {
    return { ok: false, message: 'You do not have access to run the sync.' };
  }

  try {
    const result = await runSyncWorker(db, createOdooAdapter(process.env), {
      companyId: session.companyId,
      limit: 50,
    });

    revalidatePath('/sync');

    if (result.processed === 0) return { ok: true, message: 'Nothing was due.' };
    return {
      ok: result.failed === 0,
      message: `${result.succeeded} sent, ${result.failed} failed.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Sync run failed.',
    };
  }
}
