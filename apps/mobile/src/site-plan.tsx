/**
 * Site plan.
 *
 * A drawing, not a map. There are no tiles and no network call: everything on
 * it comes from the site coordinates the app already holds and, when there is
 * one, a single position fix. That is the whole point — a worker who needs to
 * know which side of the fence they are on is, by definition, standing on a
 * site, and a site is where reception is worst. A map that needs the network
 * is a map that is blank exactly when it is needed.
 *
 * It is also bound by the same privacy rule as the rest of the app (see the
 * header of location.ts): a fix is taken at the moment of a clock event, or
 * when the worker explicitly asks, and at no other time. So the fence is drawn
 * always — it is static data — and the worker's own mark appears only after a
 * fix they triggered. This never watches.
 *
 * Conventions are the drawing's, not a map's: north up, a dashed boundary, a
 * centre mark, a leader to the offset position, a radius dimension and a scale
 * bar. When the position is too far out to draw to scale, the mark is clamped
 * to the edge and the plan says so rather than lying about the geometry.
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { bearingDegrees, distanceMetres, type LatLng } from '@skelclock/core';

import { colors, fonts, r as rosette, type as t } from './theme';

/** Plan geometry, in viewBox units. */
const W = 320;
const H = 240;
const CX = W / 2;
const CY = 118;
/** The fence always draws at this radius; the scale is derived from it. */
const FENCE_PX = 84;
/** Beyond this the position is clamped to the edge and flagged not-to-scale. */
const MAX_PX = 108;

export interface SitePlanProps {
  siteName: string | null;
  site: LatLng | null;
  radiusM: number;
  fix: (LatLng & { accuracyM: number | null }) | null;
  /** When the fix was taken. A position is only as good as its timestamp. */
  fixAt: string | null;
}

