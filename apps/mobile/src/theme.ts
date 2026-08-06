/**
 * Visual constants.
 *
 * Sized for the actual conditions: gloved hands, direct sun on a scaffold
 * deck, and a phone held at arm's length. Everything tappable is at least 56pt
 * high, the clock button is far larger, and the palette is high-contrast
 * rather than subtle.
 */

export const colors = {
  bg: '#12161c',
  surface: '#1b212a',
  surfaceRaised: '#232b36',
  border: '#2e3846',

  text: '#f2f5f8',
  textMuted: '#9aa7b6',

  // Clock-on green and clock-off amber, picked to stay distinguishable for
  // the most common forms of colour blindness — they differ in lightness as
  // well as hue, and every state is labelled in words as well.
  on: '#1f9d55',
  onPressed: '#187a42',
  off: '#c2410c',
  offPressed: '#9a3412',
  breakColour: '#2563eb',

  warn: '#b45309',
  error: '#b91c1c',
  ok: '#15803d',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

export const type = {
  display: { fontSize: 44, fontWeight: '700' as const },
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.6 },
} as const;

/** Minimum tap target. Anything smaller gets missed with gloves on. */
export const MIN_TAP = 56;
