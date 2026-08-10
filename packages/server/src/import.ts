/**
 * Import from Odoo.
 *
 * Odoo stays the source of truth: nothing here ever *creates* an employee or a
 * job, it only reflects what Odoo already has. The brief is explicit that there
 * must not be a second employee list to maintain by hand, so every imported row
 * is keyed on its Odoo id and updated in place.
 *
 * Deactivation rather than deletion, always. A terminated employee still has
 * six months of attendance history hanging off their record.
 */

import type { OdooAdapter } from '@skelclock/odoo';

import { one, withTransaction, type Db } from './db.js';

export interface ImportResult {
  created: number;
  updated: number;
  deactivated: number;
  total: number;
}

export async function importEmployees(
  db: Db,
  adapter: OdooAdapter,
  args: { companyId: string; limit?: number; actorUserId?: string | null },
): Promise<ImportResult> {
  const employees = await adapter.fetchEmployees({ limit: args.limit });
  const result: ImportResult = { created: 0, updated: 0, deactivated: 0, total: employees.length };

  await withTransaction(
    db,
    async (tx) => {
      for (const e of employees) {
        const existing = await one<{ id: string; active: boolean }>(
          tx,
          'select id, active from employee where company_id = $1 and odoo_id = $2',
          [args.companyId, e.odooId],
        );

        await tx.query(
          `insert into employee (
             company_id, odoo_id, employee_number, full_name, email, mobile,
             employment_status, active, synced_at, sync_status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,now(),'success')
           on conflict (company_id, odoo_id) do update
             set employee_number   = excluded.employee_number,
                 full_name         = excluded.full_name,
                 email             = excluded.email,
                 mobile            = excluded.mobile,
                 employment_status = excluded.employment_status,
                 active            = excluded.active,
                 synced_at         = now(),
                 sync_status       = 'success'`,
          [
            args.companyId,
            e.odooId,
            e.employeeNumber,
            e.fullName,
            e.email,
            normaliseMobile(e.mobile),
            e.employmentStatus,
            e.active,
          ],
        );

        if (!existing) result.created += 1;
        else result.updated += 1;
        if (existing?.active && !e.active) result.deactivated += 1;
      }

      // Supervisors in a second pass: Odoo's parent_id may point at an
      // employee that had not been inserted yet on the first pass.
      for (const e of employees) {
        if (!e.supervisorOdooId) continue;
        await tx.query(
          `update employee
              set supervisor_employee_id = (
                    select id from employee
                     where company_id = $1 and odoo_id = $2)
            where company_id = $1 and odoo_id = $3`,
          [args.companyId, e.supervisorOdooId, e.odooId],
        );
      }
    },
    { actorUserId: args.actorUserId ?? null, reason: 'employee import from Odoo' },
  );

  return result;
}

export async function importJobs(
  db: Db,
  adapter: OdooAdapter,
  args: {
    companyId: string;
    limit?: number;
    actorUserId?: string | null;
    defaultGeofenceRadiusM?: number;
  },
): Promise<ImportResult> {
  const jobs = await adapter.fetchJobs({ limit: args.limit });
  const radius = args.defaultGeofenceRadiusM ?? 70;
  const result: ImportResult = { created: 0, updated: 0, deactivated: 0, total: jobs.length };

  await withTransaction(
    db,
    async (tx) => {
      for (const j of jobs) {
        const existing = await one<{ id: string; site_id: string | null }>(
          tx,
          'select id, site_id from job where company_id = $1 and odoo_model = $2 and odoo_id = $3',
          [args.companyId, j.odooModel, j.odooId],
        );

        // The site is ours, not Odoo's — see the GEO_NOTE in the odoo mapping.
        // Coordinates from Odoo win when present, but a pin the office dropped
        // by hand is never overwritten with nulls.
        let siteId = existing?.site_id ?? null;
        if (siteId) {
          await tx.query(
            `update site
                set name = $2,
                    address = coalesce($3, address),
                    latitude = coalesce($4, latitude),
                    longitude = coalesce($5, longitude)
              where id = $1`,
            [siteId, j.siteName ?? j.jobNumber, j.siteAddress, j.latitude, j.longitude],
          );
        } else {
          const site = await one<{ id: string }>(
            tx,
            `insert into site (company_id, name, address, latitude, longitude, geofence_radius_m)
             values ($1,$2,$3,$4,$5,$6) returning id`,
            [
              args.companyId,
              j.siteName ?? j.jobNumber,
              j.siteAddress,
              j.latitude,
              j.longitude,
              radius,
            ],
          );
          siteId = site!.id;
        }

        await tx.query(
          `insert into job (
             company_id, odoo_model, odoo_id, job_number, customer_name,
             site_id, status, synced_at, sync_status
           ) values ($1,$2,$3,$4,$5,$6,$7,now(),'success')
           on conflict (company_id, odoo_model, odoo_id) do update
             set job_number    = excluded.job_number,
                 customer_name = excluded.customer_name,
                 site_id       = excluded.site_id,
                 status        = excluded.status,
                 synced_at     = now(),
                 sync_status   = 'success'`,
          [
            args.companyId,
            j.odooModel,
            j.odooId,
            j.jobNumber,
            j.customerName,
            siteId,
            j.status,
          ],
        );

        if (existing) result.updated += 1;
        else result.created += 1;
      }
    },
    { actorUserId: args.actorUserId ?? null, reason: 'job import from Odoo' },
  );

  return result;
}

/**
 * Australian mobile numbers, normalised to E.164.
 *
 * Odoo records whatever was typed — "0412 555 208", "+61412555208",
 * "61 412 555 208". OTP login matches on this column, so a worker whose number
 * was entered with spaces has to be findable by the number they type on the
 * login screen.
 */
export function normaliseMobile(raw: string | null): string | null {
  if (!raw) return null;

  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.length === 0) return null;

  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('61') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('0')) return `+61${digits.slice(1)}`;
  // A bare 9-digit mobile with the leading zero lost to a spreadsheet.
  if (digits.length === 9 && digits.startsWith('4')) return `+61${digits}`;

  return digits;
}
