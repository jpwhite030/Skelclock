/**
 * Address lookup for site setup.
 *
 * WHY THIS IS NOT JUST A NOMINATIM CALL.
 *
 * A geofence is only as good as the pin at its centre, and OpenStreetMap has
 * almost no Australian house numbers. Searching three real Wollongong
 * addresses returns a road match for every one:
 *
 *   14 Kembla Street Wollongong  -> road centroid
 *   12 Robsons Road Keiraville   -> road centroid
 *   5 Gipps Street Wollongong    -> road centroid
 *
 * and worse, the three "Kembla Street" hits are in Port Kembla, Balgownie and
 * Wollongong — kilometres apart, ranked by OSM's own relevance rather than by
 * whether they are the street you asked for. A 70m fence dropped on one of
 * those is not on the site, and the crew that turns up gets refused.
 *
 * So the primary source is GURAS, the NSW Geocoded Urban and Rural Address
 * System — the state's authoritative address register, the thing G-NAF is
 * built from. It is published as a public ArcGIS service by Spatial Services
 * (Department of Customer Service), needs no API key, and holds every property
 * in NSW at its own coordinate, unit numbers included:
 *
 *   63 KEMBLA STREET WOLLONGONG    -34.424539, 150.897942
 *   1/63 KEMBLA STREET WOLLONGONG  -34.424539, 150.897942
 *
 * Nominatim stays as the fallback. GURAS is NSW-only and knows properties, not
 * places: it will not find "Crown Central Shopping Centre" or anything over the
 * Victorian border. SkelScaff works the Illawarra, so NSW-first is right for
 * every site they will actually set up, and OSM catches the rest.
 *
 * Neither service is paid for, so neither gets to be a hard dependency: every
 * failure path here returns an empty list rather than throwing, and the office
 * can still drop a pin by hand.
 */

/** Where a candidate came from. Surfaced to the office — an authoritative
 * property point and a best-guess place match deserve different trust. */
export type GeocodeSource = 'nsw' | 'osm';

/**
 * How exact a pin is.
 *
 *   address   a property point — the pin is the site
 *   street    the road only, so the pin is somewhere along it, which can be
 *             hundreds of metres out
 *   area      a suburb or locality centroid; a starting view, nothing more
 */
export type GeocodePrecision = 'address' | 'street' | 'area';

/** The parts of an address, kept apart rather than as one string, so a site
 * record can be searched and grouped by suburb later without re-parsing. */
export interface AddressParts {
  houseNumber: string | null;
  street: string | null;
  suburb: string | null;
  state: string | null;
  /** GURAS does not carry postcode; only OSM results will have one. */
  postcode: string | null;
}

export interface GeocodeCandidate {
  label: string;
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
  source: GeocodeSource;
  parts: AddressParts;
  /** GURAS address id — a stable handle on this exact property, for `nsw`
   * results only. Worth storing: street names and suburbs get renamed, this
   * does not. */
  gurasId: number | null;
  /**
   * True when the search had to drop words to find anything — so this is a
   * near miss, not the address that was typed.
   *
   * Without it the office cannot tell "63 Kembla Street Wollongong" (found
   * exactly) from "14 Kembla Street Balgownie" (offered because Wollongong has
   * no number 14), and both look equally like an answer.
   */
  loosened: boolean;
}

// --- query normalisation -----------------------------------------------------

/**
 * Street type abbreviations, expanded to how GURAS spells them.
 *
 * GURAS stores one canonical form — "KEMBLA STREET", never "KEMBLA ST" — and
 * the match below is a literal prefix, so "14 kembla st" finds nothing at all
 * unless it is expanded first. People type the short form; this is not
 * optional politeness, it is the difference between the search working and
 * silently returning nothing.
 */
const STREET_TYPES: Record<string, string> = {
  ST: 'STREET',
  STR: 'STREET',
  RD: 'ROAD',
  AV: 'AVENUE',
  AVE: 'AVENUE',
  DR: 'DRIVE',
  DRV: 'DRIVE',
  CT: 'COURT',
  CRT: 'COURT',
  PL: 'PLACE',
  CR: 'CRESCENT',
  CRES: 'CRESCENT',
  LN: 'LANE',
  PDE: 'PARADE',
  HWY: 'HIGHWAY',
  CL: 'CLOSE',
  TCE: 'TERRACE',
  TER: 'TERRACE',
  WY: 'WAY',
  CCT: 'CIRCUIT',
  CIR: 'CIRCUIT',
  ESP: 'ESPLANADE',
  GR: 'GROVE',
  GRV: 'GROVE',
  BVD: 'BOULEVARD',
  BLVD: 'BOULEVARD',
  SQ: 'SQUARE',
  TRK: 'TRACK',
  ENT: 'ENTRANCE',
};

