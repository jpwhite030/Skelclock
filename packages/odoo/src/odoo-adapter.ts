/**
 * Live Odoo adapter.
 *
 * The push path is written to be safe to retry at any point, because the sync
 * queue will retry it: it looks for an existing hr.attendance on the same
 * employee and check-in before creating one. That holds even if our local
 * record of the Odoo id is lost, which is the failure mode that would
 * otherwise quietly double every shift in payroll.
 */

import {
  OdooClient,
  OdooError,
  toOdooDatetime,
  type OdooConfig,
} from './client.js';
import {
  EMPLOYEE_FIELDS,
  PARTNER_GEO_FIELDS,
  buildMapping,
  jobReadFields,
  mapJobStatus,
  type MappingOptions,
  type OdooMapping,
} from './mapping.js';
import {
  validateBlocks,
  type AttendancePushInput,
  type AttendancePushResult,
  type OdooAdapter,
  type OdooConnectionInfo,
  type OdooEmployeeDto,
  type OdooJobDto,
} from './adapter.js';

/** Odoo returns many2one as [id, display_name] or false. */
type Many2One = [number, string] | false;

const m2oId = (v: unknown): number | null =>
  Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null;
const m2oName = (v: unknown): string | null =>
  Array.isArray(v) && typeof v[1] === 'string' ? v[1] : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null;

export class LiveOdooAdapter implements OdooAdapter {
  readonly mode = 'live' as const;
  private readonly client: OdooClient;
  private readonly mapping: OdooMapping;

  constructor(config: OdooConfig, mappingOptions: MappingOptions = {}) {
    this.client = new OdooClient(config);
    this.mapping = buildMapping(mappingOptions);
  }

  // --- diagnostics ---------------------------------------------------------

