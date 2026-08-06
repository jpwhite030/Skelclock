/**
 * The adapter contract.
 *
 * Everything above this line — the API, the sync worker, the phone — talks
 * only to this interface. Neither `hr.attendance` nor `project.project` nor any
 * other Odoo name appears anywhere outside packages/odoo, which is what makes
 * the open questions about SkelScaff's Odoo setup safe to defer.
 */

export interface OdooConnectionInfo {
  reachable: boolean;
  serverVersion?: string;
  uid?: number;
  /** Models we checked for and whether this user can read them. */
  models: Record<string, boolean>;
  error?: string;
}

export interface OdooEmployeeDto {
  odooId: number;
  fullName: string;
  employeeNumber: string | null;
  email: string | null;
  mobile: string | null;
  active: boolean;
  employmentStatus: 'active' | 'on_leave' | 'terminated';
  /** Odoo's parent_id — resolved to a local employee on import. */
  supervisorOdooId: number | null;
  companyOdooId: number | null;
}

export interface OdooJobDto {
  odooId: number;
  odooModel: string;
  jobNumber: string;
  customerName: string | null;
  siteName: string | null;
  siteAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  status: 'draft' | 'quoted' | 'active' | 'on_hold' | 'complete' | 'cancelled';
}

/**
 * One continuous paid block. An unpaid break splits a day into two of these,
 * so that Odoo's own worked_hours ends up equal to our paid hours rather than
 * needing a second reconciliation step at payroll time.
 */
export interface AttendanceBlock {
  /** Our time_segment id (or a synthetic id), echoed back in the result. */
  localRef: string;
  /** ISO 8601. */
  checkIn: string;
  /** ISO 8601. Null is rejected — an open shift is never pushed. */
  checkOut: string;
}

export interface AttendancePushInput {
  employeeOdooId: number;
  blocks: AttendanceBlock[];
  /** Existing Odoo ids from a previous push, keyed by localRef. */
  knownOdooIds?: Record<string, number>;
}

export interface AttendancePushResult {
  /** localRef -> Odoo hr.attendance id. */
  odooIds: Record<string, number>;
  created: number;
  updated: number;
}

export interface OdooAdapter {
  readonly mode: 'live' | 'mock';
  testConnection(): Promise<OdooConnectionInfo>;
  fetchEmployees(options?: { limit?: number; odooIds?: number[] }): Promise<OdooEmployeeDto[]>;
  fetchJobs(options?: { limit?: number; odooIds?: number[] }): Promise<OdooJobDto[]>;
  pushAttendance(input: AttendancePushInput): Promise<AttendancePushResult>;
  /**
   * Removes attendance records that no longer correspond to anything on our
   * side — a day that was two blocks and, after a correction, is one. Returns
   * the ids actually removed; ids already gone from Odoo count as removed.
   */
  unlinkAttendance(odooIds: number[]): Promise<number[]>;
}

/** Rejects anything that would create a bad record in Odoo. */
export function validateBlocks(blocks: readonly AttendanceBlock[]): void {
  for (const b of blocks) {
    const start = Date.parse(b.checkIn);
    const end = Date.parse(b.checkOut);
    if (Number.isNaN(start)) throw new Error(`Block ${b.localRef}: invalid checkIn`);
    if (Number.isNaN(end)) throw new Error(`Block ${b.localRef}: invalid checkOut`);
    if (end < start) {
      throw new Error(`Block ${b.localRef}: checkOut is before checkIn`);
    }
  }
}
