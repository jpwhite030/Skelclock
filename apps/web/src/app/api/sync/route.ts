/**
 * The Odoo sync worker's HTTP entry points.
 *
 *   POST /api/sync            run the queue now (office "Sync now" button)
 *   POST /api/sync?retry=<id> requeue one failed job, then run
 *   GET  /api/sync            cron entry point, guarded by CRON_SECRET
 *
 * Runs the queue in-process rather than as a separate service. The brief asks
 * for one modular backend and no unnecessary microservices, and the queue lives
 * in Postgres — so a second process would buy nothing but another thing to
 * deploy and monitor.
 */

import { createOdooAdapter } from '@skelclock/odoo';
import { retrySyncJob, runSyncWorker } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller, requireRole } from '../../../lib/auth';

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    requireRole(caller, 'admin');

    const retryId = new URL(request.url).searchParams.get('retry');
    if (retryId) await retrySyncJob(db, retryId);

    const result = await runSyncWorker(db, createOdooAdapter(process.env), {
      companyId: caller.companyId,
    });

    return Response.json(result);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('sync run failed', error);
    return Response.json({ error: 'Sync run failed to start.' }, { status: 500 });
  }
}

/**
 * Scheduled run. Point a Vercel cron or an external scheduler at this every few
 * minutes; the backoff schedule in the queue decides what is actually due.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const provided =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    new URL(request.url).searchParams.get('secret');

  if (!secret || provided !== secret) {
    return Response.json({ error: 'Not authorised.' }, { status: 401 });
  }

  try {
    // No companyId: the cron drains every tenant's queue.
    const result = await runSyncWorker(db, createOdooAdapter(process.env), { limit: 100 });
    return Response.json(result);
  } catch (error) {
    console.error('scheduled sync failed', error);
    return Response.json({ error: 'Scheduled sync failed.' }, { status: 500 });
  }
}
