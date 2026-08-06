/**
 * Odoo model and field mapping.
 *
 * This file is the answer to the open question in the brief: "confirm which
 * model represents a SkelScaff job". Rather than guessing and threading that
 * guess through the codebase, every Odoo-specific name lives here. When the
 * answer comes back — project.project, sale.order, or a custom model — the
 * change is a preset swap in this one file and nothing above it moves.
 *
 * The presets below are written against stock Odoo 16/17/18 field names.
 * `probeJobModels()` in odoo-adapter.ts can be run against the live instance
 * to confirm which of them actually fits before anything is committed to.
 */

export type JobModelPreset = 'project.project' | 'sale.order' | 'custom';

export interface JobFieldMap {
  /** The Odoo model to read jobs from. */
  model: string;
  /** Odoo field holding the job number shown to workers. */
  jobNumber: string;
  /** many2one to res.partner. */
  customer: string | null;
  siteName: string | null;
  siteAddress: string | null;
  latitude: string | null;
  longitude: string | null;
  /** Field carrying job state, plus how its values map to ours. */
  status: string | null;
  statusMap: Record<string, JobStatus>;
  /** Extra domain clauses ANDed onto every job read. */
  baseDomain: unknown[];
  /** Fields to request. Derived, but overridable for custom models. */
  extraFields?: string[];
}

export type JobStatus =
  | 'draft'
  | 'quoted'
  | 'active'
  | 'on_hold'
  | 'complete'
  | 'cancelled';

export interface OdooMapping {
  employeeModel: string;
  attendanceModel: string;
  /** Analytic lines, for Phase 2 labour costing. Null disables costing push. */
  analyticLineModel: string | null;
  planningModel: string | null;
  job: JobFieldMap;
  activity: {
    model: string;
    name: string;
    code: string | null;
    baseDomain: unknown[];
  } | null;
}

// --- job presets ------------------------------------------------------------

/**
 * Most likely fit for a scaffolding contractor: each job is a project, the
 * customer is the partner, and the site address comes off the partner record.
 * Stock project.project has no lat/long — see GEO_NOTE below.
 */
const PROJECT_PRESET: JobFieldMap = {
  model: 'project.project',
  jobNumber: 'name',
  customer: 'partner_id',
  siteName: 'name',
  siteAddress: null, // resolved from partner_id, see resolveSiteAddress()
  latitude: null,
  longitude: null,
  status: 'last_update_status',
  statusMap: {
    on_track: 'active',
    at_risk: 'active',
    off_track: 'on_hold',
    on_hold: 'on_hold',
    done: 'complete',
    to_define: 'draft',
  },
  baseDomain: [['active', '=', true]],
};

/**
 * Fit if SkelScaff runs jobs straight off sales orders (quote -> job number).
 * Richer address data, because sale.order carries a delivery partner.
 */
const SALE_ORDER_PRESET: JobFieldMap = {
  model: 'sale.order',
  jobNumber: 'name',
  customer: 'partner_id',
  siteName: 'partner_shipping_id',
  siteAddress: null, // resolved from partner_shipping_id
  latitude: null,
  longitude: null,
  status: 'state',
  statusMap: {
    draft: 'quoted',
    sent: 'quoted',
    sale: 'active',
    done: 'complete',
    cancel: 'cancelled',
  },
  // Quotations are not jobs anyone clocks onto; confirmed orders are.
  baseDomain: [['state', 'in', ['sale', 'done']]],
};

/**
 * If a custom module is installed, this is the shape to build toward: it puts
 * coordinates and the geofence radius on the job itself, which removes the
 * partner-address geocoding step entirely.
 */
const CUSTOM_PRESET: JobFieldMap = {
  model: 'x_skelscaff_job',
  jobNumber: 'x_job_number',
  customer: 'x_customer_id',
  siteName: 'x_site_name',
  siteAddress: 'x_site_address',
  latitude: 'x_latitude',
  longitude: 'x_longitude',
  status: 'x_status',
  statusMap: {
    draft: 'draft',
    active: 'active',
    on_hold: 'on_hold',
    complete: 'complete',
    cancelled: 'cancelled',
  },
  baseDomain: [],
};

const JOB_PRESETS: Record<JobModelPreset, JobFieldMap> = {
  'project.project': PROJECT_PRESET,
  'sale.order': SALE_ORDER_PRESET,
  custom: CUSTOM_PRESET,
};

/**
 * GEO_NOTE
 * -------------------------------------------------------------------------
 * No stock Odoo model stores site coordinates. Three ways out, in the order
 * they should be considered:
 *
 *   1. Custom fields on the job (x_latitude / x_longitude / x_geofence_radius).
 *      Requires the ability to install or edit a module. Cleanest.
 *   2. `base_geolocalize`, a stock Odoo module that adds partner_latitude and
 *      partner_longitude to res.partner. Free, no custom code, but the fence
 *      then sits on the customer's address rather than the site.
 *   3. Set the coordinates in SkelClock. The `site` table already owns the
 *      fence, so the office drops a pin per site once and Odoo never needs to
 *      know. This is the fallback the MVP uses if 1 and 2 are unavailable, and
 *      the reason `site` is a separate table from `job`.
 *
 * Until one of these is chosen, jobs import with null coordinates and the
 * geofence evaluator returns insideGeofence: null — recorded, never blocking.
 */

export const PARTNER_GEO_FIELDS = {
  latitude: 'partner_latitude',
  longitude: 'partner_longitude',
} as const;

// --- assembly ---------------------------------------------------------------

export interface MappingOptions {
  jobModel?: string;
  activityModel?: string;
  /** Set true once base_geolocalize is confirmed installed. */
  usePartnerGeolocation?: boolean;
}

export function buildMapping(options: MappingOptions = {}): OdooMapping {
  const jobKey = resolveJobPreset(options.jobModel);
  const job: JobFieldMap = { ...JOB_PRESETS[jobKey] };

  // A custom model name that isn't one of the known presets: keep the custom
  // field naming convention but honour the name we were given.
  if (jobKey === 'custom' && options.jobModel) job.model = options.jobModel;

  const activityModel = options.activityModel ?? 'project.task';

  return {
    employeeModel: 'hr.employee',
    attendanceModel: 'hr.attendance',
    analyticLineModel: 'account.analytic.line',
    planningModel: 'planning.slot',
    job,
    activity: activityModel
      ? {
          model: activityModel,
          name: activityModel === 'project.task' ? 'name' : 'name',
          code: activityModel === 'account.analytic.account' ? 'code' : null,
          baseDomain: [],
        }
      : null,
  };
}

function resolveJobPreset(model?: string): JobModelPreset {
  if (model === 'project.project' || model === 'sale.order') return model;
  return 'custom';
}

/** Fields to request when reading jobs, with nulls dropped. */
export function jobReadFields(job: JobFieldMap): string[] {
  const fields = [
    'id',
    job.jobNumber,
    job.customer,
    job.siteName,
    job.siteAddress,
    job.latitude,
    job.longitude,
    job.status,
    ...(job.extraFields ?? []),
  ].filter((f): f is string => typeof f === 'string' && f.length > 0);

  return [...new Set(fields)];
}

export function mapJobStatus(map: JobFieldMap, raw: unknown): JobStatus {
  if (typeof raw !== 'string') return 'active';
  return map.statusMap[raw] ?? 'active';
}

export const EMPLOYEE_FIELDS = [
  'id',
  'name',
  'work_email',
  'mobile_phone',
  'work_phone',
  'active',
  'parent_id', // manager -> our supervisor
  'company_id',
  'barcode', // commonly used as the employee number on site
  'employee_type',
] as const;