/** States, stripped before matching — GURAS address strings end at the suburb. */
const STATES = new Set(['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT']);

/**
 * A typed query, reshaped into the form GURAS stores.
 *
 * Uppercases, drops punctuation, expands street types, and removes the state
 * and postcode that people habitually add and GURAS does not hold.
 *
 * It also whitelists the surviving characters to `A-Z 0-9 space / -`. That is
 * not tidiness: the result is interpolated into an ArcGIS `where` clause, and
 * a quote in the query would otherwise be a SQL injection into someone else's
 * database. Restricting the alphabet is the guarantee; do not relax it without
 * replacing it with a parameterised query, which this API does not offer.
 */
export function normaliseQuery(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9/\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const words = cleaned.split(' ');
  const kept: string[] = [];

  for (const word of words) {
    // A 4-digit run at this point is a postcode; a house number never reaches
    // four digits without a street name already banked before it.
    if (/^\d{4}$/.test(word) && kept.length > 0) continue;
    if (STATES.has(word)) continue;
    kept.push(STREET_TYPES[word] ?? word);
  }

  return kept.join(' ');
}

/**
 * Progressively looser forms of a query, most specific first.
 *
 * GURAS matching is a literal prefix, so "14 KEMBLA STREET WOLLONGONG NORTH"
 * fails outright if the suburb is written differently, even though the number
 * and street are exactly right. Dropping trailing words one at a time turns a
 * near-miss into a short list the office can pick from, rather than nothing.
 *
 * Stops at three words — below that ("14 KEMBLA") the prefix is so loose it
 * returns a different suburb's street, which is the failure this whole module
 * exists to avoid.
 */
export function queryLadder(normalised: string): string[] {
  const words = normalised.split(' ').filter(Boolean);
  const out: string[] = [];
  for (let n = words.length; n >= 3; n--) out.push(words.slice(0, n).join(' '));
  return out.length > 0 ? out : normalised ? [normalised] : [];
}

/**
 * Split a GURAS address string back into parts.
 *
 * The format is `<number> <STREET NAME> <STREET TYPE> <SUBURB>`, with no
 * separators — "1/63 KEMBLA STREET WOLLONGONG". The street type is the pivot:
 * everything before it (after the number) is the street name, everything after
 * it is the suburb. Without a recognised type there is nothing reliable to
 * split on, so the street is left whole rather than guessed at.
 */
export function partsFromGuras(address: string, houseNumber: string | null): AddressParts {
  const words = address.split(' ').filter(Boolean);
  const start = houseNumber && words[0] === houseNumber ? 1 : 0;

  const types = new Set(Object.values(STREET_TYPES));
  // Last match, not first: "PARK STREET" would otherwise split on "PARK" if
  // that were ever a type, and suburbs like "FIGTREE HEIGHTS" can repeat one.
  let pivot = -1;
  for (let i = words.length - 1; i >= start; i--) {
    if (types.has(words[i]!)) {
      pivot = i;
      break;
    }
  }

  if (pivot === -1) {
    return {
      houseNumber,
      street: words.slice(start).join(' ') || null,
      suburb: null,
      state: 'NSW',
      postcode: null,
    };
  }

  return {
    houseNumber,
    street: words.slice(start, pivot + 1).join(' ') || null,
    suburb: words.slice(pivot + 1).join(' ') || null,
    state: 'NSW',
    postcode: null,
  };
}

/**
 * Rank GURAS hits against what was typed.
 *
 * The suburb has to come first, and this is not a nicety. Searching "14 Kembla
 * St Wollongong" finds nothing — there is no number 14 on that street — so the
 * ladder drops the suburb and matches every Kembla Street in the state. The
 * first three back are Dharruk, Arncliffe and Balgownie: two of them are in
 * Sydney, 90km away, and one is a suburb up the road. Ranked by string length
 * they arrive in essentially random order, and the office picks the top one.
 *
 * So candidates are scored by how many of the typed words they are missing.
 * Anything in the suburb that was asked for beats anything that is not, and
 * what is left is a genuine near-miss list rather than a lottery.
 *
 * Then whole properties before their units — someone who typed "63 Kembla
 * Street" wants number 63, not "1/63", and both come back at the same
 * coordinate — and finally distance from where the office is looking. That
 * last one matters once the suburb has already failed to match: Arncliffe and
 * Balgownie both have a 14 Kembla Street and tie on every other measure, but
 * one is 55km up the freeway and the other is 7km from the yard.
 */
