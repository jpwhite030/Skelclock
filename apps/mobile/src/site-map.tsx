/**
 * Live site map.
 *
 * Apple Maps, in muted standard: the quiet basemap rather than the tourist
 * one, because everything that matters here is drawn on top of it — the fence,
 * the site centre, and the worker. A saturated basemap competes with the one
 * colour that carries meaning.
 *
 * The fence takes the CAD legend, so the map answers the only question a
 * worker asks it: green means inside and you can clock on, magenta means you
 * have crossed a line and you cannot.
 *
 * Tiles need the network. When there is none the clock screen falls back to
 * the drawn plan in site-plan.tsx, which needs nothing — see the caller. This
 * component assumes it is only mounted when there is a connection to load them
 * with, and never becomes the reason a worker cannot see their fence.
 */

import { memo, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, type Region } from 'react-native-maps';

import { distanceMetres, type LatLng } from '@skelclock/core';

import { colors, r as rosette, type as t } from './theme';

export interface SiteMapProps {
  siteName: string | null;
  customerName: string | null;
  siteAddress: string | null;
  site: LatLng;
  radiusM: number;
  fix: (LatLng & { accuracyM: number | null }) | null;
  /** True once the app is following the worker, which shows the live dot. */
  live: boolean;
}

/**
 * A region that frames the fence with a margin, so the boundary is never flush
 * against the edge of the view. 1 degree of latitude is ~111km everywhere,
 * which is close enough for choosing a zoom.
 */
function regionFor(site: LatLng, radiusM: number): Region {
  const span = ((radiusM * 3) / 111_000) * 2;
  return {
    latitude: site.latitude,
    longitude: site.longitude,
    latitudeDelta: span,
    // Longitude degrees shrink with latitude; without this the fence is an
    // ellipse on screen at Wollongong's latitude rather than a circle.
    longitudeDelta: span / Math.cos((site.latitude * Math.PI) / 180),
  };
}

