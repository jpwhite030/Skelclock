import { deviceCheckinRequestSchema, deviceCheckinResponseSchema } from '@skelclock/contracts';
import { checkinDevice } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../lib/auth';

/**
 * POST /api/device — a check-in, not a registration form. Called on every
 * foreground and every background-permission check, so device.location_permission
 * reflects reality rather than whatever was true on install day.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);

    const body = deviceCheckinRequestSchema.parse(await request.json());

    await checkinDevice(db, {
      appUserId: caller.appUserId,
      deviceId: body.deviceId,
      platform: body.platform ?? null,
      appVersion: body.appVersion ?? null,
      locationPermission: body.locationPermission ?? null,
    });

    return Response.json(deviceCheckinResponseSchema.parse({ status: 'ok' }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof Error && error.name === 'ZodError') {
      return Response.json({ error: 'Malformed device check-in.' }, { status: 400 });
    }
    console.error('device checkin failed', error);
    return Response.json({ error: 'Could not record device check-in.' }, { status: 500 });
  }
}