function rankAgainst(
  query: string,
  near?: { latitude: number; longitude: number },
): (a: GeocodeCandidate, b: GeocodeCandidate) => number {
  const wanted = query.split(' ').filter(Boolean);
  const missing = (c: GeocodeCandidate) => {
    const words = new Set(c.label.toUpperCase().split(' '));
    return wanted.reduce((n, w) => n + (words.has(w) ? 0 : 1), 0);
  };
  const unit = (c: GeocodeCandidate) => (c.parts.houseNumber?.includes('/') ? 1 : 0);

  const away = (c: GeocodeCandidate) =>
    near ? roughMetres(near.latitude, near.longitude, c.latitude, c.longitude) : 0;

  const scored = new Map<GeocodeCandidate, number>();
  const score = (c: GeocodeCandidate) => {
    let s = scored.get(c);
    if (s === undefined) {
      s = missing(c);
      scored.set(c, s);
    }
    return s;
  };

  return (a, b) =>
    score(a) - score(b) || unit(a) - unit(b) || away(a) - away(b) || a.label.length - b.label.length;
}

// --- NSW GURAS ---------------------------------------------------------------

const GURAS_ADDRESS_POINTS =
  'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/MapServer/1/query';

/** Neither geocoder is paid for and site setup is interactive — a slow lookup
 * should fall through to the next source, not hold the page open. */
const TIMEOUT_MS = 8_000;

const USER_AGENT = 'SkelClock/1.0 (site setup; matt@skelscaff.com.au)';

interface GurasFeature {
  attributes: { address?: string; housenumber?: string | null; gurasid?: number | null };
  geometry?: { x?: number; y?: number };
}

async function gurasQuery(params: Record<string, string>): Promise<GurasFeature[]> {
  const url = new URL(GURAS_ADDRESS_POINTS);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('outFields', 'address,housenumber,gurasid');
  url.searchParams.set('returnGeometry', 'true');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'json');

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { features?: GurasFeature[]; error?: unknown };
    // ArcGIS reports a bad `where` as HTTP 200 with an error body, so a
    // successful status is not enough to trust the payload.
    if (body.error || !Array.isArray(body.features)) return [];
    return body.features;
  } catch {
    return [];
  }
}

function toCandidate(f: GurasFeature): GeocodeCandidate | null {
  const address = f.attributes.address;
  const x = f.geometry?.x;
  const y = f.geometry?.y;
  if (!address || typeof x !== 'number' || typeof y !== 'number') return null;

  const houseNumber = f.attributes.housenumber ?? null;
  return {
    label: address,
    latitude: y,
    longitude: x,
    precision: 'address',
    source: 'nsw',
    parts: partsFromGuras(address, houseNumber),
    gurasId: f.attributes.gurasid ?? null,
    loosened: false,
  };
}

export interface GeocodeOptions {
  limit?: number;
  /**
   * Where the office is looking — the map centre.
   *
   * NSW is a big place and street names repeat across it. "14 Kembla Street"
   * exists in Dharruk, Arncliffe, Balgownie and Port Kembla; the first two are
   * in Sydney, 90km from anywhere SkelScaff works. Ranking cannot fix that,
   * because when the typed suburb has no match none of the candidates contain
   * it and they all tie — the search has to stop asking the whole state.
   *
   * So the lookup is fenced to a radius around this point first, and only
   * falls back to statewide if that finds nothing. A crew is never sent to a
   * street in Sydney because the map happened to sort it first.
   */
  near?: { latitude: number; longitude: number };
}

/** How far from the map centre to look before giving up and asking the whole
 * state. Wide enough to cover the Illawarra and Sydney's south from a
 * Wollongong-centred map, narrow enough to exclude the other end of NSW. */
const NEAR_RADIUS_M = 60_000;

/** Search the NSW address register. Empty when the address is not in NSW, or
 * when the query names a place rather than a property. */
