/**
 * Server-component session resolution.
 *
 * The dashboard pages are server components and cannot use the bearer-token
 * path the mobile API routes use, so the Supabase session is read from cookies.
 *
 * MVP note: with no session (a fresh local install, before Supabase auth is
 * wired up) this falls back to the single company in the database so the
 * dashboard is usable during development. That fallback is refused when
 * NODE_ENV is production — it must never become the way the office signs in.
 */

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { one } from '@skelclock/server';

import { db } from './db';

export interface DashboardSession {
  companyId: string;
  companyName: string;
  appUserId: string | null;
  role: 'worker' | 'supervisor' | 'admin';
  fullName: string | null;
  /** True when running on the development fallback rather than a real login. */
  unauthenticated: boolean;
}

export async function getDashboardSession(): Promise<DashboardSession | null> {
  const cookieStore = await cookies();

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (url && anonKey) {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        // Server components cannot set cookies; the middleware refresh handles
        // that. Swallowing here keeps reads from throwing.
        setAll: () => undefined,
      },
    });

    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const row = await one<{
        id: string;
        company_id: string;
        role: DashboardSession['role'];
        full_name: string | null;
        company_name: string;
      }>(
        db,
        `select u.id, u.company_id, u.role, e.full_name, c.name as company_name
           from app_user u
           join company c on c.id = u.company_id
           left join employee e on e.id = u.employee_id
          where u.auth_user_id = $1 and u.active`,
        [data.user.id],
      );

      if (row) {
        return {
          companyId: row.company_id,
          companyName: row.company_name,
          appUserId: row.id,
          role: row.role,
          fullName: row.full_name,
          unauthenticated: false,
        };
      }
      return null;
    }
  }

  if (process.env.NODE_ENV === 'production') return null;

  const company = await one<{ id: string; name: string }>(
    db,
    'select id, name from company order by created_at limit 1',
  );
  if (!company) return null;

  return {
    companyId: company.id,
    companyName: company.name,
    appUserId: null,
    role: 'admin',
    fullName: null,
    unauthenticated: true,
  };
}
