'use client';

/**
 * The interactive half of the correction screen: a live event list with
 * inline correct/void, and a form for a time the worker never clocked.
 *
 * Kept as one client component rather than per-row server actions calling
 * back into a server component — every action needs local pending/result
 * state (which row is mid-edit, which just saved, which failed) that only
 * makes sense held together in one place.
 */

import { useState, useTransition } from 'react';

import type { AttendanceEventType } from '@skelclock/core';
import type { TimesheetDetail, TimesheetDetailEvent } from '@skelclock/server';

import {
  addMissingAttendanceEvent,
  correctAttendanceEvent,
  voidAttendanceEvent,
  type ActionResult,
} from './server-actions';

const EVENT_TYPES: AttendanceEventType[] = [
  'clock_in',
  'clock_out',
  'break_start',
  'break_end',
  'job_change',
  'activity_change',
];

const EVENT_LABELS: Record<AttendanceEventType, string> = {
  clock_in: 'Clock on',
  clock_out: 'Clock off',
  break_start: 'Break start',
  break_end: 'Break end',
  job_change: 'Job change',
  activity_change: 'Activity change',
};

interface JobOption {
  id: string;
  jobNumber: string;
}
interface ActivityOption {
  id: string;
  name: string;
}

export function TimesheetDetailClient({
  timesheet,
  events,
  jobs,
  activities,
}: {
  timesheet: TimesheetDetail;
  events: TimesheetDetailEvent[];
  jobs: JobOption[];
  activities: ActivityOption[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const [results, setResults] = useState<Record<string, ActionResult>>({});

  const locked = timesheet.status === 'locked';

  return (
    <>
      {locked && (
        <p className="lbl mk-locked" style={{ padding: 'var(--r-8) 0', display: 'block' }}>
          This timesheet is locked. Corrections need it reopened first.
        </p>
      )}

      <div className="correction-list">
        {events.length === 0 && (
          <p className="lead" style={{ color: 'var(--muted)' }}>
            No events recorded for this day.
          </p>
        )}

        {events.map((e) => (
          <EventRow
            key={e.id}
            event={e}
            jobs={jobs}
            activities={activities}
            editing={editingId === e.id}
            pending={pending}
            result={results[e.id]}
            onStartEdit={() => setEditingId(e.id)}
            onCancelEdit={() => setEditingId(null)}
            onCorrect={(changes, reason) => {
              startTransition(async () => {
                const result = await correctAttendanceEvent({
                  eventId: e.id,
                  timesheetId: timesheet.id,
                  ...changes,
                  reason,
                });
                setResults((prev) => ({ ...prev, [e.id]: result }));
                if (result.ok) setEditingId(null);
              });
            }}
            onVoid={(reason) => {
              startTransition(async () => {
                const result = await voidAttendanceEvent({
                  eventId: e.id,
                  timesheetId: timesheet.id,
                  reason,
                });
                setResults((prev) => ({ ...prev, [e.id]: result }));
              });
            }}
          />
        ))}
      </div>

      <div className="correction-add">
        {!adding ? (
          <button className="act" onClick={() => setAdding(true)} disabled={locked}>
            + Add a time the worker never clocked
          </button>
        ) : (
          <AddEventForm
            jobs={jobs}
            activities={activities}
            pending={pending}
            result={results.__add}
            onCancel={() => setAdding(false)}
            onSubmit={(input) => {
              startTransition(async () => {
                const result = await addMissingAttendanceEvent({
                  timesheetId: timesheet.id,
                  ...input,
                });
                setResults((prev) => ({ ...prev, __add: result }));
                if (result.ok) setAdding(false);
              });
            }}
          />
        )}
      </div>
    </>
  );
}

// --- one event row, with its inline correction form -------------------------

function EventRow({
  event,
  jobs,
  activities,
  editing,
  pending,
  result,
  onStartEdit,
  onCancelEdit,
  onCorrect,
  onVoid,
}: {
  event: TimesheetDetailEvent;
  jobs: JobOption[];
  activities: ActivityOption[];
  editing: boolean;
  pending: boolean;
  result: ActionResult | undefined;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCorrect: (
    changes: { deviceTime?: string; jobId?: string | null; workActivityId?: string | null },
    reason: string,
  ) => void;
  onVoid: (reason: string) => void;
}) {
  const [deviceTime, setDeviceTime] = useState(toLocalInputValue(event.deviceTime));
  const [jobId, setJobId] = useState(event.jobId ?? '');
  const [workActivityId, setWorkActivityId] = useState(event.workActivityId ?? '');
  const [reason, setReason] = useState('');

  return (
    <div className="correction-row" data-suggested={event.isSuggested ? '' : undefined}>
      <div className="correction-row__main">
        <span className="lbl" style={{ color: 'var(--bone)', minWidth: '9ch' }}>
          {EVENT_LABELS[event.eventType]}
        </span>
        <span className="lbl" style={{ color: 'var(--muted)' }}>{formatTime(event.deviceTime)}</span>
        <span className="lbl" style={{ color: 'var(--faint)' }}>
          {event.jobNumber ? `Job ${event.jobNumber}` : 'No job'}
          {event.activityName ? ` · ${event.activityName}` : ''}
        </span>
        {/* Manual is the fallback path now, not the default — flagged rather
            than shown in the same faint tone as everything else, and its
            distance from site is always shown, not only when it lands
            off-site: a manual clock is the one worth a second look either
            way, on-site or not. */}
        {event.clockMethod === 'manual' ? (
          <span className="mk mk-setout">MANUAL</span>
        ) : (
          <span className="lbl" style={{ color: 'var(--faintest)' }}>{event.clockMethod}</span>
        )}
        {event.clockMethod === 'manual' &&
          event.insideGeofence !== false &&
          event.distanceM != null && (
            <span className="lbl" style={{ color: 'var(--muted)' }}>
              {Math.round(event.distanceM)}m from site
            </span>
          )}
        {event.insideGeofence === false && (
          <span className="mk mk-breach">
            {event.distanceM != null ? `${Math.round(event.distanceM)}M OFF-SITE` : 'OFF-SITE'}
          </span>
        )}
        {event.isSuggested && <span className="mk mk-setout">Unconfirmed</span>}

        <span className="grow" style={{ marginLeft: 'auto' }} />

        {!editing && (
          <>
            <button className="act" onClick={onStartEdit} disabled={pending}>Correct</button>
            <button
              className="act"
              disabled={pending}
              onClick={() => {
                const why = window.prompt('Why is this event being removed?');
                if (why?.trim()) onVoid(why.trim());
              }}
            >
              Remove
            </button>
          </>
        )}
      </div>

      {editing && (
        <div className="correction-row__form">
          <label className="lbl">
            Time
            <input
              type="datetime-local"
              value={deviceTime}
              onChange={(e) => setDeviceTime(e.target.value)}
            />
          </label>
          <label className="lbl">
            Job
            <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">No job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.jobNumber}</option>
              ))}
            </select>
          </label>
          <label className="lbl">
            Activity
            <select value={workActivityId} onChange={(e) => setWorkActivityId(e.target.value)}>
              <option value="">No activity</option>
              {activities.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="lbl" style={{ flex: 1, minWidth: '24ch' }}>
            Reason
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required — why is this changing?"
            />
          </label>
          <button
            className="btn"
            disabled={pending || !reason.trim()}
            onClick={() =>
              onCorrect(
                {
                  deviceTime: fromLocalInputValue(deviceTime),
                  jobId: jobId || null,
                  workActivityId: workActivityId || null,
                },
                reason.trim(),
              )
            }
          >
            Save
          </button>
          <button className="act" onClick={onCancelEdit} disabled={pending}>Cancel</button>
        </div>
      )}

      {result && (
        <span className={`lbl ${result.ok ? '' : 'mk-breach'}`} style={{ color: result.ok ? 'var(--cad-green)' : undefined }}>
          {result.message}
        </span>
      )}
    </div>
  );
}

