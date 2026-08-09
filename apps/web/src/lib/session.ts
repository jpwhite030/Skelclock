/**
 * Server-component session resolution.
 *
 * The dashboard pages are server components and cannot use the bearer-token
 * path the mobile API routes use, so the Supabase session is read from cookies.
 *
 * Development fallback: only when Supabase auth is not configured at all (no
 * SUPABASE_URL/anon key in the environment) does this fall back to the single
 * company in the database, so a fresh clone's dashboard works. The moment
 * Supabase is configured, a browser with no session gets nothing — and the
 * fallback is refused outright when NODE_ENV is production.
 */

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { one } from '@skelclock/server';

import { db } from './db';

export interface DashboardSession {
  companyId: string;
  companyName: string;
  appUserId: string | null;
  /** Null for a login with no linked employee row (e.g. an office-only admin). */
  employeeId: string | null;
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
    if (!data.user) {
      // Supabase is configured but this browser holds no session: that is a
      // visitor who has not signed in, not a bare development install. The
      // demo fallback below must not answer for them — it would present the
      // whole company, as admin, to anyone who found the URL.
      return null;
    }

    const row = await one<{
      id: string;
      company_id: string;
      employee_id: string | null;
      role: DashboardSession['role'];
      full_name: string | null;
      company_name: string;
    }>(
      db,
      `select u.id, u.company_id, u.employee_id, u.role, e.full_name, c.name as company_name
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
        employeeId: row.employee_id,
        role: row.role,
        fullName: row.full_name,
        unauthenticated: false,
      };
    }
    return null;
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
    employeeId: null,
    role: 'admin',
    fullName: null,
    unauthenticated: true,
  };
}