function SitePlanView({ siteName, site, radiusM, fix, fixAt }: SitePlanProps) {
  // Nothing to draw a fence around. Said plainly rather than drawn as an empty
  // circle, which would imply a fence that does not exist.
  if (!site) {
    return (
      <View style={styles.empty}>
        <Text style={styles.lbl}>Site plan</Text>
        <Text style={styles.note}>
          No coordinates loaded for this site yet, so there is no fence to draw. The
          office sets one on the Sites screen.
        </Text>
      </View>
    );
  }

  const metresPerUnit = radiusM / FENCE_PX;

  const distanceM = fix ? distanceMetres(site, fix) : null;
  const bearing = fix ? bearingDegrees(site, fix) : null;
  const inside = distanceM === null ? null : distanceM <= radiusM;

  const trueOffset = distanceM === null ? 0 : distanceM / metresPerUnit;
  const clamped = trueOffset > MAX_PX;
  const offset = Math.min(trueOffset, MAX_PX);

  // Screen y grows downward; a bearing grows clockwise from north. Negating the
  // cosine is what turns one into the other.
  const rad = ((bearing ?? 0) - 90) * (Math.PI / 180);
  const px = CX + offset * Math.cos(rad);
  const py = CY + offset * Math.sin(rad);

  const ink = inside === null ? colors.inkFaint : inside ? colors.green : colors.magenta;
  const fill = inside ? colors.fillGreen : colors.fillMagenta;

  // The accuracy halo is only honest at true scale; once the mark is clamped it
  // would be drawn at a radius that means nothing.
  const accuracyPx =
    !clamped && fix?.accuracyM != null ? fix.accuracyM / metresPerUnit : null;

  const scaleBarM = niceScaleLength(radiusM);
  const scaleBarPx = scaleBarM / metresPerUnit;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.lbl}>Site plan</Text>
        <Text style={[styles.lbl, { color: ink }]}>
          {inside === null ? 'Position not taken' : inside ? 'Inside the fence' : 'Outside the fence'}
        </Text>
      </View>

      <Svg viewBox={`0 0 ${W} ${H}`} style={styles.svg}>
        {/* The fence: a boundary, so it is dashed, as on any drawing. */}
        <Circle cx={CX} cy={CY} r={FENCE_PX} fill={inside === null ? 'none' : fill} />
        <Circle
          cx={CX}
          cy={CY}
          r={FENCE_PX}
          fill="none"
          stroke={ink}
          strokeWidth={1.5}
          strokeDasharray="6 4"
        />

        {/* Centre mark: the survey cross the fence is struck from. */}
        <G>
          <Line x1={CX - 9} y1={CY} x2={CX + 9} y2={CY} stroke={colors.ink} strokeWidth={1} />
          <Line x1={CX} y1={CY - 9} x2={CX} y2={CY + 9} stroke={colors.ink} strokeWidth={1} />
          <Circle cx={CX} cy={CY} r={3} fill="none" stroke={colors.ink} strokeWidth={1} />
        </G>

        {/* Radius dimension, struck to the north-east so it clears the leader. */}
        <Line
          x1={CX}
          y1={CY}
          x2={CX + FENCE_PX * 0.707}
          y2={CY - FENCE_PX * 0.707}
          stroke={colors.line}
          strokeWidth={1}
        />
        <SvgText
          x={CX + FENCE_PX * 0.42}
          y={CY - FENCE_PX * 0.42 - 5}
          fill={colors.inkFaint}
          fontFamily={fonts.mono}
          fontSize={11}
        >
          {`R ${Math.round(radiusM)}`}
        </SvgText>

        {fix && distanceM !== null && (
          <G>
            {accuracyPx !== null && accuracyPx > 2 && (
              <Circle cx={px} cy={py} r={accuracyPx} fill={fill} stroke={ink} strokeWidth={0.5} />
            )}

            {/* Leader from the centre mark to the position. */}
            <Line x1={CX} y1={CY} x2={px} y2={py} stroke={ink} strokeWidth={1} />

            {/* The break symbol: this leader is not to scale, and says so. */}
            {clamped && (
              <Path
                d={breakMark(CX, CY, px, py)}
                fill="none"
                stroke={colors.paper}
                strokeWidth={5}
              />
            )}
            {clamped && (
              <Path d={breakMark(CX, CY, px, py)} fill="none" stroke={ink} strokeWidth={1} />
            )}

            {/* You. A square, the same mark the sync strip uses. */}
            <Rect x={px - 5} y={py - 5} width={10} height={10} fill={ink} />
          </G>
        )}

        {/* North arrow. A plan is useless without one. */}
        <G>
          <Path d={`M ${W - 26} 34 L ${W - 21} 46 L ${W - 26} 43 L ${W - 31} 46 Z`} fill={colors.ink} />
          <SvgText
            x={W - 26}
            y={28}
            fill={colors.ink}
            fontFamily={fonts.mono}
            fontSize={11}
            textAnchor="middle"
          >
            N
          </SvgText>
        </G>

        {/* Scale bar. */}
        <G>
          <Line
            x1={20}
            y1={H - 22}
            x2={20 + scaleBarPx}
            y2={H - 22}
            stroke={colors.ink}
            strokeWidth={1.5}
          />
          <Line x1={20} y1={H - 26} x2={20} y2={H - 18} stroke={colors.ink} strokeWidth={1.5} />
          <Line
            x1={20 + scaleBarPx}
            y1={H - 26}
            x2={20 + scaleBarPx}
            y2={H - 18}
            stroke={colors.ink}
            strokeWidth={1.5}
          />
          <SvgText x={20} y={H - 8} fill={colors.inkFaint} fontFamily={fonts.mono} fontSize={11}>
            {`0 — ${scaleBarM} m`}
          </SvgText>
        </G>

        {clamped && (
          <SvgText
            x={W - 20}
            y={H - 8}
            fill={colors.inkFaint}
            fontFamily={fonts.mono}
            fontSize={11}
            textAnchor="end"
          >
            NOT TO SCALE
          </SvgText>
        )}
      </Svg>

      <View style={styles.foot}>
        <Text style={styles.dat}>{siteName ?? 'Site'}</Text>
        <Text style={[styles.dat, { color: ink }]}>
          {distanceM === null ? '—' : `${formatDistance(distanceM)} from centre`}
        </Text>
      </View>

      <Text style={styles.note}>
        {fix
          ? `Position taken ${fixAt ? formatTime(fixAt) : 'just now'}${
              fix.accuracyM != null ? `, accurate to about ${Math.round(fix.accuracyM)}m` : ''
            }.`
          : 'Your position is only taken when you clock on or off, or when you ask for it.'}
      </Text>
    </View>
  );
}

export const SitePlan = memo(SitePlanView);

/**
 * A zig-zag across the leader, the drawing convention for "this length is not
 * what it appears". Drawn twice by the caller: once thick in the paper colour
 * to knock the leader out beneath it, once thin in ink.
 */
function breakMark(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  // Along the leader, and across it.
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  const bx = -Math.sin(angle);
  const by = Math.cos(angle);

  const p = (alongUnits: number, acrossUnits: number): string =>
    `${mx + ax * alongUnits + bx * acrossUnits} ${my + ay * alongUnits + by * acrossUnits}`;

  return `M ${p(-9, 0)} L ${p(-3, -5)} L ${p(3, 5)} L ${p(9, 0)}`;
}

/** A round number for the scale bar: 1, 2 or 5 of whatever magnitude fits. */
function niceScaleLength(radiusM: number): number {
  const target = radiusM / 2;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(target, 1)));
  for (const step of [1, 2, 5, 10]) {
    if (magnitude * step >= target) return magnitude * step;
  }
  return magnitude * 10;
}

function formatDistance(metres: number): string {
  if (metres >= 10_000) return `${Math.round(metres / 1000)}km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)}km`;
  return `${Math.round(metres)}m`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  wrap: { gap: rosette.r8, paddingTop: rosette.r4 },
  empty: { gap: rosette.r8, paddingVertical: rosette.r4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  svg: { width: '100%', aspectRatio: W / H, backgroundColor: colors.paper200 },
  foot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: rosette.r8,
  },
  lbl: { ...t.lbl, color: colors.inkFaint },
  dat: { ...t.dat, color: colors.ink },
  note: { ...t.dat, color: colors.inkFaint },
});