  /**
   * Run this first against the real instance. It answers, in one call, most of
   * the questions the brief says to confirm before building the integration:
   * version, whether the API is reachable, and which of the candidate job
   * models actually exist and are readable by the integration user.
   */
  async testConnection(): Promise<OdooConnectionInfo> {
    try {
      const version = await this.client.version();
      const uid = await this.client.authenticate();

      const candidates = [
        this.mapping.employeeModel,
        this.mapping.attendanceModel,
        this.mapping.job.model,
        'project.project',
        'sale.order',
        'planning.slot',
        'account.analytic.line',
        'hr.payslip',
      ];

      const models: Record<string, boolean> = {};
      for (const model of [...new Set(candidates)]) {
        models[model] = await this.client.modelExists(model);
      }

      return {
        reachable: true,
        serverVersion: String(version.server_version ?? 'unknown'),
        uid,
        models,
      };
    } catch (error) {
      return {
        reachable: false,
        models: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Which job model best fits this instance, judged by record counts. */
  async probeJobModels(): Promise<Record<string, number | 'unavailable'>> {
    const out: Record<string, number | 'unavailable'> = {};
    for (const model of ['project.project', 'sale.order', 'x_skelscaff_job']) {
      try {
        out[model] = await this.client.executeKw<number>(model, 'search_count', [[]]);
      } catch {
        out[model] = 'unavailable';
      }
    }
    return out;
  }

  // --- employees -----------------------------------------------------------

  async fetchEmployees(
    options: { limit?: number; odooIds?: number[] } = {},
  ): Promise<OdooEmployeeDto[]> {
    const domain: unknown[] = options.odooIds?.length
      ? [['id', 'in', options.odooIds]]
      : [];

    const rows = await this.client.executeKw<Record<string, unknown>[]>(
      this.mapping.employeeModel,
      'search_read',
      [domain],
      {
        fields: [...EMPLOYEE_FIELDS],
        limit: options.limit ?? 500,
        // active_test off so leavers come through as active:false rather than
        // silently vanishing — an employee who disappears from the feed would
        // otherwise keep their SkelClock login forever.
        context: { active_test: false },
      },
    );

    return rows.map((r) => this.toEmployeeDto(r));
  }

  private toEmployeeDto(r: Record<string, unknown>): OdooEmployeeDto {
    const active = r.active !== false;
    return {
      odooId: r.id as number,
      fullName: str(r.name) ?? `Employee ${r.id}`,
      employeeNumber: str(r.barcode),
      email: str(r.work_email),
      // Odoo has two phone fields and field crews are inconsistent about which
      // gets filled in. Mobile first, then work phone, so OTP login has the
      // best chance of finding a number.
      mobile: str(r.mobile_phone) ?? str(r.work_phone),
      active,
      employmentStatus: active ? 'active' : 'terminated',
      supervisorOdooId: m2oId(r.parent_id),
      companyOdooId: m2oId(r.company_id),
    };
  }

  // --- jobs ----------------------------------------------------------------

  async fetchJobs(options: { limit?: number; odooIds?: number[] } = {}): Promise<OdooJobDto[]> {
    const { job } = this.mapping;
    const domain: unknown[] = [...job.baseDomain];
    if (options.odooIds?.length) domain.push(['id', 'in', options.odooIds]);

    const rows = await this.client.executeKw<Record<string, unknown>[]>(
      job.model,
      'search_read',
      [domain],
      { fields: jobReadFields(job), limit: options.limit ?? 500 },
    );

    // Site address and coordinates hang off res.partner on the stock models.
    // Batch the partner read rather than one call per job — a 200-job import
    // otherwise turns into 200 round trips.
    const partnerIds = new Set<number>();
    for (const r of rows) {
      const customerId = job.customer ? m2oId(r[job.customer]) : null;
      const siteId = job.siteName ? m2oId(r[job.siteName]) : null;
      if (customerId) partnerIds.add(customerId);
      if (siteId) partnerIds.add(siteId);
    }
    const partners = await this.readPartners([...partnerIds]);

    return rows.map((r) => {
      const customerId = job.customer ? m2oId(r[job.customer]) : null;
      const siteRefId = job.siteName ? m2oId(r[job.siteName]) : null;
      const sitePartner = siteRefId ? partners.get(siteRefId) : undefined;

      const latitude =
        (job.latitude ? num(r[job.latitude]) : null) ?? sitePartner?.latitude ?? null;
      const longitude =
        (job.longitude ? num(r[job.longitude]) : null) ?? sitePartner?.longitude ?? null;

      return {
        odooId: r.id as number,
        odooModel: job.model,
        jobNumber: str(r[job.jobNumber]) ?? String(r.id),
        customerName: customerId
          ? (m2oName(r[job.customer!]) ?? partners.get(customerId)?.name ?? null)
          : null,
        siteName: job.siteName ? (m2oName(r[job.siteName]) ?? str(r[job.siteName])) : null,
        siteAddress:
          (job.siteAddress ? str(r[job.siteAddress]) : null) ?? sitePartner?.address ?? null,
        latitude,
        longitude,
        status: mapJobStatus(job, job.status ? r[job.status] : null),
      };
    });
  }

  private async readPartners(ids: number[]): Promise<
    Map<number, { name: string | null; address: string | null; latitude: number | null; longitude: number | null }>
  > {
    const out = new Map<
      number,
      { name: string | null; address: string | null; latitude: number | null; longitude: number | null }
    >();
    if (ids.length === 0) return out;

    // base_geolocalize may not be installed, in which case the geo fields do
    // not exist and Odoo errors on the whole read. Try with them, fall back
    // without — one wasted call on instances that lack the module, and none
    // on the ones that have it.
    const withGeo = ['id', 'name', 'contact_address', PARTNER_GEO_FIELDS.latitude, PARTNER_GEO_FIELDS.longitude];
    let rows: Record<string, unknown>[];
    try {
      rows = await this.client.executeKw<Record<string, unknown>[]>(
        'res.partner',
        'read',
        [ids],
        { fields: withGeo },
      );
    } catch {
      rows = await this.client.executeKw<Record<string, unknown>[]>(
        'res.partner',
        'read',
        [ids],
        { fields: ['id', 'name', 'contact_address'] },
      );
    }

    for (const r of rows) {
      out.set(r.id as number, {
        name: str(r.name),
        // contact_address is multi-line; flatten it for a one-line site label.
        address: str(r.contact_address)?.replace(/\s*\n\s*/g, ', ').trim() ?? null,
        latitude: num(r[PARTNER_GEO_FIELDS.latitude]),
        longitude: num(r[PARTNER_GEO_FIELDS.longitude]),
      });
    }
    return out;
  }

  // --- attendance push -----------------------------------------------------

  async pushAttendance(input: AttendancePushInput): Promise<AttendancePushResult> {
    validateBlocks(input.blocks);

    const model = this.mapping.attendanceModel;
    const odooIds: Record<string, number> = { ...(input.knownOdooIds ?? {}) };
    let created = 0;
    let updated = 0;

    for (const block of input.blocks) {
      const values = {
        employee_id: input.employeeOdooId,
        check_in: toOdooDatetime(block.checkIn),
        check_out: toOdooDatetime(block.checkOut),
      };

      // Annotated rather than inferred: without `noUncheckedIndexedAccess` the
      // index access is typed `number`, and the declared type would narrow to
      // `number`, making the `targetId = null` reset below a compile error.
      let targetId: number | null = odooIds[block.localRef] ?? null;

      // Lost-id recovery: if we have no id on file, look for a record that is
      // already there before creating a second one.
      if (targetId === null) {
        const existing = await this.client.searchRead<{ id: number }>(
          model,
          [
            ['employee_id', '=', input.employeeOdooId],
            ['check_in', '=', values.check_in],
          ],
          ['id'],
          { limit: 1 },
        );
        targetId = existing[0]?.id ?? null;
      }

      if (targetId !== null) {
        // Confirm it is still there — a record deleted in Odoo since our last
        // push must be recreated, not written to.
        const stillExists = await this.client.searchRead<{ id: number }>(
          model,
          [['id', '=', targetId]],
          ['id'],
          { limit: 1 },
        );
        if (stillExists.length > 0) {
          await this.client.write(model, [targetId], values);
          odooIds[block.localRef] = targetId;
          updated += 1;
          continue;
        }
        targetId = null;
      }

      const newId = await this.client.create(model, values);
      if (typeof newId !== 'number') {
        throw new OdooError(`Odoo did not return an id when creating ${model}`);
      }
      odooIds[block.localRef] = newId;
      created += 1;
    }

    return { odooIds, created, updated };
  }

  async unlinkAttendance(odooIds: number[]): Promise<number[]> {
    if (odooIds.length === 0) return [];

    // Only unlink what is actually there. Odoo raises on a missing id and
    // would fail the whole batch, stranding the sync job on a record someone
    // already tidied up by hand.
    const present = await this.client.searchRead<{ id: number }>(
      this.mapping.attendanceModel,
      [['id', 'in', odooIds]],
      ['id'],
    );
    const presentIds = present.map((r) => r.id);

    if (presentIds.length > 0) {
      await this.client.executeKw(this.mapping.attendanceModel, 'unlink', [presentIds]);
    }
    return odooIds;
  }
}
