import { geofenceConsentRequestSchema, geofenceConsentResponseSchema } from '@skelclock/contracts';
import { recordGeofenceConsent } from '@skelclock/server';

import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../lib/auth';

/**
 * POST /api/geofence-consent — the audit trail behind the in-app notice a
 * worker agrees to before auto-detect starts, and behind switching it off
 * again. See geofence_consent_event in supabase/migrations/0005_geofence_v2.sql.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);
    if (!caller.employeeId) {
      return Response.json(
        { error: 'This login is not linked to an employee record.' },
        { status: 403 },
      );
    }

    const body = geofenceConsentRequestSchema.parse(await request.json());

    await recordGeofenceConsent(db, {
      companyId: caller.companyId,
      employeeId: caller.employeeId,
      appUserId: caller.appUserId,
      action: body.action,
      policyVersion: body.policyVersion,
      deviceId: body.deviceId ?? null,
    });

    return Response.json(geofenceConsentResponseSchema.parse({ status: 'ok' }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof Error && error.name === 'ZodError') {
      return Response.json({ error: 'Malformed consent record.' }, { status: 400 });
    }
    console.error('geofence consent record failed', error);
    return Response.json({ error: 'Could not record consent.' }, { status: 500 });
  }
}