function SiteMapView({
  siteName,
  customerName,
  siteAddress,
  site,
  radiusM,
  fix,
  live,
}: SiteMapProps) {
  const mapRef = useRef<MapView | null>(null);
  /** Set once the worker moves the map themselves; stops all auto-framing. */
  const touched = useRef(false);
  /** Set after the first automatic frame, so it happens once and not per fix. */
  const framed = useRef(false);

  const distanceM = fix ? distanceMetres(site, fix) : null;
  const inside = distanceM === null ? null : distanceM <= radiusM;
  const ink = inside === null ? colors.steel : inside ? colors.green : colors.magenta;

  // Frame the fence and the worker — once.
  //
  // This used to re-run on every position update. The watcher reports every
  // ~10m or 5s, so the camera re-animated constantly: the map crept and
  // twitched under your thumb the whole time you were on the screen, and any
  // zoom you set was yanked away within seconds. That is the map half of
  // "jumpy".
  //
  // So it frames on the first fix and then leaves the camera alone. The blue
  // dot still moves — it is the map that stops chasing it. Once the worker has
  // touched the map at all, it never re-frames: they are looking at something,
  // and moving the view out from under someone reading it is the rudest thing
  // a map can do.
  useEffect(() => {
    if (!fix || !mapRef.current) return;
    if (touched.current || framed.current) return;
    framed.current = true;

    // Far enough away and framing both is useless — a worker 12,000km from the
    // site gets an ocean, with the fence too small to see and their own dot on
    // the other edge. Past this, stay framed on the site: the plate already
    // states the distance in words, which is the only useful thing left to say.
    if (distanceM !== null && distanceM > radiusM * 12) {
      mapRef.current.animateToRegion(regionFor(site, radiusM), 300);
      return;
    }

    const dLat = radiusM / 111_320;
    const dLng = dLat / Math.cos((site.latitude * Math.PI) / 180);

    mapRef.current.fitToCoordinates(
      [
        { latitude: site.latitude + dLat, longitude: site.longitude },
        { latitude: site.latitude - dLat, longitude: site.longitude },
        { latitude: site.latitude, longitude: site.longitude + dLng },
        { latitude: site.latitude, longitude: site.longitude - dLng },
        { latitude: fix.latitude, longitude: fix.longitude },
      ],
      {
        edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
        animated: true,
      },
    );
  }, [fix?.latitude, fix?.longitude, site.latitude, site.longitude, radiusM, distanceM]);

  const status =
    inside === null
      ? live
        ? 'Finding you'
        : 'Position not taken'
      : inside
        ? 'Inside the fence'
        : 'Outside the fence';

  return (
    <View style={styles.wrap}>
      {/*
        The map takes touches now, which means it also takes drags that started
        as an attempt to scroll the page. That is the cost of being able to zoom
        in on a fence, and it is worth paying — but it is why the map is kept to
        8 rosettes rather than filling the screen: there has to be sheet either
        side of it to scroll by.
      */}
      <View style={styles.map}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={regionFor(site, radiusM)}
        mapType="mutedStandard"
        // mutedStandard follows the system appearance, so a phone in dark mode
        // renders a dark basemap under a paper-coloured app. SETOUT is one
        // look; the map is pinned to it rather than left to the OS.
        userInterfaceStyle="light"
        showsUserLocation={live}
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale
        toolbarEnabled={false}
        // Zoom and pan are on: you cannot judge whether a fence sits over the
        // right building without getting closer to it, and "is that pin on the
        // gate or the neighbour's driveway" is the question this map exists to
        // answer. Rotate and pitch stay off — a tilted, spun site plan is
        // harder to read, not easier, and neither helps that question.
        scrollEnabled
        zoomEnabled
        rotateEnabled={false}
        pitchEnabled={false}
        onPanDrag={() => {
          touched.current = true;
        }}
        onRegionChangeComplete={(_r, details) => {
          // isGesture is how we tell the worker moving the map from our own
          // animateToRegion doing it. Only the former should stop the auto-fit.
          if (details?.isGesture) touched.current = true;
        }}
        loadingEnabled
        loadingBackgroundColor={colors.paper200}
        loadingIndicatorColor={colors.ink}
      >
        <Circle
          center={site}
          radius={radiusM}
          strokeColor={ink}
          strokeWidth={2}
          fillColor={inside === false ? colors.fillMagenta : colors.fillGreen}
        />
        <Marker
          coordinate={site}
          title={siteName ?? 'Site'}
          description={`Fence radius ${Math.round(radiusM)}m`}
        >
          {/* The survey cross off the drawing, so the centre mark means the
              same thing here as it does on the plan. */}
          <View style={styles.centreMark}>
            <View style={styles.centreH} />
            <View style={styles.centreV} />
          </View>
        </Marker>
      </MapView>
      </View>

      {/*
        A way back. Now the map no longer chases the worker it will sit happily
        wherever they left it, three suburbs away, and "how do I get back to the
        site" should not itself be an act of navigation.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Re-centre the map on the site"
        onPress={() => {
          touched.current = false;
          framed.current = false;
          mapRef.current?.animateToRegion(regionFor(site, radiusM), 350);
        }}
        style={({ pressed }) => [styles.recentre, pressed && styles.recentrePressed]}
      >
        <Text style={styles.recentreText}>Re-centre</Text>
      </Pressable>

      {/*
        The title block, laid over the drawing rather than beside it — which is
        where a drawing puts it. Solid paper rather than a blur: a scrim that
        lets the map through is a scrim you cannot guarantee an address stays
        readable on, and the address is the thing a worker is checking.
      */}
      <View style={styles.plate} pointerEvents="none">
        <View style={styles.plateHead}>
          <Text style={styles.lbl}>{customerName ? 'Customer' : 'Site'}</Text>
          <Text style={[styles.lbl, { color: ink }]}>{status}</Text>
        </View>

        {customerName && (
          <Text style={styles.customer} numberOfLines={1}>
            {customerName}
          </Text>
        )}

        <View style={styles.plateFoot}>
          <Text style={styles.address} numberOfLines={2}>
            {siteAddress ?? siteName ?? 'No address on file'}
          </Text>
          <Text style={[styles.dat, { color: ink }]}>
            {distanceM === null ? '—' : formatDistance(distanceM)}
          </Text>
        </View>
      </View>
    </View>
  );
}

export const SiteMap = memo(SiteMapView);

function formatDistance(metres: number): string {
  if (metres >= 10_000) return `${Math.round(metres / 1000)}km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)}km`;
  return `${Math.round(metres)}m`;
}

const styles = StyleSheet.create({
  // Full-bleed and 8 rosettes tall: the map leads the sheet, so it runs to
  // both edges the way a plotted drawing does rather than sitting in a margin.
  wrap: { position: 'relative' },
  map: { width: '100%', height: rosette.r1 * 8, backgroundColor: colors.paper200 },

  plate: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.paper,
    borderTopWidth: 1,
    borderTopColor: colors.ink,
    paddingHorizontal: rosette.r2,
    paddingVertical: rosette.r4,
    gap: rosette.r8,
  },
  plateHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  plateFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: rosette.r4,
  },
  customer: { ...t.dat, fontSize: 15, color: colors.ink },
  address: { ...t.dat, color: colors.ink700, flexShrink: 1 },

  // Sits on the map, clear of the plate below it.
  recentre: {
    position: 'absolute',
    top: rosette.r4,
    right: rosette.r4,
    minHeight: 34,
    paddingHorizontal: rosette.r4,
    justifyContent: 'center',
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.ink,
  },
  recentrePressed: { backgroundColor: colors.paper200 },
  recentreText: { ...t.lbl, color: colors.ink },

  lbl: { ...t.lbl, color: colors.inkFaint },
  dat: { ...t.dat, color: colors.ink },

  centreMark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  centreH: { position: 'absolute', width: 22, height: 1.5, backgroundColor: colors.ink },
  centreV: { position: 'absolute', width: 1.5, height: 22, backgroundColor: colors.ink },
});
