'use client';

/**
 * SHT 01's site plan: last clock positions over the site geofences.
 *
 * Honest about what it is — these are positions recorded at clock events,
 * not live tracking; the caption says so.
 *
 * Privacy rule, deliberate and load-bearing: ONLY on-site positions are
 * ever drawn. A worker who clocked from outside the fence appears in the
 * table above as a distance ("4.1km away") — never as a point on an aerial
 * photo, because that point is somebody's driveway, not a work location.
 * The attendance record itself still carries what the exception process
 * needs; the map is a picture of the sites, not of the people.
 */

import { MapContainer, TileLayer, Circle, CircleMarker, Tooltip } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteSummary, WorkingNowRow } from '@skelclock/server';

const STEEL = '#8aaac8';
const YELLOW = '#ffcf2e';

const DEFAULT_CENTER: LatLngExpression = [-34.4248, 150.8931]; // Wollongong

export function WorkingMap({
  rows,
  sites,
}: {
  rows: WorkingNowRow[];
  sites: SiteSummary[];
}) {
  const placedSites = sites.filter((s) => s.latitude != null && s.longitude != null);
  const located = rows.filter(
    (r) =>
      r.lastLatitude != null &&
      r.lastLongitude != null &&
      // The privacy rule from the header: on-site pins only.
      r.locationStatus === 'inside',
  );

  const center: LatLngExpression =
    located.length > 0
      ? [located[0]!.lastLatitude!, located[0]!.lastLongitude!]
      : placedSites.length > 0
        ? [placedSites[0]!.latitude!, placedSites[0]!.longitude!]
        : DEFAULT_CENTER;

  return (
    <div className="working-map">
      <MapContainer center={center} zoom={13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, Maxar, Earthstar Geographics, and the GIS User Community'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxZoom={19}
        />

        {placedSites.map((s) => (
          <Circle
            key={s.id}
            center={[s.latitude!, s.longitude!]}
            radius={s.geofenceRadiusM}
            pathOptions={{ color: STEEL, fillOpacity: 0.05, weight: 1, dashArray: '2 4' }}
          >
            <Tooltip direction="top">{s.name}</Tooltip>
          </Circle>
        ))}

        {located.map((r) => {
          const colour = r.onBreak ? YELLOW : STEEL;
          return (
            <CircleMarker
              key={r.employeeId}
              center={[r.lastLatitude!, r.lastLongitude!]}
              radius={7}
              pathOptions={{ color: colour, fillColor: colour, fillOpacity: 0.85, weight: 1 }}
            >
              <Tooltip direction="top">
                {r.employeeName} · {r.hoursWorkedLabel}
                {r.jobNumber ? ` · Job ${r.jobNumber}` : ''}
                {r.lastFixAt ? ` · fixed ${timeOf(r.lastFixAt)}` : ''}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
