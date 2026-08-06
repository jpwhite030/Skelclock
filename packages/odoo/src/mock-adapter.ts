/**
 * In-memory Odoo stand-in.
 *
 * Exists so the whole stack — phone, API, sync queue, dashboard — can be built
 * and tested end to end before anyone has SkelScaff's Odoo credentials, and so
 * the test suite never depends on a live server. It enforces the same
 * idempotency contract as the real adapter, so a bug in the retry logic fails
 * here rather than in production payroll.
 *
 * `failureMode` lets tests drive the office's retry screen without unplugging
 * anything.
 */

import { toOdooDatetime } from './client.js';
import {
  validateBlocks,
  type AttendancePushInput,
  type AttendancePushResult,
  type OdooAdapter,
  type OdooConnectionInfo,
  type OdooEmployeeDto,
  type OdooJobDto,
} from './adapter.js';

export interface MockAttendanceRecord {
  id: number;
  employee_id: number;
  check_in: string;
  check_out: string;
}

export interface MockOdooOptions {
  employees?: OdooEmployeeDto[];
  jobs?: OdooJobDto[];
  /** 'none' | 'always' | 'first_n' — drives retry testing. */
  failureMode?: 'none' | 'always' | 'first_n';
  /** With failureMode 'first_n', how many pushes fail before succeeding. */
  failCount?: number;
}

export const DEMO_EMPLOYEE: OdooEmployeeDto = {
  odooId: 1042,
  fullName: 'Dean Whitmore',
  employeeNumber: 'SS-114',
  email: 'dean.whitmore@example.com',
  mobile: '+61 412 555 208',
  active: true,
  employmentStatus: 'active',
  supervisorOdooId: 1007,
  companyOdooId: 1,
};

export const DEMO_JOB: OdooJobDto = {
  odooId: 3311,
  odooModel: 'project.project',
  jobNumber: '1032',
  customerName: 'Ridgeline Construction Pty Ltd',
  siteName: '14 Kembla Street',
  siteAddress: '14 Kembla Street, Wollongong NSW 2500',
  // Wollongong CBD — a real coordinate so the geofence maths is exercised.
  latitude: -34.4248,
  longitude: 150.8931,
  status: 'active',
};

export class MockOdooAdapter implements OdooAdapter {
  readonly mode = 'mock' as const;

  private readonly employees: OdooEmployeeDto[];
  private readonly jobs: OdooJobDto[];
  private readonly attendance = new Map<number, MockAttendanceRecord>();
  private nextId = 5000;
  private pushAttempts = 0;

  constructor(private readonly options: MockOdooOptions = {}) {
    this.employees = options.employees ?? [DEMO_EMPLOYEE];
    this.jobs = options.jobs ?? [DEMO_JOB];
  }

  async testConnection(): Promise<OdooConnectionInfo> {
    return {
      reachable: true,
      serverVersion: 'mock',
      uid: 2,
      models: {
        'hr.employee': true,
        'hr.attendance': true,
        'project.project': true,
        'sale.order': true,
        'planning.slot': false,
        'account.analytic.line': true,
      },
    };
  }

  async fetchEmployees(options: { limit?: number; odooIds?: number[] } = {}): Promise<OdooEmployeeDto[]> {
    let rows = this.employees;
    if (options.odooIds?.length) {
      const wanted = new Set(options.odooIds);
      rows = rows.filter((e) => wanted.has(e.odooId));
    }
    return rows.slice(0, options.limit ?? rows.length).map((e) => ({ ...e }));
  }

  async fetchJobs(options: { limit?: number; odooIds?: number[] } = {}): Promise<OdooJobDto[]> {
    let rows = this.jobs;
    if (options.odooIds?.length) {
      const wanted = new Set(options.odooIds);
      rows = rows.filter((j) => wanted.has(j.odooId));
    }
    return rows.slice(0, options.limit ?? rows.length).map((j) => ({ ...j }));
  }

  async pushAttendance(input: AttendancePushInput): Promise<AttendancePushResult> {
    validateBlocks(input.blocks);
    this.pushAttempts += 1;

    if (this.shouldFail()) {
      // Shaped like a real Odoo access error so the office-facing message in
      // the sync dashboard is exercised too.
      throw new Error('Odoo access error: you are not allowed to modify hr.attendance');
    }

    const odooIds: Record<string, number> = { ...(input.knownOdooIds ?? {}) };
    let created = 0;
    let updated = 0;

    for (const block of input.blocks) {
      const record = {
        employee_id: input.employeeOdooId,
        check_in: toOdooDatetime(block.checkIn),
        check_out: toOdooDatetime(block.checkOut),
      };

      let targetId: number | null = odooIds[block.localRef] ?? null;

      // Same lost-id recovery as the live adapter: an existing record for this
      // employee and check-in wins over creating a new one.
      if (targetId === null) {
        for (const [id, existing] of this.attendance) {
          if (
            existing.employee_id === record.employee_id &&
            existing.check_in === record.check_in
          ) {
            targetId = id;
            break;
          }
        }
      }

      if (targetId !== null && this.attendance.has(targetId)) {
        this.attendance.set(targetId, { id: targetId, ...record });
        odooIds[block.localRef] = targetId;
        updated += 1;
      } else {
        const id = this.nextId++;
        this.attendance.set(id, { id, ...record });
        odooIds[block.localRef] = id;
        created += 1;
      }
    }

    return { odooIds, created, updated };
  }

  async unlinkAttendance(odooIds: number[]): Promise<number[]> {
    for (const id of odooIds) this.attendance.delete(id);
    return odooIds;
  }

  private shouldFail(): boolean {
    const { failureMode = 'none', failCount = 1 } = this.options;
    if (failureMode === 'always') return true;
    if (failureMode === 'first_n') return this.pushAttempts <= failCount;
    return false;
  }

  // --- test helpers --------------------------------------------------------

  /** Everything currently sitting in the fake hr.attendance table. */
  attendanceRecords(): MockAttendanceRecord[] {
    return [...this.attendance.values()].sort((a, b) => a.id - b.id);
  }

  attendanceCount(): number {
    return this.attendance.size;
  }

  /** Simulates someone deleting the record in Odoo between syncs. */
  deleteAttendance(id: number): void {
    this.attendance.delete(id);
  }
}
