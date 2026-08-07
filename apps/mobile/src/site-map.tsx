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
import { StyleSheet, Text, View } from 'react-native';
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

  const distanceM = fix ? distanceMetres(site, fix) : null;
  const inside = distanceM === null ? null : distanceM <= radiusM;
  const ink = inside === null ? colors.steel : inside ? colors.green : colors.magenta;

  // Keep the whole fence and the worker on screen as they move. Framing just
  // the two points zooms in until the boundary is off-screen, which loses the
  // one thing the map is for — you cannot see which side of a line you are on
  // if the line is not in shot.
  useEffect(() => {
    if (!fix || !mapRef.current) return;

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
  }, [fix?.latitude, fix?.longitude, site.latitude, site.longitude, radiusM]);

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
        The map takes no touches at all.

        It is a picture, not something to explore: it keeps itself framed on the
        fence and the worker, so there is nothing panning would buy. Refusing
        touches outright means it can never compete with the page for a drag —
        a map that eats the scroll gesture on the one screen a worker uses would
        put the controls below it out of reach.
      */}
      <View style={styles.map} pointerEvents="none">
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
        // Not a map you explore — a live picture of one question: which side of
        // the fence are you on. Panning is off because the view keeps itself
        // framed on the fence and the worker, and because a map inside a scroll
        // view swallows the drag, which traps the page on the one screen that
        // has to scroll. A worker fighting to get past the map to reach Clock
        // Off is a worse outcome than one who cannot pinch to zoom.
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
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

  lbl: { ...t.lbl, color: colors.inkFaint },
  dat: { ...t.dat, color: colors.ink },

  centreMark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  centreH: { position: 'absolute', width: 22, height: 1.5, backgroundColor: colors.ink },
  centreV: { position: 'absolute', width: 1.5, height: 22, backgroundColor: colors.ink },
});
