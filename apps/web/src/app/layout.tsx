import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';

import { RailNav } from '../components/rail-nav';
import { RailDatum } from '../components/rail-datum';

import './globals.css';

/**
 * Three faces, three jobs.
 *
 * IBM Plex Mono is the primary face — about 65% of the interface — because it
 * was drawn for technical documentation rather than for code editors. It is
 * neither JetBrains Mono nor Roboto Mono, which are the giveaway defaults.
 *
 * Archivo carries a real `wdth` axis, so the condensed setting is a genuine
 * width instance rather than a synthetic squash. At wdth 78 it lands near the
 * SkelScaff logo's measured 0.34 width-to-cap ratio.
 *
 * Instrument Sans is restricted to human sentences.
 *
 * The `variable` names below must match the var() calls in globals.css
 * exactly. Get one wrong and everything silently falls back to Segoe UI —
 * which is the defect this redesign exists to fix.
 */

const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  weight: 'variable',
  variable: '--font-archivo',
  display: 'swap',
});

const plex = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex',
  display: 'swap',
});

const instrument = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SkelClock — SkelScaff attendance',
  description: 'Site attendance, timesheets and Odoo synchronisation for SkelScaff.',
  icons: { icon: '/brand/favicon.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-AU"
      className={`${archivo.variable} ${plex.variable} ${instrument.variable}`}
    >
      <body>
        {/* A standard, not a topbar — elevations read vertically. 195px is a
            2438 bay at 1:12.5. */}
        <aside className="rail">
          <div className="rail__mark">
            {/* The real mark from skelscaff.com.au, at its own declared size.
                It is a raster in a Figma wrapper; forcing another width
                distorts it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/skelscaff-logo-white.svg" alt="SkelScaff" />
          </div>
          <div className="rail__word">SKELCLOCK</div>
          <RailNav />
          <RailDatum />
        </aside>
        {children}
      </body>
    </html>
  );
}
