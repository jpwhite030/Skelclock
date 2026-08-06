/**
 * Crew clocking.
 *
 * A supervisor taps once; every member gets their own attendance event, their
 * own idempotency key and their own timesheet. Nothing about a crew clock is
 * shared state — the brief requires a separate record per employee, and it also
 * means one member's rejection (already clocked in, say) cannot fail the other
 * five.
 */

import { newIdempotencyKey, type AttendanceEventType, type ClockEventInput } from '@skelclock/core';

import { type Db } from './db.js';
import { ingestEvents, type IngestOutcome } from './ingest.js';

export interface CrewClockInput {
  companyId: string;
  crewId: string;
  eventType: AttendanceEventType;
  actorUserId: string;
  deviceTime?: string;
  jobId?: string | null;
  workActivityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracyM?: number | null;
  outsideReason?: string | null;
  /** Workers who are not here — removed before confirming. */
  excludeEmployeeIds?: string[];
  deviceId?: string | null;
  now?: Date;
}

export interface CrewClockResult {
  crewId: string;
  attempted: number;
  succeeded: number;
  skipped: number;
  outcomes: Array<{ employeeId: string; employeeName: string; outcome: IngestOutcome }>;
}

export async function clockCrew(db: Db, input: CrewClockInput): Promise<CrewClockResult> {
  const now = input.now ?? new Date();
  const deviceTime = input.deviceTime ?? now.toISOString();
  const excluded = new Set(input.excludeEmployeeIds ?? []);

  const { rows: members } = await db.query<{ employee_id: string; full_name: string }>(
    `select cm.employee_id, e.full_name
       from crew_member cm
       join employee e on e.id = cm.employee_id
      where cm.crew_id = $1 and cm.active and e.active and e.company_id = $2
      order by e.full_name`,
    [input.crewId, input.companyId],
  );

  const included = members.filter((m) => !excluded.has(m.employee_id));

  const events: ClockEventInput[] = included.map((m) => ({
    // One key per employee per press. Sharing a key across the crew would make
    // the second member's event look like a retry of the first's.
    idempotencyKey: newIdempotencyKey(input.deviceId ?? 'crew'),
    employeeId: m.employee_id,
    eventType: input.eventType,
    deviceTime,
    jobId: input.jobId ?? null,
    workActivityId: input.workActivityId ?? null,
    // The supervisor's position stands in for the crew's: they are on the same
    // site, and asking six phones for a fix would make the tap take 30 seconds.
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    gpsAccuracyM: input.gpsAccuracyM ?? null,
    outsideReason: input.outsideReason ?? null,
    clockMethod: 'supervisor',
    wasOffline: false,
    deviceId: input.deviceId ?? null,
    actingUserId: input.actorUserId,
  }));

  const { outcomes } = await ingestEvents(db, {
    companyId: input.companyId,
    events,
    actingUserId: input.actorUserId,
    now,
  });

  const byKey = new Map(outcomes.map((o) => [o.idempotencyKey, o]));

  const detailed = events.map((e, i) => ({
    employeeId: e.employeeId,
    employeeName: included[i]!.full_name,
    outcome: byKey.get(e.idempotencyKey)!,
  }));

  return {
    crewId: input.crewId,
    attempted: included.length,
    succeeded: detailed.filter((d) => d.outcome?.status === 'created').length,
    skipped: excluded.size,
    outcomes: detailed,
  };
}

/** Moves an already-working crew onto a different job mid-day. */
export const moveCrewToJob = (
  db: Db,
  input: Omit<CrewClockInput, 'eventType'> & { jobId: string },
): Promise<CrewClockResult> => clockCrew(db, { ...input, eventType: 'job_change' });
