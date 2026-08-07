/**
 * SETOUT, on paper.
 *
 * The same drawing language as the dashboard (apps/web/src/app/globals.css),
 * re-cut for a handset. Values are lifted from there verbatim rather than
 * re-picked, because two halves of one system that merely resemble each other
 * are worse than either done properly.
 *
 * ── Why paper and not the dark ground ──────────────────────────────────────
 * The dashboard puts glanceable screens on dark and the twenty-minute read on
 * paper. A phone breaks that tie on a different axis: this screen is read at
 * arm's length in direct sun on a scaffold deck, and that is the one condition
 * a dark ground fails hardest. SETOUT already specifies the paper inks and the
 * CAD legend re-cut for paper, so this is the existing system's second ground,
 * not a third look.
 *
 * ── The ladder ────────────────────────────────────────────────────────────
 * Every dimension is a real Kwikstage measurement at 1:12.5, as on the
 * dashboard: one rosette (500mm) is 40px. The dashboard broke that once, for
 * the 30px Timesheets row, when the office beat the drawing. The phone breaks
 * it in the other direction and for the same kind of reason: 40px is under the
 * 56px a gloved thumb needs, so every tap target is 1.5 rosettes (60px) and
 * the clock button is 3 (120px). The ladder still governs; the hand sets the
 * floor.
 *
 * ── The legend ────────────────────────────────────────────────────────────
 * SkelScaff's CAD legend, meanings intact — this is the part that has to stay
 * literal, because the colours already mean something to the people using it:
 *
 *   MAGENTA  outer boundary   → something has crossed a line
 *   YELLOW   inner face       → still in hand
 *   GREEN    boards down      → you can stand on it
 *
 * On this app that reads: magenta is off-site, a failed sync, a rejected
 * event. Yellow is on a break, queued, waiting on a confirmation. Green is
 * clocked on and sent.
 */

import { Platform, type TextStyle } from 'react-native';

export const colors = {
  /* ── PAPER GROUND ──────────────────────────────────────────────────────── */
  paper: '#ece8df',
  paper200: '#e2ddd2', // title-block cells, group bands
  ink: '#14130f', //   15.2:1 on paper
  ink700: '#45423b', //  8.2:1 — body figures
  inkFaint: '#625e56', // 5.3:1 — labels
  line: '#d4cfc4',
  rule5: '#bdb7a9', // the counting rule — every 5th row

  /* ── CAD LEGEND, PAPER CUT. All three land at 5.4:1 on paper. ──────────── */
  magenta: '#b8005e', // crossed a line
  yellow: '#7a5600', // still in hand
  green: '#0a6b3c', // boards down
  fillMagenta: 'rgba(184, 0, 94, 0.10)',
  fillYellow: 'rgba(122, 86, 0, 0.11)',
  fillGreen: 'rgba(10, 107, 60, 0.10)',

  /* ── BRAND. SkelScaff's own #4C4177. CHROME ONLY — never touches data. ── */
  brand: '#4c4177',
  brandLit: '#6e5ea6',

  /* ── STEEL. The recorded colour of the gear, not a designed grey. ─────── */
  steel: '#607898',
} as const;

/**
 * The rosette ladder. 500mm at 1:12.5 = 40px.
 * Named for the measurement, so a wrong number reads as a wrong measurement.
 */
export const r = {
  r8: 5, //   ⅛ rosette
  r4: 10, //  ¼
  r2: 20, //  ½ — the frame inset
  r1: 40, //  ONE ROSETTE = 500mm
  r15: 60, // 1½ — every tap target
  r3: 120, // 3 — the clock button, and the one figure per screen
  lift: 160, // 2000mm = 4 rosettes. Section spacing.
} as const;

/** Minimum tap target. Anything smaller gets missed with gloves on. */
export const MIN_TAP = r.r15;

/**
 * Three faces, three jobs — the dashboard's rule, unchanged.
 *
 * IBM Plex Mono is the primary face because it was drawn for technical
 * documentation rather than for code editors. If a string is a label, a
 * number, a name, an ID, a status or a nav item, it is mono. No exceptions.
 *
 * Instrument Sans is restricted to human sentences.
 *
 * Archivo carries a real `wdth` axis on the web, set to 78 to land near the
 * SkelScaff logo's 0.34 width-to-cap ratio. React Native cannot drive a
 * variation axis, so this ships the nearest genuine width instance — the
 * `condensed` static at wdth 75 — rather than squashing the normal width,
 * which is the thing the axis existed to avoid. Three points narrower than
 * the dashboard, and a true drawn width either way.
 */
export const fonts = {
  display: 'Archivo-Condensed-SemiBold',
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
  sans: 'InstrumentSans_400Regular',
} as const;

/**
 * Slashed zero and tabular figures — a drawing has slashed zeros, and a column
 * of times that jitters as the minutes tick is a column you cannot read.
 */
const figures: TextStyle = Platform.select({
  ios: { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] },
  default: {},
}) as TextStyle;

export const type = {
  /** THE label. One spec, one size. Hierarchy is colour steps, not sizes. */
  lbl: {
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    letterSpacing: 11 * 0.14, // .14em, in points
    textTransform: 'uppercase',
    ...figures,
  } as TextStyle,

  /** The one numeral per screen. 3 rosettes tall. */
  fig: {
    fontFamily: fonts.display,
    fontSize: r.r3,
    lineHeight: r.r3 * 0.94,
    letterSpacing: -r.r3 * 0.03,
    ...figures,
  } as TextStyle,

  /** Secondary numerals and group names. */
  dim: {
    fontFamily: fonts.display,
    fontSize: 26,
    lineHeight: 26 * 1.05,
    letterSpacing: -0.6,
    ...figures,
  } as TextStyle,

  /** Data: times, ids, distances, statuses. Mono, always. */
  dat: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 13 * 1.2,
    letterSpacing: 13 * 0.06,
    ...figures,
  } as TextStyle,

  /** Human sentences. The only place Instrument Sans is allowed. */
  lead: {
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 24,
  } as TextStyle,

  /** A button's own word. Mono, because it is a control, not a sentence. */
  act: {
    fontFamily: fonts.monoMedium,
    fontSize: 17,
    letterSpacing: 17 * 0.1,
    textTransform: 'uppercase',
    ...figures,
  } as TextStyle,
} as const;

/**
 * The font map for expo-font. Archivo is a vendored static instance; the other
 * two come from their packages, which ship the same files the dashboard gets
 * from next/font.
 */
export const FONT_ASSETS = {
  'Archivo-Condensed-SemiBold': require('../assets/fonts/Archivo-Condensed-SemiBold.ttf'),
} as const;
