'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The sheet index.
 *
 * A client component purely so `usePathname` can set `aria-current`. The
 * previous build styled `a[aria-current="page"]` and rendered bare `<Link>`s
 * from a server component — Next does not set that attribute itself, so the
 * rule was dead CSS and all four tabs looked identical, permanently. With four
 * screens that also shared one layout, there was no way at all to tell which
 * page you were on.
 *
 * Labels stay in plain English. The drawing-office vocabulary lives in the
 * sheet subtitle, where it is flavour rather than wayfinding.
 */

const TABS = [
  { href: '/', label: 'Working now', sht: '01' },
  { href: '/timesheets', label: 'Timesheets', sht: '02' },
  { href: '/exceptions', label: 'Exceptions', sht: '03' },
  { href: '/sites', label: 'Sites', sht: '04' },
  { href: '/sync', label: 'Odoo sync', sht: '05' },
  { href: '/settings', label: 'Settings', sht: '06' },
  { href: '/employees', label: 'Employees', sht: '07' },
] as const;

export function RailNav() {
  const path = usePathname();

  return (
    <nav aria-label="Sheets">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          data-sht={tab.sht}
          aria-current={path === tab.href ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
