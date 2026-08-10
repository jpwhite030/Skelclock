'use client';

/** Same client-only boundary as SHT 04's map — Leaflet touches `window` at
 * import time and cannot pass through SSR. */

import dynamic from 'next/dynamic';

import type { SiteSummary, WorkingNowRow } from '@skelclock/server';

const WorkingMap = dynamic(() => import('./working-map').then((m) => m.WorkingMap), {
  ssr: false,
  loading: () => <div className="working-map working-map--loading">Loading site plan…</div>,
});

export function WorkingMapLoader({ rows, sites }: { rows: WorkingNowRow[]; sites: SiteSummary[] }) {
  return <WorkingMap rows={rows} sites={sites} />;
}
