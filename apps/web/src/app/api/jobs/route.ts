import { db } from '../../../lib/db';
import { authErrorResponse, requireCaller } from '../../../lib/auth';

/**
 * GET /api/jobs — the jobs this worker can clock onto.
 *
 * Includes the site coordinates and fence radius, because the phone evaluates
 * the geofence locally before submitting. That is what lets an offline worker
 * be told they are off-site at the moment they press the button, rather than
 * finding out hours later when the queue drains.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const caller = await requireCaller(request);

    const { rows } = await db.query<{
      id: string;
      job_number: string;
      customer_name: string | null;
      site_name: string | null;
      address: string | null;
      latitude: number | null;
      longitude: number | null;
      geofence_radius_m: number | null;
    }>(
      `select j.id, j.job_number, j.customer_name,
              s.name as site_name, s.address, s.latitude, s.longitude, s.geofence_radius_m
         from job j
         left join site s on s.id = j.site_id
        where j.company_id = $1 and j.status in ('active', 'on_hold')
        order by j.job_number`,
      [caller.companyId],
    );

    return Response.json(
      rows.map((r) => ({
        id: r.id,
        jobNumber: r.job_number,
        customerName: r.customer_name,
        siteName: r.site_name,
        siteAddress: r.address,
        latitude: r.latitude,
        longitude: r.longitude,
        geofenceRadiusM:
          r.geofence_radius_m ?? Number(process.env.DEFAULT_GEOFENCE_RADIUS_M ?? 200),
      })),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('jobs failed', error);
    return Response.json({ error: 'Could not load jobs.' }, { status: 500 });
  }
}
