/** Shared domain types. Mirrors the SQL enums in supabase/migrations/0001. */

export type UserRole = 'worker' | 'supervisor' | 'admin';

export type AttendanceEventType =
  | 'clock_in'
  | 'clock_out'
  | 'break_start'
  | 'break_end'
  | 'job_change'
  | 'activity_change';

export type ClockMethod = 'manual' | 'auto_geofence' | 'supervisor' | 'admin';

export type SegmentType = 'work' | 'travel' | 'break';

export type TimesheetStatus =
  | 'draft'
  | 'worker_confirmed'
  | 'supervisor_approved'
  | 'synced'
  | 'locked';

export type SyncStatus = 'pending' | 'running' | 'success' | 'failed' | 'dead';

export type ExceptionType =
  | 'missing_clock_in'
  | 'missing_clock_out'
  | 'outside_geofence'
  | 'overlapping_shift'
  | 'very_long_shift'
  | 'offline_event'
  | 'unassigned_job'
  | 'odoo_sync_failure'
  /**
   * Synthetic — computed live from attendance_event at read time, never
   * written to attendance_exception or the DB enum (see
   * packages/server/src/suggestions.ts:listStaleSuggestions). A geofence
   * suggestion nobody has confirmed or dismissed after a while; the office
   * would otherwise have no way to know a day is quietly missing hours.
   */
  | 'stale_suggestion';

/**
 * An event exactly as the phone queues it. This shape crosses the wire and is
 * persisted to on-device SQLite, so it must stay serialisable and additive-only
 * — an old app version's queued rows have to survive an app update.
 */
export interface ClockEventInput {
  /** Stable across every retry of this one button press. */
  idempotencyKey: string;
  employeeId: string;
  eventType: AttendanceEventType;
  /** ISO 8601 with offset. What the device clock said at the button press. */
  deviceTime: string;
  jobId?: string | null;
  workActivityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracyM?: number | null;
  /** Required by the API when the resulting clock lands outside the geofence. */
  outsideReason?: string | null;
  clockMethod: ClockMethod;
  /** True when the button was pressed with no connectivity. */
  wasOffline: boolean;
  deviceId?: string | null;
  /** Set by supervisor/crew flows; null when the worker acted for themselves. */
  actingUserId?: string | null;
  /**
   * Auto-geofence only: every assigned job whose site fence the fix fell
   * inside. Length > 1 means the phone could not tell which site the worker
   * meant — ingest.ts stores the list and never auto-confirms an ambiguous
   * event, no matter how good the fix.
   */
  candidateJobIds?: string[] | null;
}

export interface WorkActivityRef {
  id: string;
  code: string;
  name: string;
  isTravel: boolean;
  isPaid: boolean;
}

/** A stored event, as read back from the database. */
export interface StoredAttendanceEvent {
  id: string;
  employeeId: string;
  /**
   * The day this event was booked to. Every event of one shift shares it, even
   * across midnight, which is what makes it the correct grouping key for
   * "this shift" rather than a wall-clock window.
   */
  timesheetId?: string | null;
  eventType: AttendanceEventType;
  deviceTime: string;
  serverTime: string;
  jobId: string | null;
  workActivityId: string | null;
  latitude: number | null;
  longitude: number | null;
  gpsAccuracyM: number | null;
  insideGeofence: boolean | null;
  distanceFromSiteM: number | null;
  outsideReason: string | null;
  clockMethod: ClockMethod;
  wasOffline: boolean;
  isSuggested: boolean;
  voidedAt: string | null;
}

export interface TimeSegment {
  jobId: string | null;
  workActivityId: string | null;
  segmentType: SegmentType;
  startTime: string;
  endTime: string | null;
  minutes: number | null;
  isPaid: boolean;
  startEventId: string | null;
  endEventId: string | null;
}

export interface DayTotals {
  totalShiftMinutes: number;
  totalBreakMinutes: number;
  totalPaidMinutes: number;
  /** Deducted automatically because no break was clocked on a long enough
   * shift — see BuildSegmentsOptions.autoLunch. Zero when it didn't apply. */
  autoLunchMinutes: number;
}

/** Company-wide payroll settings that change how a day is built, not just displayed. */
export type TravelAllocation = 'unallocated' | 'first_site' | 'second_site';
