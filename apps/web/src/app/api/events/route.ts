/**
 * POST /api/events — the ingest endpoint.
 *
 * The single door for every clock event: the worker's phone, a supervisor's
 * crew clock, and the offline queue flushing a whole day at once. Takes a
 * batch, returns one outcome per event keyed by idempotency key, so the phone
 * can settle each queued item independently.
 *
 * Always 200 when the batch was processed. A rejected event is a normal
 * outcome, not an HTTP error — the queue needs to tell them apart, since one
 * should be retried and the other never should.
 */

import type { ClockEventInput } from '@skelclock/core';
import { ingestEvents, enqueueTimesheetPush } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller, type Caller } from '../../../lib/auth';

const MAX_BATCH = 200;

export async function POST(request: Request): Promise<Response> {
  let caller: Caller;
  try {
    caller = await requireCaller(request);
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  let body: { events?: unknown };
  try {
    body = (await request.json()) as { events?: unknown };
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  if (!Array.isArray(body.events)) {
    return Response.json({ error: 'Expected an "events" array.' }, { status: 400 });
  }
  if (body.events.length > MAX_BATCH) {
    return Response.json(
      { error: `Too many events in one request (max ${MAX_BATCH}).` },
      { status: 413 },
    );
  }

  const events: ClockEventInput[] = [];
  for (const raw of body.events as Array<Record<string, unknown>>) {
    // A worker may only ever post events for themselves. The employeeId in the
    // payload is ignored for workers and taken from the session instead, so a
    // tampered client cannot clock someone else on.
    const employeeId =
      caller.role === 'worker' ? caller.employeeId : (raw.employeeId as string) ?? caller.employeeId;

    if (!employeeId) {
      return Response.json(
        { error: 'This login is not linked to an employee record.' },
        { status: 403 },
      );
    }

    // Likewise the method: only a supervisor or admin may claim to have clocked
    // someone else on.
    const requested = String(raw.clockMethod ?? 'manual');
    const clockMethod =
      caller.role === 'worker' && requested !== 'manual' && requested !== 'auto_geofence'
        ? 'manual'
        : (requested as ClockEventInput['clockMethod']);

    events.push({
      idempotencyKey: String(raw.idempotencyKey ?? ''),
      employeeId,
      eventType: raw.eventType as ClockEventInput['eventType'],
      deviceTime: String(raw.deviceTime ?? ''),
      jobId: (raw.jobId as string | null) ?? null,
      workActivityId: (raw.workActivityId as string | null) ?? null,
      latitude: toNumber(raw.latitude),
      longitude: toNumber(raw.longitude),
      gpsAccuracyM: toNumber(raw.gpsAccuracyM),
      outsideReason: (raw.outsideReason as string | null) ?? null,
      clockMethod,
      wasOffline: Boolean(raw.wasOffline),
      deviceId: (raw.deviceId as string | null) ?? null,
      actingUserId: caller.appUserId,
    });
  }

  try {
    const result = await ingestEvents(db, {
      companyId: caller.companyId,
      events,
      actingUserId: caller.appUserId,
      defaultGeofenceRadiusM: Number(process.env.DEFAULT_GEOFENCE_RADIUS_M ?? 200),
    });

    // A completed day is worth queueing for Odoo straight away — the worker
    // still has to confirm and the supervisor still has to approve, and the
    // sync worker refuses anything unapproved, so this only shortens the wait
    // once approval lands.
    for (const timesheetId of result.affectedTimesheetIds) {
      await enqueueTimesheetPush(db, { companyId: caller.companyId, timesheetId });
    }

    return Response.json({
      outcomes: result.outcomes.map((o) => ({
        idempotencyKey: o.idempotencyKey,
        status: o.status,
        ...(o.status === 'rejected' ? { code: o.code, message: o.message } : {}),
        ...(o.status === 'created'
          ? { insideGeofence: o.insideGeofence, distanceM: o.distanceM }
          : {}),
      })),
    });
  } catch (error) {
    console.error('ingest failed', error);
    // A 500 keeps the events queued on the device, which is the safe outcome.
    return Response.json({ error: 'Could not record those events.' }, { status: 500 });
  }
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
