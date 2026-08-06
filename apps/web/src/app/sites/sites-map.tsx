'use client';

/**
 * Draggable geofence map.
 *
 * Odoo's address text is not precise enough to place a useful geofence (see
 * the GEO_NOTE in packages/server/src/import.ts), so this is where a human
 * corrects it: drag the pin to where the gate actually is, adjust the radius,
 * save. `saveSiteLocation` is the only thing that writes site.latitude /
 * longitude / geofence_radius_m outside of the Odoo import.
 */

import { Fragment, useMemo, useState, useTransition } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents } from 'react-leaflet';
import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteSummary } from '@skelclock/server';

import { saveSiteLocation } from './server-actions';

// Leaflet's default marker images are resolved as relative URLs against the
// CSS file, which breaks under Next's bundler. An inline SVG sidesteps the
// asset-path problem entirely rather than fighting webpack's url-loader.
function pinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'site-pin',
    html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
      <path d="M13 0C5.8 0 0 5.8 0 13c0 9.5 13 21 13 21s13-11.5 13-21C26 5.8 20.2 0 13 0z" fill="${color}"/>
      <circle cx="13" cy="13" r="5.5" fill="#fff"/>
    </svg>`,
    iconSize: [26, 34],
    iconAnchor: [13, 34],
  });
}

/* SETOUT legend, not stock swatches: steel is the recorded colour of the gear
   and marks a fence that is set; yellow means "in hand" — moved, not saved. */
const STEEL = '#8aaac8';
const IN_HAND = '#ffcf2e';

const SAVED_ICON = pinIcon(STEEL);
const DIRTY_ICON = pinIcon(IN_HAND);

const DEFAULT_CENTER: LatLngExpression = [-34.4248, 150.8931]; // Wollongong — SkelScaff's patch

interface Draft {
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
  dirty: boolean;
}

function toDrafts(sites: SiteSummary[]): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const s of sites) {
    if (s.latitude == null || s.longitude == null) continue;
    out[s.id] = {
      latitude: s.latitude,
      longitude: s.longitude,
      geofenceRadiusM: s.geofenceRadiusM,
      dirty: false,
    };
  }
  return out;
}

/** Lets an unplaced site be dropped by clicking the map, while `armedSiteId` is set. */
function PlaceOnClick({
  armedSiteId,
  onPlace,
}: {
  armedSiteId: string | null;
  onPlace: (siteId: string, lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (armedSiteId) onPlace(armedSiteId, e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export function SitesMap({ sites, canEdit }: { sites: SiteSummary[]; canEdit: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => toDrafts(sites));
  const [armedSiteId, setArmedSiteId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const center = useMemo<LatLngExpression>(() => {
    const first = Object.values(drafts)[0];
    return first ? [first.latitude, first.longitude] : DEFAULT_CENTER;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial center only, the map pans on its own after

  const placeOrMove = (siteId: string, lat: number, lng: number) => {
    setDrafts((prev) => ({
      ...prev,
      [siteId]: {
        latitude: lat,
        longitude: lng,
        geofenceRadiusM: prev[siteId]?.geofenceRadiusM ?? 200,
        dirty: true,
      },
    }));
    setArmedSiteId(null);
  };

  const setRadius = (siteId: string, radius: number) => {
    setDrafts((prev) => {
      const draft = prev[siteId];
      if (!draft) return prev;
      return { ...prev, [siteId]: { ...draft, geofenceRadiusM: radius, dirty: true } };
    });
  };

  const save = (siteId: string) => {
    const draft = drafts[siteId];
    if (!draft) return;
    setSavingId(siteId);
    startTransition(async () => {
      const result = await saveSiteLocation({
        siteId,
        latitude: draft.latitude,
        longitude: draft.longitude,
        geofenceRadiusM: draft.geofenceRadiusM,
      });
      setResults((prev) => ({ ...prev, [siteId]: result }));
      if (result.ok) {
        setDrafts((prev) => ({ ...prev, [siteId]: { ...draft, dirty: false } }));
      }
      setSavingId(null);
    });
  };

  return (
    <div className="sites-layout">
      <div className="sites-list">
        {sites.map((site) => {
          const draft = drafts[site.id];
          const result = results[site.id];
          return (
            <div key={site.id} className="site-row" data-hold={draft?.dirty ? '' : undefined}>
              <div className="site-row-header">
                <span className="site-row-name">{site.name}</span>
                {draft?.dirty && <span className="mk mk-setout">Moved</span>}
                {!draft && <span className="mk mk-setout">No pin</span>}
              </div>
              {site.address && <div className="site-row-meta">{site.address}</div>}
              <div className="site-row-meta">
                {site.jobCount} active job{site.jobCount === 1 ? '' : 's'}
              </div>

              {canEdit && draft && (
                <div className="site-row-controls">
                  <label className="lbl">
                    Radius m
                    <input
                      type="number"
                      min={10}
                      step={10}
                      value={draft.geofenceRadiusM}
                      onChange={(e) => setRadius(site.id, Number(e.target.value))}
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={!draft.dirty || (pending && savingId === site.id)}
                    onClick={() => save(site.id)}
                  >
                    {pending && savingId === site.id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}

              {canEdit && !draft && (
                <button
                  className="act"
                  data-busy={armedSiteId === site.id ? '' : undefined}
                  disabled={armedSiteId === site.id}
                  onClick={() => setArmedSiteId(site.id)}
                >
                  {armedSiteId === site.id ? 'Click the map to place it…' : 'Place on map'}
                </button>
              )}

              {result && (
                <span className={`mk ${result.ok ? 'mk-approved' : 'mk-breach'}`}>
                  {result.message}
                </span>
              )}
            </div>
          );
        })}
        {sites.length === 0 && (
          <div className="site-row site-row-meta">
            No sites yet. They arrive with the next job import from Odoo.
          </div>
        )}
      </div>

      <div className="sites-map-panel">
        <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <PlaceOnClick armedSiteId={armedSiteId} onPlace={placeOrMove} />
          {sites.map((site) => {
            const draft = drafts[site.id];
            if (!draft) return null;
            const position: LatLngExpression = [draft.latitude, draft.longitude];
            return (
              <Fragment key={site.id}>
                <Circle
                  center={position}
                  radius={draft.geofenceRadiusM}
                  pathOptions={{
                    color: draft.dirty ? IN_HAND : STEEL,
                    fillOpacity: 0.08,
                    weight: 1,
                  }}
                />
                <Marker
                  position={position}
                  icon={draft.dirty ? DIRTY_ICON : SAVED_ICON}
                  draggable={canEdit}
                  eventHandlers={{
                    dragend: (e) => {
                      const marker = e.target as L.Marker;
                      const { lat, lng } = marker.getLatLng();
                      placeOrMove(site.id, lat, lng);
                    },
                  }}
                />
              </Fragment>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}
