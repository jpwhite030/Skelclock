'use client';

/**
 * Leaflet touches `window` at import time, so it cannot go through SSR — this
 * is the client-only boundary `next/dynamic` requires for that (a Server
 * Component page can't pass `ssr: false` itself in the App Router).
 */

import dynamic from 'next/dynamic';

import type { SiteSummary } from '@skelclock/server';

const SitesMap = dynamic(() => import('./sites-map').then((m) => m.SitesMap), {
  ssr: false,
  loading: () => <div className="panel empty">Loading map…</div>,
});

export function SitesMapLoader({
  sites,
  canEdit,
  crewOnSite,
}: {
  sites: SiteSummary[];
  canEdit: boolean;
  crewOnSite: Record<string, number>;
}) {
  return <SitesMap sites={sites} canEdit={canEdit} crewOnSite={crewOnSite} />;
}