// --- add-missing-event form ---------------------------------------------------

function AddEventForm({
  jobs,
  activities,
  pending,
  result,
  onCancel,
  onSubmit,
}: {
  jobs: JobOption[];
  activities: ActivityOption[];
  pending: boolean;
  result: ActionResult | undefined;
  onCancel: () => void;
  onSubmit: (input: {
    eventType: AttendanceEventType;
    deviceTime: string;
    jobId?: string | null;
    workActivityId?: string | null;
    reason: string;
  }) => void;
}) {
  const [eventType, setEventType] = useState<AttendanceEventType>('clock_in');
  const [deviceTime, setDeviceTime] = useState('');
  const [jobId, setJobId] = useState('');
  const [workActivityId, setWorkActivityId] = useState('');
  const [reason, setReason] = useState('');

  const canSubmit = deviceTime && reason.trim().length > 0;

  return (
    <div className="correction-row__form">
      <label className="lbl">
        Type
        <select value={eventType} onChange={(e) => setEventType(e.target.value as AttendanceEventType)}>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{EVENT_LABELS[t]}</option>
          ))}
        </select>
      </label>
      <label className="lbl">
        Time
        <input type="datetime-local" value={deviceTime} onChange={(e) => setDeviceTime(e.target.value)} />
      </label>
      <label className="lbl">
        Job
        <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">No job</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.jobNumber}</option>
          ))}
        </select>
      </label>
      <label className="lbl">
        Activity
        <select value={workActivityId} onChange={(e) => setWorkActivityId(e.target.value)}>
          <option value="">No activity</option>
          {activities.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <label className="lbl" style={{ flex: 1, minWidth: '24ch' }}>
        Reason
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Required — why is this being added?"
        />
      </label>
      <button
        className="btn"
        disabled={pending || !canSubmit}
        onClick={() =>
          onSubmit({
            eventType,
            deviceTime: fromLocalInputValue(deviceTime),
            jobId: jobId || null,
            workActivityId: workActivityId || null,
            reason: reason.trim(),
          })
        }
      >
        Add
      </button>
      <button className="act" onClick={onCancel} disabled={pending}>Cancel</button>
      {result && (
        <span style={{ color: result.ok ? 'var(--cad-green)' : 'var(--cad-magenta)' }}>{result.message}</span>
      )}
    </div>
  );
}

// --- formatting ---------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in the browser's own timezone. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reverses toLocalInputValue back to a real ISO instant. new Date() on a
 * timezone-less "datetime-local" string parses it in the browser's own zone,
 * which is what a supervisor typing a time actually means. */
function fromLocalInputValue(local: string): string {
  return new Date(local).toISOString();
}
