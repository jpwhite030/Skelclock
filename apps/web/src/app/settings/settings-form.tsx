'use client';

import { useState, useTransition } from 'react';

import type { CompanySettings, PayrollPeriodKind, TravelAllocation } from '@skelclock/server';

import { savePayrollSettings, type ActionResult } from './server-actions';

const TRAVEL_OPTIONS: Array<{ value: TravelAllocation; label: string; hint: string }> = [
  {
    value: 'unallocated',
    label: 'Costed to neither site',
    hint: "Today's behaviour — travel between two jobs is paid but not billed to either.",
  },
  {
    value: 'first_site',
    label: 'Costed to the site just left',
    hint: 'Travel counts against the job the worker was leaving.',
  },
  {
    value: 'second_site',
    label: 'Costed to the site travelled to',
    hint: 'Travel counts against the job the worker was heading to.',
  },
];

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

export function SettingsForm({ settings }: { settings: CompanySettings }) {
  const [autoLunchEnabled, setAutoLunchEnabled] = useState(settings.autoLunchEnabled);
  const [thresholdHours, setThresholdHours] = useState(
    (settings.autoLunchThresholdMinutes / 60).toString(),
  );
  const [durationMinutes, setDurationMinutes] = useState(
    settings.autoLunchDurationMinutes.toString(),
  );
  const [travelAllocation, setTravelAllocation] = useState<TravelAllocation>(
    settings.travelAllocation,
  );
  const [hoursStart, setHoursStart] = useState(toTimeInput(settings.operatingHoursStart));
  const [hoursEnd, setHoursEnd] = useState(toTimeInput(settings.operatingHoursEnd));
  const [dwellMinutes, setDwellMinutes] = useState(settings.geofenceMinDwellMinutes.toString());
  const [payrollPeriod, setPayrollPeriod] = useState<PayrollPeriodKind>(settings.payrollPeriod);
  const [weekStartsOn, setWeekStartsOn] = useState(settings.payrollWeekStartsOn);
  const [anchorDate, setAnchorDate] = useState(settings.payrollAnchorDate ?? '');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const save = () => {
    startTransition(async () => {
      const outcome = await savePayrollSettings({
        autoLunchEnabled,
        autoLunchThresholdMinutes: Math.round(Number(thresholdHours) * 60),
        autoLunchDurationMinutes: Number(durationMinutes),
        travelAllocation,
        operatingHoursStart: hoursStart || null,
        operatingHoursEnd: hoursEnd || null,
        geofenceMinDwellMinutes: Number(dwellMinutes),
        payrollPeriod,
        payrollWeekStartsOn: weekStartsOn,
        payrollAnchorDate: anchorDate || null,
      });
      setResult(outcome);
    });
  };

  return (
    <div className="settings-form">
      <section className="card">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Auto-lunch</h2>
        <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
          Deducts an unpaid lunch automatically on a long shift where the worker never
          clocked a break at all. A worker who clocks any break, paid or not, is never
          also docked this — it only fills the gap when they forgot.
        </p>

        <label className="lbl settings-form__row">
          <input
            type="checkbox"
            checked={autoLunchEnabled}
            onChange={(e) => setAutoLunchEnabled(e.target.checked)}
          />
          Enabled
        </label>

        <label className="lbl settings-form__row">
          Shift length that triggers it (hours)
          <input
            type="number"
            min={1}
            step={0.5}
            value={thresholdHours}
            onChange={(e) => setThresholdHours(e.target.value)}
            disabled={!autoLunchEnabled}
          />
        </label>

        <label className="lbl settings-form__row">
          Minutes deducted
          <input
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            disabled={!autoLunchEnabled}
          />
        </label>
      </section>

      <section className="card">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Travel between sites</h2>
        <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
          When a worker changes job mid-shift, which site (if either) the travel time
          in between is costed to.
        </p>
        {TRAVEL_OPTIONS.map((opt) => (
          <label key={opt.value} className="lbl settings-form__row" style={{ alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="travel"
              checked={travelAllocation === opt.value}
              onChange={() => setTravelAllocation(opt.value)}
              style={{ marginTop: 3 }}
            />
            <span>
              {opt.label}
              <span className="settings-form__hint">{opt.hint}</span>
            </span>
          </label>
        ))}
      </section>

      <section className="card">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Operating hours</h2>
        <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
          A clock-in outside this window is refused outright — not flagged, refused.
          Clocking out is never affected, so a shift that runs late is never trapped
          open. A supervisor filling in a missed time bypasses this; it only applies to
          a worker's own clock. Leave both blank for no restriction. Local to{' '}
          {settings.timezone}.
        </p>
        <label className="lbl settings-form__row">
          Opens
          <input type="time" value={hoursStart} onChange={(e) => setHoursStart(e.target.value)} />
        </label>
        <label className="lbl settings-form__row">
          Closes
          <input type="time" value={hoursEnd} onChange={(e) => setHoursEnd(e.target.value)} />
        </label>
        <p className="lead" style={{ color: 'var(--faint)', fontSize: 13 }}>
          Closes earlier than it opens — e.g. 22:00 to 06:00 — is read as an overnight
          window, not an error.
        </p>
      </section>

      <section className="card">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Minimum time on site</h2>
        <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
          How long the phone has to see someone inside a site fence before it clocks
          them on by itself. Driving past a job, or parking next to one for a coffee,
          crosses a fence exactly the way turning up for work does — this is what tells
          them apart.
        </p>
        <label className="lbl settings-form__row">
          Minutes
          <input
            type="number"
            min={0}
            max={120}
            value={dwellMinutes}
            onChange={(e) => setDwellMinutes(e.target.value)}
          />
        </label>
        <p className="lead" style={{ color: 'var(--faint)', fontSize: 13 }}>
          Nobody is ever refused a clock-on by this — an arrival that has not waited
          long enough just asks for a tap instead of going through on its own. Set 0 to
          turn it off. Only applies to automatic detection; tapping Clock On is
          immediate either way.
        </p>
      </section>

      <section className="card">
        <h2 className="lbl" style={{ color: 'var(--bone)' }}>Pay period</h2>
        <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
          What a pay run covers. Timesheets are grouped and filtered by this.
        </p>

        <label className="lbl settings-form__row" style={{ alignItems: 'flex-start' }}>
          <input
            type="radio"
            name="payroll-period"
            checked={payrollPeriod === 'weekly'}
            onChange={() => setPayrollPeriod('weekly')}
            style={{ marginTop: 3 }}
          />
          <span>
            Weekly
            <span className="settings-form__hint">One week per pay run.</span>
          </span>
        </label>
        <label className="lbl settings-form__row" style={{ alignItems: 'flex-start' }}>
          <input
            type="radio"
            name="payroll-period"
            checked={payrollPeriod === 'fortnightly'}
            onChange={() => setPayrollPeriod('fortnightly')}
            style={{ marginTop: 3 }}
          />
          <span>
            Fortnightly
            <span className="settings-form__hint">Two weeks per pay run.</span>
          </span>
        </label>

        <label className="lbl settings-form__row">
          Week starts on
          <select
            value={weekStartsOn}
            onChange={(e) => setWeekStartsOn(Number(e.target.value))}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        {/*
          Only asked for when it is actually needed. Two companies both paying
          fortnightly can be a week out of step, so which fortnight is which is
          not something arithmetic can work out — it has to be recorded.
        */}
        {payrollPeriod === 'fortnightly' && (
          <>
            <label className="lbl settings-form__row">
              A date in the first fortnight
              <input
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </label>
            <p className="lead" style={{ color: 'var(--faint)', fontSize: 13 }}>
              Any day inside one of your pay fortnights. Every later fortnight is
              counted from the week this date falls in, so pick one you are sure
              about — changing it later shifts which fortnight every timesheet
              belongs to.
            </p>
          </>
        )}
      </section>

      <div className="settings-form__save">
        <button className="btn" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {result && (
          <span style={{ color: result.ok ? 'var(--cad-green)' : 'var(--cad-magenta)' }}>
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}

function toTimeInput(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}
