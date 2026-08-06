/**
 * Request authentication.
 *
 * Every API route resolves the caller to an app_user row before touching data,
 * and the role on that row is what authorises the action. The Supabase JWT is
 * only ever used to establish *who* — never *what they may do*, because a
 * client controls its own token metadata and must not control its own role.
 */

import { createClient } from '@supabase/supabase-js';

import { one } from '@skelclock/server';

import { db } from './db';

export interface Caller {
  appUserId: string;
  companyId: string;
  employeeId: string | null;
  role: 'worker' | 'supervisor' | 'admin';
  fullName: string | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Resolves the bearer token on a request to an app_user. */
export async function requireCaller(request: Request): Promise<Caller> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AuthError('Not signed in.', 401);

  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) throw new AuthError('Session is not valid.', 401);

  const caller = await one<{
    id: string;
    company_id: string;
    employee_id: string | null;
    role: Caller['role'];
    full_name: string | null;
  }>(
    db,
    `select u.id, u.company_id, u.employee_id, u.role, e.full_name
       from app_user u
       left join employee e on e.id = u.employee_id
      where u.auth_user_id = $1 and u.active`,
    [data.user.id],
  );

  if (!caller) {
    throw new AuthError(
      'This login is not linked to an employee record. Ask the office to check the number against Odoo.',
      403,
    );
  }

  return {
    appUserId: caller.id,
    companyId: caller.company_id,
    employeeId: caller.employee_id,
    role: caller.role,
    fullName: caller.full_name,
  };
}

export function requireRole(caller: Caller, ...roles: Caller['role'][]): void {
  if (!roles.includes(caller.role)) {
    throw new AuthError('You do not have access to this.', 403);
  }
}

/** Turns an AuthError into a response; rethrows anything else. */
export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof AuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}