export async function searchNsw(
  query: string,
  options: GeocodeOptions = {},
): Promise<GeocodeCandidate[]> {
  const limit = options.limit ?? 8;
  const normalised = normaliseQuery(query);
  if (normalised.length < 3) return [];

  const near = options.near;
  const spatial: Record<string, string> = near
    ? {
        geometry: `${near.longitude},${near.latitude}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        distance: String(NEAR_RADIUS_M),
        units: 'esriSRUnit_Meter',
        spatialRel: 'esriSpatialRelIntersects',
      }
    : {};

  const run = async (where: string, bounded: boolean) => {
    const features = await gurasQuery({
      where,
      resultRecordCount: String(limit * 4),
      ...(bounded ? spatial : {}),
    });
    return features
      .map(toCandidate)
      .filter((c): c is GeocodeCandidate => c !== null)
      .sort(rankAgainst(normalised, near));
  };

  for (const attempt of queryLadder(normalised)) {
    // Safe to interpolate only because normaliseQuery whitelisted the alphabet.
    const where = `address LIKE '${attempt}%'`;
    /** The rung is shorter than what was typed, so something the office asked
     * for — almost always the suburb — did not match. The UI says so. */
    const loosened = attempt !== normalised;

    if (near) {
      const local = await run(where, true);
      if (local.length > 0) {
        return local.slice(0, limit).map((c) => ({ ...c, loosened }));
      }
    }

    const anywhere = await run(where, false);
    if (anywhere.length > 0) {
      return anywhere.slice(0, limit).map((c) => ({ ...c, loosened }));
    }
  }

  return [];
}

/**
 * The nearest properties to a dropped pin.
 *
 * This is what makes dragging honest. The office moves the pin onto the gate,
 * and the site's recorded address becomes the address that is actually there
 * — rather than whatever was typed into the search box, which is the string
 * everyone downstream then believes.
 *
 * Sorted here rather than trusting the service's order, which is not by
 * distance.
 */
export async function reverseNsw(
  latitude: number,
  longitude: number,
  withinMetres = 80,
): Promise<GeocodeCandidate[]> {
  const features = await gurasQuery({
    geometry: `${longitude},${latitude}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    distance: String(withinMetres),
    units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects',
    resultRecordCount: '25',
  });

  return features
    .map(toCandidate)
    .filter((c): c is GeocodeCandidate => c !== null)
    .map((c) => ({ c, d: roughMetres(latitude, longitude, c.latitude, c.longitude) }))
    .sort((a, b) => a.d - b.d)
    .map(({ c }) => c);
}

/** Equirectangular approximation. Over the tens of metres this is used for it
 * is indistinguishable from haversine, and only the ordering matters. */
function roughMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// --- OpenStreetMap fallback --------------------------------------------------

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    house_number?: string;
    road?: string;
    suburb?: string;
    town?: string;
    city?: string;
    state?: string;
    postcode?: string;
  };
}

/**
 * Server-side on purpose: Nominatim's usage policy requires a descriptive
 * User-Agent identifying the calling application, and a browser cannot set
 * that header on its own fetch.
 */
export async function searchOsm(
  query: string,
  options: GeocodeOptions = {},
): Promise<GeocodeCandidate[]> {
  const limit = options.limit ?? 8;
  const q = query.trim();
  if (q.length < 3) return [];

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'au');

  let results: NominatimResult[];
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    results = (await response.json()) as NominatimResult[];
    if (!Array.isArray(results)) return [];
  } catch {
    return [];
  }

  const rank = { address: 0, street: 1, area: 2 } as const;
  return results
    .map((r): GeocodeCandidate => {
      const a = r.address ?? {};
      return {
        label: r.display_name,
        latitude: Number(r.lat),
        longitude: Number(r.lon),
        precision: a.house_number ? 'address' : a.road ? 'street' : 'area',
        source: 'osm',
        parts: {
          houseNumber: a.house_number ?? null,
          street: a.road ?? null,
          suburb: a.suburb ?? a.town ?? a.city ?? null,
          state: a.state ?? null,
          postcode: a.postcode ?? null,
        },
        gurasId: null,
        loosened: false,
      };
    })
    .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
    .sort((a, b) => rank[a.precision] - rank[b.precision]);
}

// --- the one the app calls ---------------------------------------------------

/**
 * NSW first, OSM only if that found nothing.
 *
 * Not merged: a GURAS hit is a surveyed property point and an OSM hit for the
 * same query is a road centroid, so showing them in one list invites picking
 * the wrong one. If NSW has an answer it is the answer.
 */
export async function geocode(
  query: string,
  options: GeocodeOptions = {},
): Promise<GeocodeCandidate[]> {
  const nsw = await searchNsw(query, options);
  if (nsw.length > 0) return nsw;
  return searchOsm(query, options);
}
