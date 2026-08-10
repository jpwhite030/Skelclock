'use client';

/**
 * Per-site operating hours and employee lockouts.
 *
 * Separate from SitesMap deliberately: that component is the geofence editor
 * (lat/lng/radius, a Leaflet map, drag state) and neither of these has a
 * position on a map — bolting them on there would mean every future change
 * to the pin editor has to reason about unrelated form state too.
 */

import { useState, useTransition } from 'react';

import type { SiteExclusion, SiteSummary } from '@skelclock/server';

import { excludeEmployeeFromSite, removeExclusion, saveSiteHours } from './server-actions';

interface EmployeeOption {
  id: string;
  fullName: string;
}

export function SiteAccessPanel({
  sites,
  exclusions,
  employees,
  canEdit,
}: {
  sites: SiteSummary[];
  exclusions: SiteExclusion[];
  employees: EmployeeOption[];
  canEdit: boolean;
}) {
  return (
    <div className="site-access">
      <div className="sht" style={{ paddingTop: 'var(--r-2)' }}>
        <h2 className="dsp" style={{ fontSize: 20 }}>Hours &amp; access</h2>
      </div>

      <SiteHoursList sites={sites} canEdit={canEdit} />
      <ExclusionsPanel sites={sites} exclusions={exclusions} employees={employees} canEdit={canEdit} />
    </div>
  );
}

// --- per-site operating hours -------------------------------------------------

function SiteHoursList({ sites, canEdit }: { sites: SiteSummary[]; canEdit: boolean }) {
  return (
    <section className="card" style={{ maxWidth: '80ch' }}>
      <h3 className="lbl" style={{ color: 'var(--bone)' }}>Site operating hours</h3>
      <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
        Overrides the company default from Settings for this site only. Leave both blank
        to follow the company default (or have no restriction, if it has none either).
      </p>
      {sites.map((s) => (
        <SiteHoursRow key={s.id} site={s} canEdit={canEdit} />
      ))}
    </section>
  );
}

function SiteHoursRow({ site, canEdit }: { site: SiteSummary; canEdit: boolean }) {
  const [start, setStart] = useState(toTimeInput(site.operatingHoursStart));
  const [end, setEnd] = useState(toTimeInput(site.operatingHoursEnd));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="settings-form__row" style={{ justifyContent: 'space-between' }}>
      <span style={{ minWidth: '20ch', color: 'var(--bone)' }}>{site.name}</span>
      <input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        disabled={!canEdit}
        aria-label={`${site.name} opens`}
      />
      <span aria-hidden="true">→</span>
      <input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        disabled={!canEdit}
        aria-label={`${site.name} closes`}
      />
      {canEdit && (
        <button
          className="act"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await saveSiteHours({ siteId: site.id, start: start || null, end: end || null });
              setMessage(result.message);
            })
          }
        >
          Save
        </button>
      )}
      {message && <span style={{ color: 'var(--cad-green)' }}>{message}</span>}
    </div>
  );
}

// --- employee exclusions ------------------------------------------------------

function ExclusionsPanel({
  sites,
  exclusions,
  employees,
  canEdit,
}: {
  sites: SiteSummary[];
  exclusions: SiteExclusion[];
  employees: EmployeeOption[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section className="card" style={{ maxWidth: '80ch' }}>
      <h3 className="lbl" style={{ color: 'var(--bone)' }}>Excluded employees</h3>
      <p className="lead" style={{ color: 'var(--muted)', fontSize: 14 }}>
        A hard lockout — an excluded employee cannot clock in at this site by any
        method, manual or automatic. Use it for someone who lives or regularly is near a
        site and would otherwise trigger false auto-detect suggestions.
      </p>

      {exclusions.length === 0 && (
        <p className="lead" style={{ color: 'var(--faint)', fontSize: 14 }}>
          No exclusions on file.
        </p>
      )}

      {exclusions.map((x) => (
        <div key={x.id} className="settings-form__row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--bone)' }}>{x.employeeName}</span>
          <span aria-hidden="true">×</span>
          <span>{x.siteName}</span>
          <span className="settings-form__hint" style={{ flex: 1 }}>{x.reason}</span>
          {canEdit && (
            <button
              className="act"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await removeExclusion(x.id);
                })
              }
            >
              Remove
            </button>
          )}
        </div>
      ))}

      {canEdit && !adding && (
        <button className="act" onClick={() => setAdding(true)}>+ Exclude an employee from a site</button>
      )}

      {canEdit && adding && (
        <div className="correction-row__form">
          <label className="lbl">
            Employee
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName}</option>
              ))}
            </select>
          </label>
          <label className="lbl">
            Site
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">Select…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="lbl" style={{ flex: 1, minWidth: '24ch' }}>
            Reason
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. lives next door"
            />
          </label>
          <button
            className="btn"
            disabled={pending || !employeeId || !siteId || !reason.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await excludeEmployeeFromSite({ employeeId, siteId, reason: reason.trim() });
                setMessage(result.message);
                if (result.ok) {
                  setAdding(false);
                  setEmployeeId('');
                  setSiteId('');
                  setReason('');
                }
              })
            }
          >
            Exclude
          </button>
          <button className="act" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
        </div>
      )}
      {message && <span style={{ color: 'var(--cad-green)' }}>{message}</span>}
    </section>
  );
}

function toTimeInput(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}
