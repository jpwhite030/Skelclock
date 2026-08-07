/**
 * Distance and geofence evaluation.
 *
 * The brief is explicit that a worker must never be blocked by this: phone GPS
 * on a scaffold deck, between steel and a brick wall, is routinely 50-100m out
 * and occasionally far worse. So we measure, we record, and we raise an
 * exception — we do not refuse the clock-in.
 */

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface GeofenceInput {
  /** Where the worker's phone says it is. */
  position: LatLng | null;
  /** Reported horizontal accuracy in metres, if the device gave one. */
  accuracyM?: number | null;
  /** The site centre. Null when the job has no coordinates yet. */
  site: LatLng | null;
  /** Site radius in metres. */
  radiusM: number;
}

export interface GeofenceResult {
  /** Metres from the site centre, or null if either point is unknown. */
  distanceM: number | null;
  /**
   * Strict answer: is the reported point inside the circle? Null when we
   * cannot tell, which is different from false and must stay different — a job
   * with no coordinates should not generate an "outside geofence" exception
   * for every worker on it.
   */
  insideGeofence: boolean | null;
  /**
   * True when the reported point is outside, but its own error bars reach the
   * fence. These are the ones not worth chasing the worker about.
   */
  withinAccuracyMargin: boolean;
  /** Populated when we could not evaluate, for display and for the audit trail. */
  reason?: 'no_device_position' | 'no_site_position';
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation: the error
 * of the flat approximation is small at scaffold-site scale, but this runs on
 * a phone a handful of times a day, so there is nothing to buy by trading away
 * correctness. Uses atan2 so it stays stable at short distances.
 */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function evaluateGeofence(input: GeofenceInput): GeofenceResult {
  const { position, site, radiusM } = input;
  const accuracyM = input.accuracyM ?? 0;

  if (!position || !isFinite(position.latitude) || !isFinite(position.longitude)) {
    return {
      distanceM: null,
      insideGeofence: null,
      withinAccuracyMargin: false,
      reason: 'no_device_position',
    };
  }
  if (!site || !isFinite(site.latitude) || !isFinite(site.longitude)) {
    return {
      distanceM: null,
      insideGeofence: null,
      withinAccuracyMargin: false,
      reason: 'no_site_position',
    };
  }

  const distanceM = distanceMetres(position, site);
  const insideGeofence = distanceM <= radiusM;

  return {
    distanceM,
    insideGeofence,
    // Only meaningful when they are outside; inside needs no excuse.
    withinAccuracyMargin: !insideGeofence && distanceM - Math.max(accuracyM, 0) <= radiusM,
  };
}

/**
 * Whether an out-of-fence clock should trouble a supervisor.
 *
 * Suppresses the two cases that would otherwise flood the exceptions list on
 * day one: a job with no coordinates loaded from Odoo yet, and a worker whose
 * GPS error bars overlap the fence.
 */
export function shouldRaiseGeofenceException(result: GeofenceResult): boolean {
  if (result.insideGeofence === null) return false;
  if (result.insideGeofence) return false;
  return !result.withinAccuracyMargin;
}

/** A GPS fix reported with no error bars at all is not trustworthy enough to
 * skip a human — treat "unknown" the same as "too loose". */
const AUTO_CONFIRM_MAX_ACCURACY_M = 30;

export interface AutoConfirmInput {
  insideGeofence: boolean | null;
  accuracyM: number | null;
  /** How many of the worker's assigned sites the fix fell inside. */
  candidateSiteCount: number;
}

/**
 * Whether a geofence-raised event is trustworthy enough to become a live
 * clock immediately, skipping the tap-to-confirm step.
 *
 * Deliberately conservative, same spirit as shouldRaiseGeofenceException: tap
 * stays the fallback for anything this isn't sure about. Three ways to fail
 * the automatic path — a loose fix, landing outside the fence, or landing
 * inside more than one assigned site's fence at once (evaluateGeofence only
 * ever checks one site, so the caller resolves ambiguity before calling this;
 * candidateSiteCount > 1 means it could not).
 */
export function shouldAutoConfirmGeofence(input: AutoConfirmInput): boolean {
  if (input.candidateSiteCount > 1) return false;
  if (input.insideGeofence !== true) return false;
  if (input.accuracyM == null || input.accuracyM > AUTO_CONFIRM_MAX_ACCURACY_M) return false;
  return true;
}
