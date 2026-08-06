/**
 * Chooses the adapter from the environment.
 *
 * ODOO_MODE=mock is the default so a fresh clone runs with no credentials.
 * Flipping it to `live` is the only change needed once the Odoo details are
 * confirmed — no code above this line knows the difference.
 */

import { LiveOdooAdapter } from './odoo-adapter.js';
import { MockOdooAdapter } from './mock-adapter.js';
import type { OdooAdapter } from './adapter.js';

/**
 * Index signature rather than a closed shape: this is handed `process.env`,
 * and a closed interface makes TypeScript reject it for having no properties
 * in common (every field here is optional).
 */
export interface AdapterEnv {
  ODOO_MODE?: string | undefined;
  ODOO_URL?: string | undefined;
  ODOO_DB?: string | undefined;
  ODOO_USERNAME?: string | undefined;
  ODOO_API_KEY?: string | undefined;
  ODOO_JOB_MODEL?: string | undefined;
  ODOO_ACTIVITY_MODEL?: string | undefined;
  [key: string]: string | undefined;
}

export function createOdooAdapter(env: AdapterEnv = process.env): OdooAdapter {
  const mode = (env.ODOO_MODE ?? 'mock').toLowerCase();

  if (mode !== 'live') return new MockOdooAdapter();

  const missing = (['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY'] as const).filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    throw new Error(
      `ODOO_MODE=live but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Fill them in .env, or set ODOO_MODE=mock to run against fixtures.',
    );
  }

  return new LiveOdooAdapter(
    {
      url: env.ODOO_URL!,
      db: env.ODOO_DB!,
      username: env.ODOO_USERNAME!,
      apiKey: env.ODOO_API_KEY!,
    },
    {
      jobModel: env.ODOO_JOB_MODEL,
      activityModel: env.ODOO_ACTIVITY_MODEL,
    },
  );
}
