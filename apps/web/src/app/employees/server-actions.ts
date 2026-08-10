'use server';

/**
 * Role changes — admin only, and deliberately blunter than the supervisor-
 * scoped screens. A role is company-wide authority, so there is no "is this
 * your report" softening here: admin or refused.
 *
 * The interesting guard lives in packages/server/src/roles.ts, not here: the
 * last admin cannot be demoted, because a company with no admin cannot promote
 * anybody back and the only way out is SQL against production.
 */

import { revalidatePath } from 'next/cache';

import {
  RoleError,
  setUserRole,
  syncRolesFromOdoo,
  type RoleSyncResult,
} from '@skelclock/server';
import type { UserRole } from '@skelclock/core';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const ROLES: UserRole[] = ['worker', 'supervisor', 'admin'];

export async function changeRole(args: {
  appUserId: string;
  role: string;
  reason: string;
}): Promise<ActionResult> {
  const session = await getDashboardSession();
  if (!session || session.role !== 'admin') {
    return { ok: false, message: 'Only an admin can change roles.' };
  }
  if (!session.appUserId) {
    return { ok: false, message: 'Development mode has no user to attribute this to.' };
  }
  // Validated against the list rather than cast: this value arrives from a
  // form post, and the database enum would reject it with a 500 rather than a
  // sentence.
  if (!ROLES.includes(args.role as UserRole)) {
    return { ok: false, message: 'That is not a role.' };
  }

  try {
    await setUserRole(db, {
      companyId: session.companyId,
      targetAppUserId: args.appUserId,
      role: args.role as UserRole,
      actorUserId: session.appUserId,
      reason: args.reason,
    });
    revalidatePath('/employees');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof RoleError ? error.message : 'Could not change the role.',
    };
  }
}

export async function syncRolesNow(): Promise<ActionResult & { result?: RoleSyncResult }> {
  const session = await getDashboardSession();
  if (!session || session.role !== 'admin') {
    return { ok: false, message: 'Only an admin can sync roles.' };
  }

  try {
    const result = await syncRolesFromOdoo(db, {
      companyId: session.companyId,
      actorUserId: session.appUserId,
    });
    revalidatePath('/employees');
    return {
      ok: true,
      result,
      message: `${result.promoted} promoted, ${result.demoted} set back to worker, ${result.skippedManual} left alone because somebody had set them by hand.`,
    };
  } catch {
    return { ok: false, message: 'Could not sync roles from Odoo.' };
  }
}
