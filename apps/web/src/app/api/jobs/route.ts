import { jobsResponseSchema } from '@skelclock/contracts';

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
      site_hours_start: string | null;
      site_hours_end: string | null;
      company_hours_start: string | null;
      company_hours_end: string | null;
    }>(
      `select j.id, j.job_number, j.customer_name,
              s.name as site_name, s.address, s.latitude, s.longitude, s.geofence_radius_m,
              s.operating_hours_start as site_hours_start,
              s.operating_hours_end   as site_hours_end,
              c.operating_hours_start as company_hours_start,
              c.operating_hours_end   as company_hours_end
         from job j
         join company c on c.id = j.company_id
         left join site s on s.id = j.site_id
        where j.company_id = $1 and j.status in ('active', 'on_hold')
          -- A site lockout hides the job entirely - the phone should never
          -- offer, let alone watch, a site this employee cannot clock into.
          and not exists (
            select 1 from employee_site_exclusion x
             where x.site_id = j.site_id and x.employee_id = $2
          )
        order by j.job_number`,
      [caller.companyId, caller.employeeId],
    );

    return Response.json(
      jobsResponseSchema.parse(
        rows.map((r) => ({
          id: r.id,
          jobNumber: r.job_number,
          customerName: r.customer_name,
          siteName: r.site_name,
          siteAddress: r.address,
          latitude: r.latitude,
          longitude: r.longitude,
          geofenceRadiusM:
            r.geofence_radius_m ?? Number(process.env.DEFAULT_GEOFENCE_RADIUS_M ?? 70),
          // Site override wins, else the company default — the same
          // precedence checkOperatingHours applies at ingest, resolved here
          // so the phone can give the same answer at press time.
          operatingHoursStart: r.site_hours_start ?? r.company_hours_start,
          operatingHoursEnd: r.site_hours_end ?? r.company_hours_end,
        })),
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error('jobs failed', error);
    return Response.json({ error: 'Could not load jobs.' }, { status: 500 });
  }
}
