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

import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from 'react-leaflet';
import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteSummary } from '@skelclock/server';

import {
  addressAtPin,
  createSite,
  geocodeAddress,
  saveSiteLocation,
  type GeocodeCandidate,
} from './server-actions';

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

/** Recentres the map when a geocoded address lands somewhere else entirely —
 * MapContainer's own `center` prop only ever applies once, on first paint.
 * Depends on the scalar coordinates, not a position array: an array literal
 * is a new identity every render, and flying on every render means the map
 * re-centres each time a letter is typed into the name field. */
function FlyTo({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo([latitude, longitude], 17);
  }, [map, latitude, longitude]);
  return null;
}

/**
 * Reports the map's centre and bounds as the office pans and zooms.
 *
 * The centre feeds the address search: street names repeat across NSW, and a
 * lookup fenced to where you are looking is the difference between finding
 * your street in Balgownie and one in Sydney (see geocode.ts).
 */
function ViewWatcher({ onView }: { onView: (centre: L.LatLng, bounds: L.LatLngBounds) => void }) {
  const map = useMap();
  useEffect(() => {
    const report = () => onView(map.getCenter(), map.getBounds());
    report();
    map.on('moveend zoomend', report);
    return () => {
      map.off('moveend zoomend', report);
    };
  }, [map, onView]);
  return null;
}

/**
 * The two ways to look at a site, because they answer different questions.
 *
 * Aerial is how you put a pin on a gate — a scaffold entrance is a thing you
 * can see in a photograph and cannot see on a line drawing. Property is the
 * NSW Base Map, which draws the cadastre and, crucially, the street numbers:
 * it is how you check the pin is on number 63 and not on 59 next door.
 *
 * Property leads, because "is this the right house" is the question that was
 * getting answered wrong. Aerial is one click away for the gate itself.
 *
 * The NSW service covers NSW only. Outside it the tiles come back empty, which
 * is exactly when the Aerial toggle earns its place.
 */
