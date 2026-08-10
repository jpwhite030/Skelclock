/**
 * Distance and geofence evaluation.
 *
 * The brief said a worker must never be blocked by this. That has since been
 * reversed: blocksClockIn() below refuses an off-site clock-on outright.
 *
 * The reasoning that produced the original rule has not gone away, though, and
 * it is what shapes every function here. Phone GPS on a scaffold deck, between
 * steel and a brick wall, is routinely 50-100m out and occasionally far worse.
 * So a position we are unsure of is never treated as a position outside: the
 * three predicates that act on a fence — raise an exception, refuse a clock-on,
 * auto-confirm a suggestion — all decline to act on an unknown, and each says
 * in its own comment which way it fails and why.
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

/**
 * Initial bearing from `a` to `b`, in degrees clockwise from true north.
 *
 * Pairs with distanceMetres to place one point relative to another on a plan:
 * distance gives the radius, this gives the angle. Forward azimuth rather than
 * the flat arctangent so it stays right at any latitude, which matters because
 * longitude degrees shrink towards the poles and Wollongong is far enough
 * south that treating lat/lng as a square grid visibly skews the direction.
 *
 * Returns 0 when the two points coincide — a bearing to yourself has no
 * meaning, and 0 is what a plan draws when there is nothing to point at.
 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (y === 0 && x === 0) return 0;

  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
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

/**
 * Whether a clock-on should be refused outright for being off-site.
 *
 * This is the one rule in the system that can stop someone starting work, so
 * what it does *not* block is the important half:
 *
 *   No position at all       insideGeofence is null. A worker in a basement,
 *                            a shed, or with a flat GPS is not "outside" a
 *                            fence — their position is unknown, and unknown
 *                            must not cost them a shift.
 *   Site has no coordinates  Also null. The fence does not exist yet; there
 *                            is nothing to be outside of.
 *   Error bars reach the     Phone GPS on a scaffold deck is routinely 50-100m
 *   fence                    out. If the accuracy margin overlaps the boundary
 *                            we do not know which side they are on, and a
 *                            guess in that state is a guess about someone's
 *                            pay.
 *
 * So it refuses only a position we are confident is beyond the fence. That is
 * deliberately the same test as shouldRaiseGeofenceException, but it is a
 * separate function because they answer different questions — one troubles a
 * supervisor, the other stops work — and the day they need to diverge, they
 * should diverge without one silently changing the other.
 */
export function blocksClockIn(result: GeofenceResult): boolean {
  if (result.insideGeofence === null) return false;
  if (result.insideGeofence) return false;
  return !result.withinAccuracyMargin;
}

/** A GPS fix reported with no error bars at all is not trustworthy enough to
 * skip a human — treat "unknown" the same as "too loose". */
const AUTO_CONFIRM_MAX_ACCURACY_M = 30;

/**
 * Whether a worker has been inside the fence long enough to be believed.
 *
 * Crossing a fence and turning up for work are not the same event, and until
 * this rule existed they were indistinguishable. Driving past a site on the
 * highway, parking beside one to buy a coffee, or living two streets away and
 * walking the dog all cross a boundary exactly the way arriving for a shift
 * does. A minimum dwell is the only thing that separates them, and it is
 * cheap: nobody who is actually starting work leaves within five minutes.
 *
 * Unknown arrival time fails, deliberately. This gates the *automatic* path,
 * and the doctrine everywhere else in this file is that anything we are not
 * sure about falls back to a human tap rather than guessing at someone's pay.
 * A clock event carrying no arrival time is one we cannot judge, so we do not.
 *
 * Zero minutes disables the rule outright rather than being a special case
 * every caller has to remember — a company that does not want it sets 0.
 */
export function meetsMinimumDwell(args: {
  /** When the phone first saw itself inside this fence, in epoch ms. */
  insideSinceMs: number | null;
  nowMs: number;
  minimumMinutes: number;
}): boolean {
  if (args.minimumMinutes <= 0) return true;
  if (args.insideSinceMs == null) return false;

  // A negative elapsed time means the device clock moved, or the arrival was
  // stamped by a phone that disagrees with this one. Either way it is not
  // evidence of having stayed anywhere, so it counts as no time at all.
  const elapsedMs = args.nowMs - args.insideSinceMs;
  if (elapsedMs < 0) return false;

  return elapsedMs >= args.minimumMinutes * 60_000;
}

export interface AutoConfirmInput {
  insideGeofence: boolean | null;
  accuracyM: number | null;
  /** How many of the worker's assigned sites the fix fell inside. */
  candidateSiteCount: number;
  /** When the phone first saw itself inside this fence, epoch ms. Null when
   * the event did not carry one — an older client, or a manual clock. */
  insideSinceMs?: number | null;
  /** Company policy, in minutes. Omitted or 0 means the rule is off. */
  minimumDwellMinutes?: number;
  /** Evaluated against this instant, so the caller controls "now". */
  nowMs?: number;
}

/**
 * Whether a geofence-raised event is trustworthy enough to become a live
 * clock immediately, skipping the tap-to-confirm step.
 *
 * Deliberately conservative, same spirit as shouldRaiseGeofenceException: tap
 * stays the fallback for anything this isn't sure about. Four ways to fail
 * the automatic path — a loose fix, landing outside the fence, landing inside
 * more than one assigned site's fence at once (evaluateGeofence only ever
 * checks one site, so the caller resolves ambiguity before calling this;
 * candidateSiteCount > 1 means it could not), or not having stayed.
 *
 * Failing here does not refuse the clock. It sends it back to tap-to-confirm,
 * which is the whole design: the worker who really did just arrive taps once,
 * and the driver-by never gets a live clock they did not ask for.
 */
export function shouldAutoConfirmGeofence(input: AutoConfirmInput): boolean {
  if (input.candidateSiteCount > 1) return false;
  if (input.insideGeofence !== true) return false;
  if (input.accuracyM == null || input.accuracyM > AUTO_CONFIRM_MAX_ACCURACY_M) return false;

  const minimumMinutes = input.minimumDwellMinutes ?? 0;
  if (
    !meetsMinimumDwell({
      insideSinceMs: input.insideSinceMs ?? null,
      nowMs: input.nowMs ?? Date.now(),
      minimumMinutes,
    })
  ) {
    return false;
  }

  return true;
}
