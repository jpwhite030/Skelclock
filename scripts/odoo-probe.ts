/**
 * Odoo instance probe.
 *
 * The brief lists six things to confirm before building the integration. Five
 * of them are answerable by asking the instance directly, which is faster and
 * more reliable than asking a person to remember. Fill in .env and run:
 *
 *     ODOO_MODE=live npm run odoo:probe
 *
 * It only reads. Nothing is created, written or deleted.
 */

import { LiveOdooAdapter, OdooClient } from '@skelclock/odoo';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const heading = (s: string): void => console.log(`\n${BOLD}${s}${RESET}`);
const answer = (q: string, a: string): void =>
  console.log(`  ${GREEN}${q}${RESET}\n    ${a}`);
const note = (s: string): void => console.log(`    ${DIM}${s}${RESET}`);

async function main(): Promise<void> {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DB;
  const username = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY;

  if (!url || !db || !username || !apiKey) {
    console.error(
      `${RED}Set ODOO_URL, ODOO_DB, ODOO_USERNAME and ODOO_API_KEY in .env first.${RESET}\n` +
        `${DIM}The API key comes from Odoo: Settings > Users > (your API user) >\n` +
        `Account Security > New API Key. Use a key, not the account password.${RESET}`,
    );
    process.exit(1);
  }

  const client = new OdooClient({ url, db, username, apiKey });
  const adapter = new LiveOdooAdapter(
    { url, db, username, apiKey },
    { jobModel: process.env.ODOO_JOB_MODEL },
  );

  console.log(`${BOLD}Probing ${url} (database: ${db})${RESET}`);

  // --- Q1 & Q4: version, and whether external API access works -------------
  heading('1. Odoo version  ·  4. External API access');
  const connection = await adapter.testConnection();
  if (!connection.reachable) {
    console.error(`  ${RED}Could not connect: ${connection.error}${RESET}`);
    note('If this is a timeout, the instance may restrict API access by IP.');
    note('If it is "access denied", check ODOO_DB and that the key is an API key.');
    process.exit(1);
  }
  answer('Version', connection.serverVersion ?? 'unknown');
  answer('External API', `Working. Authenticated as uid ${connection.uid}.`);

  const version = await client.version();
  note(JSON.stringify(version));

  // --- Q2: hosting ---------------------------------------------------------
  heading('2. Hosting');
  const host = new URL(url).hostname;
  if (host.endsWith('.odoo.com')) {
    answer('Hosting', 'Odoo Online (SaaS).');
    note('Custom modules cannot be installed. Studio custom fields (x_*) can.');
  } else if (host.endsWith('.odoo.sh')) {
    answer('Hosting', 'Odoo.sh.');
    note('Custom modules can be installed via the git repository.');
  } else {
    answer('Hosting', `Self-hosted or a custom domain (${host}).`);
    note('Custom modules can normally be installed. Confirm who administers it.');
  }

  // --- Q3: can custom modules be installed --------------------------------
  heading('3. Custom modules and fields');
  const studioFields = await client
    .searchRead<{ name: string; model: string }>(
      'ir.model.fields',
      [
        ['name', 'like', 'x_%'],
        ['state', '=', 'manual'],
      ],
      ['name', 'model'],
      { limit: 20 },
    )
    .catch(() => []);

  if (studioFields.length > 0) {
    answer('Custom fields', `${studioFields.length}+ already present — Studio is in use.`);
    for (const f of studioFields.slice(0, 10)) note(`${f.model}.${f.name}`);
  } else {
    answer('Custom fields', 'None found. No Studio customisation in place yet.');
  }

  // --- Q5: which model represents a job ------------------------------------
  heading('5. Which model represents a SkelScaff job');
  const counts = await adapter.probeJobModels();
  for (const [model, count] of Object.entries(counts)) {
    const label =
      count === 'unavailable'
        ? `${DIM}not installed / not readable${RESET}`
        : `${count} record(s)`;
    console.log(`  ${model.padEnd(24)} ${label}`);
  }

  const usable = Object.entries(counts).filter(
    ([, c]) => typeof c === 'number' && c > 0,
  ) as Array<[string, number]>;

  if (usable.length === 0) {
    console.log(`  ${YELLOW}No candidate model has records. Ask which one jobs live in.${RESET}`);
  } else {
    const [best] = usable.sort((a, b) => b[1] - a[1]);
    answer('Most likely', `${best![0]} (${best![1]} records)`);
    note(`Set ODOO_JOB_MODEL=${best![0]} in .env.`);

    // Show a couple so a human can confirm they look like jobs.
    const sample = await client
      .searchRead<Record<string, unknown>>(best![0], [], ['id', 'display_name'], { limit: 5 })
      .catch(() => []);
    for (const s of sample) note(`#${s.id} ${s.display_name}`);
  }

  // --- Q6: payroll and planning -------------------------------------------
  heading('6. Payroll and Planning modules');
  for (const [label, model] of [
    ['Payroll', 'hr.payslip'],
    ['Planning', 'planning.slot'],
    ['Timesheets', 'account.analytic.line'],
    ['Attendance', 'hr.attendance'],
    ['Projects', 'project.project'],
    ['Tasks', 'project.task'],
  ] as const) {
    const exists = await client.modelExists(model);
    const count = exists
      ? await client.executeKw<number>(model, 'search_count', [[]]).catch(() => null)
      : null;
    console.log(
      `  ${label.padEnd(12)} ${model.padEnd(24)} ` +
        (exists
          ? `${GREEN}installed${RESET} ${DIM}${count ?? '?'} records${RESET}`
          : `${DIM}not installed${RESET}`),
    );
  }

  // --- geofence source -----------------------------------------------------
  heading('Geofence coordinates');
  const partnerFields = await client
    .fieldsOf('res.partner')
    .catch((): string[] => []);
  const hasGeo = partnerFields.includes('partner_latitude');
  if (hasGeo) {
    const located = await client
      .executeKw<number>('res.partner', 'search_count', [
        [['partner_latitude', '!=', 0]],
      ])
      .catch(() => 0);
    answer(
      'base_geolocalize',
      `Installed. ${located} partner(s) already have coordinates.`,
    );
    note('Site fences can be seeded from the customer address.');
  } else {
    answer('base_geolocalize', 'Not installed.');
    note('Coordinates will be set per site inside SkelClock (the site table owns them).');
  }

  // --- write permission check ---------------------------------------------
  heading('Attendance write permission');
  const canWrite = await client
    .executeKw<boolean>('hr.attendance', 'check_access_rights', ['write'], {
      raise_exception: false,
    })
    .catch(() => false);
  const canCreate = await client
    .executeKw<boolean>('hr.attendance', 'check_access_rights', ['create'], {
      raise_exception: false,
    })
    .catch(() => false);

  if (canCreate && canWrite) {
    answer('hr.attendance', `${username} can create and update attendance records.`);
  } else {
    console.log(
      `  ${YELLOW}${username} cannot ${!canCreate ? 'create' : ''}${!canCreate && !canWrite ? '/' : ''}${!canWrite ? 'update' : ''} hr.attendance.${RESET}`,
    );
    note('Give the integration user the "Human Resources / Administrator" role,');
    note('or a custom group with create+write on hr.attendance.');
  }

  const employees = await client
    .executeKw<number>('hr.employee', 'search_count', [[]])
    .catch(() => 0);
  heading('Scale');
  console.log(`  ${employees} employee record(s) would be imported.`);

  console.log(
    `\n${DIM}Nothing was written. Paste this output back and the mapping in\n` +
      `packages/odoo/src/mapping.ts can be set for real.${RESET}`,
  );
}

main().catch((error) => {
  console.error(`\n${RED}Probe failed:${RESET}`, error instanceof Error ? error.message : error);
  process.exit(1);
});
