'use server';

/**
 * Payroll policy — admin only. It changes how every employee's pay is
 * computed company-wide, so the check here is deliberately blunter than the
 * supervisor-scoped corrections screen: no "is this your report", just admin
 * or refused.
 */

import { revalidatePath } from 'next/cache';

import { SettingsError, updateCompanySettings, type TravelAllocation } from '@skelclock/server';

import { db } from '../../lib/db';
import { getDashboardSession } from '../../lib/session';

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function savePayrollSettings(args: {
  autoLunchEnabled: boolean;
  autoLunchThresholdMinutes: number;
  autoLunchDurationMinutes: number;
  travelAllocation: TravelAllocation;
  operatingHoursStart: string | null;
  operatingHoursEnd: string | null;
}): Promise<ActionResult> {
  const session = await getDashboardSession();
  if (!session || session.role !== 'admin') {
    return { ok: false, message: 'Only an admin can change payroll settings.' };
  }

  try {
    await updateCompanySettings(db, { companyId: session.companyId, ...args });
    revalidatePath('/settings');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof SettingsError ? error.message : 'Could not save settings.',
    };
  }
}
