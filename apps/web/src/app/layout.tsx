import type { Metadata } from 'next';
import Link from 'next/link';

import './globals.css';

export const metadata: Metadata = {
  title: 'SkelClock — SkelScaff attendance',
  description: 'Site attendance, timesheets and Odoo synchronisation for SkelScaff.',
};

const TABS = [
  { href: '/', label: 'Working now' },
  { href: '/timesheets', label: 'Timesheets' },
  { href: '/exceptions', label: 'Exceptions' },
  { href: '/sites', label: 'Sites' },
  { href: '/sync', label: 'Odoo sync' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">SkelClock</div>
            <nav className="tabs">
              {TABS.map((tab) => (
                <Link key={tab.href} href={tab.href}>
                  {tab.label}
                </Link>
              ))}
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