const BASEMAPS = {
  property: {
    name: 'Property',
    url: 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Base_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Basemap &copy; Department of Customer Service (Spatial Services) NSW',
    maxZoom: 21,
  },
  aerial: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    name: 'Aerial',
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;

/**
 * GURAS shouts — "63 KEMBLA STREET WOLLONGONG". That is how the register
 * stores it, not how anyone wants to read a site list, so it is cased down for
 * display. The register's own string is what gets saved as the address.
 */
function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * The company default fence, in metres. One number, used wherever a new site
 * is created, so a fence is never quietly sized by how well a search went.
 */
const DEFAULT_GEOFENCE_RADIUS_M = 70;

interface NewSiteDraft {
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
  hoursStart: string;
  hoursEnd: string;
  /** Carried from the search so the panel can say the pin is a guess. */
  precision: GeocodeCandidate['precision'];
  /** Which register found it — an authoritative NSW property point, or OSM's
   * best guess. The panel says so, because they deserve different trust. */
  source: GeocodeCandidate['source'];
  /** The search dropped words to find this, so the suburb asked for did not
   * match. A near miss that looks exactly like a hit unless it is labelled. */
  loosened: boolean;
  /** True until the office drags the pin, which is what makes it real. */
  pinUnconfirmed: boolean;
}

/** A short, human name from a Nominatim display_name — its first comma-
 * separated segment is usually the building/street number, not the suburb
 * and state that make the rest of the string too long for a site name. */
function nameFromAddress(label: string): string {
  return label.split(',')[0]?.trim() ?? label;
}

export function SitesMap({ sites, canEdit }: { sites: SiteSummary[]; canEdit: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => toDrafts(sites));

  /**
   * Take in sites that appeared after mount.
   *
   * The initialiser above runs once. Saving a new site calls revalidatePath,
   * which re-renders the server component and hands down a longer `sites`
   * prop — but useState ignores it, so the new site had a row in the list, a
   * "No pin" badge, and nothing on the map. It had saved correctly every time;
   * it just had no draft to draw from, and the only way to see it was a full
   * page reload.
   *
   * Only ever adds. A draft already held here may carry an unsaved drag, and
   * re-seeding from the server would throw that away mid-edit — which is the
   * trap that makes "just re-run toDrafts" the wrong fix.
   */
  useEffect(() => {
    setDrafts((prev) => {
      const incoming = toDrafts(sites);
      const missing = Object.keys(incoming).filter((id) => !(id in prev));
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const id of missing) next[id] = incoming[id]!;
      return next;
    });
  }, [sites]);
  const [armedSiteId, setArmedSiteId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  // --- adding a new site by address --------------------------------------
  const [addingSite, setAddingSite] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GeocodeCandidate[] | null>(null);
  const [newSite, setNewSite] = useState<NewSiteDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>('property');
  /** The address the NSW register says is under the dragged pin, waiting for
   * the office to accept or ignore it. */
  const [addressPrompt, setAddressPrompt] = useState<string | null>(null);

  /** Where the map is looking. Feeds the address search; see ViewWatcher. */
  const [view, setView] = useState<{ centre: L.LatLng; bounds: L.LatLngBounds } | null>(null);
  const onView = useCallback((centre: L.LatLng, bounds: L.LatLngBounds) => {
    setView({ centre, bounds });
  }, []);

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
        geofenceRadiusM: prev[siteId]?.geofenceRadiusM ?? 70,
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

  const cancelAdd = () => {
    setAddingSite(false);
    setQuery('');
    setSearching(false);
    setSearchResults(null);
    setNewSite(null);
    setAddMessage(null);
    setAddressPrompt(null);
  };

  const runSearch = async () => {
    setSearching(true);
    setSearchResults(null);
    const results = await geocodeAddress(
      query,
      view ? { latitude: view.centre.lat, longitude: view.centre.lng } : undefined,
    );
    setSearchResults(results);
    setSearching(false);
  };

  const pickResult = (r: GeocodeCandidate) => {
    setNewSite({
      name: r.source === 'nsw' ? titleCase(r.label) : nameFromAddress(r.label),
      address: r.source === 'nsw' ? titleCase(r.label) : r.label,
      latitude: r.latitude,
      longitude: r.longitude,
      // Always 70m, the company default — never widened to compensate for a
      // vague geocode.
      //
      // This used to open to 250m on an inexact match, on the reasoning that a
      // pin dropped on a road centroid needs a fence big enough to still cover
      // the site. That was the wrong lever: it silently changed a payroll
      // boundary to paper over a search problem, so a site could end up fenced
      // four times wider than intended and nobody would know why. The fix for
      // a bad pin is a better pin — hence the warning below and the drag — not
      // a bigger circle.
      geofenceRadiusM: DEFAULT_GEOFENCE_RADIUS_M,
      hoursStart: '',
      hoursEnd: '',
      precision: r.precision,
      source: r.source,
      loosened: r.loosened,
      // A NSW property point is the site — there is nothing to confirm. Only a
      // road centroid, an area, or a near miss needs the office to drag it.
      pinUnconfirmed: r.precision !== 'address' || r.loosened,
    });
    setSearchResults(null);
  };

  const moveNewSite = (lat: number, lng: number) => {
    // Dragging the pin is the office saying where the site really is, so it
    // clears the guess flag — that is the only thing that does.
    setNewSite((prev) =>
      prev
        ? { ...prev, latitude: lat, longitude: lng, pinUnconfirmed: false, loosened: false }
        : prev,
    );

    // And the address follows the pin.
    //
    // It used not to, which was quietly the worst bug on this screen: the
    // office would drag a pin two doors up to the right gate and the site kept
    // the address that had been typed. Coordinates and address then disagreed
    // forever, and every screen downstream believed the string.
    //
    // Offered, not forced — `addressPrompt` puts it in front of the office to
    // accept. A pin dragged to a compound entrance is genuinely at a different
    // address from the site, and only a person knows which one to record.
    setAddressPrompt(null);
    void addressAtPin({ latitude: lat, longitude: lng }).then((found) => {
      if (found) setAddressPrompt(titleCase(found.label));
    });
  };

  const saveNewSite = () => {
    if (!newSite || !newSite.name.trim()) return;
    setCreating(true);
    startTransition(async () => {
      const result = await createSite({
        name: newSite.name,
        address: newSite.address,
        latitude: newSite.latitude,
        longitude: newSite.longitude,
        geofenceRadiusM: newSite.geofenceRadiusM,
        hoursStart: newSite.hoursStart || null,
        hoursEnd: newSite.hoursEnd || null,
      });
      if (result.ok) {
        cancelAdd();
      } else {
        setAddMessage(result.message);
      }
      setCreating(false);
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
        {canEdit && (
          <div className="site-add">
            {!addingSite ? (
              <button className="act" onClick={() => setAddingSite(true)}>+ Add a site</button>
            ) : (
              <div className="site-add__form">
                <div className="site-add__search">
                  <input
                    type="text"
                    placeholder="Search an address…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void runSearch();
                      }
                    }}
                    autoFocus
                  />
                  <button
                    className="act"
                    disabled={searching || query.trim().length < 3}
                    onClick={() => void runSearch()}
                  >
                    {searching ? 'Searching…' : 'Find'}
                  </button>
                  <button className="act" onClick={cancelAdd}>Cancel</button>
                </div>

                {searchResults && searchResults.length > 0 && !newSite && (
                  <div className="site-add__results">
                    {searchResults.map((r, i) => (
                      <button key={i} className="site-add__result" onClick={() => pickResult(r)}>
                        <span>{r.source === 'nsw' ? titleCase(r.label) : r.label}</span>
                        {/*
                          Three different ways a result can be less than it
                          looks, and all of them end with a fence in the wrong
                          place if nobody says so.

                          A near miss is the quietest and the worst: the search
                          dropped the suburb to find anything at all, so this is
                          the right street number in the wrong town. It reads
                          identically to a hit.
                        */}
                        {r.loosened && (
                          <span
                            className="lbl"
                            style={{ color: 'var(--cad-yellow)', marginLeft: '0.6em' }}
                          >
                            — not the suburb you asked for
                          </span>
                        )}
                        {!r.loosened && r.precision !== 'address' && (
                          <span
                            className="lbl"
                            style={{ color: 'var(--cad-yellow)', marginLeft: '0.6em' }}
                          >
                            {r.precision === 'street'
                              ? '— street only, drag the pin'
                              : '— area only, drag the pin'}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {searchResults && searchResults.length === 0 && (
                  <p className="lbl" style={{ color: 'var(--faint)' }}>
                    Nothing in the NSW address register or OpenStreetMap. Check
                    the spelling, or place the pin by hand on the map.
                  </p>
                )}

                {newSite && (
                  <>
                    {newSite.pinUnconfirmed && (
                      <p
                        className="lead"
                        style={{
                          color: 'var(--cad-yellow)',
                          borderLeft: '3px solid var(--cad-yellow)',
                          paddingLeft: '0.8em',
                          maxWidth: '52ch',
                        }}
                      >
                        {newSite.loosened
                          ? 'That suburb had no match, so this is the same street number somewhere else. Check the suburb on the pin before saving.'
                          : `The search only matched the ${
                              newSite.precision === 'street' ? 'street' : 'suburb'
                            }, not a street number — this pin is a guess and could be a long way from the site.`}{' '}
                        Drag it onto the gate before saving — the fence is {newSite.geofenceRadiusM}m
                        around wherever this pin ends up.
                      </p>
                    )}

                    {/*
                      Confirmed against the register. Worth saying: it is the
                      difference between a pin that is the property and a pin
                      that is somewhere on the road, and until now the screen
                      showed both the same way.
                    */}
                    {!newSite.pinUnconfirmed && newSite.source === 'nsw' && (
                      <p className="lbl" style={{ color: 'var(--cad-green)' }}>
                        Matched to the NSW address register — this pin is the property.
                      </p>
                    )}

                    {addressPrompt && addressPrompt !== newSite.address && (
                      <div className="site-add__prompt">
                        <span className="lbl" style={{ color: 'var(--faint)' }}>
                          The pin is now on
                        </span>{' '}
                        <span>{addressPrompt}</span>{' '}
                        <button
                          className="act"
                          onClick={() => {
                            setNewSite({ ...newSite, address: addressPrompt, name: addressPrompt });
                            setAddressPrompt(null);
                          }}
                        >
                          Use this address
                        </button>
                        <button className="act" onClick={() => setAddressPrompt(null)}>
                          Keep {newSite.address ?? 'the typed address'}
                        </button>
                      </div>
                    )}
                    <div className="correction-row__form">
                      <label className="lbl" style={{ flex: '1 1 100%' }}>
                        Site name
                        <input
                          type="text"
                          value={newSite.name}
                          onChange={(e) => setNewSite({ ...newSite, name: e.target.value })}
                        />
                      </label>
                      <label className="lbl">
                        Radius m
                        <input
                          type="number"
                          min={10}
                          step={10}
                          value={newSite.geofenceRadiusM}
                          onChange={(e) =>
                            setNewSite({ ...newSite, geofenceRadiusM: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label className="lbl">
                        Opens
                        <input
                          type="time"
                          value={newSite.hoursStart}
                          onChange={(e) => setNewSite({ ...newSite, hoursStart: e.target.value })}
                        />
                      </label>
                      <label className="lbl">
                        Closes
                        <input
                          type="time"
                          value={newSite.hoursEnd}
                          onChange={(e) => setNewSite({ ...newSite, hoursEnd: e.target.value })}
                        />
                      </label>
                      <button
                        className="btn"
                        disabled={creating || !newSite.name.trim()}
                        onClick={saveNewSite}
                      >
                        {creating ? 'Saving…' : 'Create site'}
                      </button>
                    </div>
                    <p className="site-add__hint">
                      Drag the pin on the map to line it up with the actual gate before saving.
                      Leave hours blank to follow the company default.
                    </p>
                  </>
                )}
                {addMessage && <span className="mk mk-breach">{addMessage}</span>}
              </div>
            )}
          </div>
        )}

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

      <div className="sites-map-panel" data-basemap={basemap}>
        <div className="sites-map-basemap">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map((key) => (
            <button
              key={key}
              className="act"
              data-busy={basemap === key ? '' : undefined}
              onClick={() => setBasemap(key)}
            >
              {BASEMAPS[key].name}
            </button>
          ))}
        </div>
        <MapContainer center={center} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          {/* `key` forces a fresh layer on switch: Leaflet keeps serving the
              old tile URL if only the prop changes. */}
          <TileLayer
            key={basemap}
            attribution={BASEMAPS[basemap].attribution}
            url={BASEMAPS[basemap].url}
            maxZoom={BASEMAPS[basemap].maxZoom}
          />
          <ViewWatcher onView={onView} />
          <PlaceOnClick armedSiteId={armedSiteId} onPlace={placeOrMove} />

          {newSite && (
            <Fragment>
              <FlyTo latitude={newSite.latitude} longitude={newSite.longitude} />
              <Circle
                center={[newSite.latitude, newSite.longitude]}
                radius={newSite.geofenceRadiusM}
                pathOptions={{ color: IN_HAND, fillOpacity: 0.08, weight: 1, dashArray: '4 4' }}
              />
              <Marker
                position={[newSite.latitude, newSite.longitude]}
                icon={DIRTY_ICON}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const { lat, lng } = (e.target as L.Marker).getLatLng();
                    moveNewSite(lat, lng);
                  },
                }}
              />
            </Fragment>
          )}

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
