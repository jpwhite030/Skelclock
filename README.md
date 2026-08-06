# SkelClock

Field attendance for SkelScaff. Workers clock on and off from a phone, the
office reviews and approves, and approved hours are pushed into Odoo.

Odoo stays the source of truth for employees and jobs. This system owns the
attendance record and nothing else.

---

## Run it right now

No credentials, no Docker, no Odoo account needed:

```bash
npm install
npm run poc      # the 7-step proof of concept, end to end
npm test         # 113 tests
```

`npm run poc` runs the First Engineering Deliverable from the brief against an
in-process Postgres and a fake Odoo, and prints each step as it happens:

```
Step 2: Import one employee from Odoo
  ✓ Employee imported
    Dean Whitmore (#SS-114)
    Odoo hr.employee id 1042 stored against the app user

Step 5: Capture time and GPS coordinates
  ✓ Device timestamp recorded
    Device time: 2026-08-03T20:00:00.000Z (what the phone said)
    Server time: 2026-08-03T20:00:04.000Z (when we received it)
  ✓ Inside the site geofence
    Distance from site centre: 38.1m
  ✓ A retried event is deduplicated

Step 7: Create the attendance record in Odoo
  ✓ Push succeeded
    hr.attendance id 5000: 2026-08-03T20:00:00Z → 2026-08-03T23:00:00Z
    hr.attendance id 5001: 2026-08-03T23:30:00Z → 2026-08-04T04:30:00Z
  ✓ Odoo worked_hours totals 8h, matching our 8h paid
```

## See the dashboard

```bash
cd apps/web && npx next dev -p 3100
```

Then open **http://localhost:3100**.

With no `DATABASE_URL` set it boots an in-process Postgres, applies the
migrations and seeds a working day at SkelScaff — four workers on the tools,
one of them 4km off-site, a week of completed timesheets, and one Odoo push
that failed so the retry button has something to retry.

The seed drives the real service layer (`ingestEvents`, `rebuildTimesheet`,
`approveTimesheet`, `runSyncWorker`) rather than inserting rows, so nothing on
screen is data the system could not actually have produced.

Set `DATABASE_URL` and it uses that instead. In production a missing
`DATABASE_URL` is a hard error — the demo path can never be reached there.

---

## Layout

```
packages/core      Domain logic. No I/O, no database, runs on the phone and
                   the server alike: the clock state machine, geofence maths,
                   segment building, exception detection, idempotency keys.

packages/odoo      Everything that knows an Odoo field name. Adapter interface,
                   live JSON-RPC client, mock adapter, and mapping.ts — the one
                   file that changes when the Odoo questions are answered.

packages/server    Service layer. Ingest, timesheet rebuild, approval ladder,
                   corrections, crew clocking, the sync queue, dashboard reads.

apps/mobile        Expo app. Clock screen, offline SQLite queue, GPS capture.
apps/web           Next.js. The mobile API plus the four office screens.

supabase/migrations  The schema. 0001-0004 are portable Postgres; 1001 is
                     Supabase-only (auth linkage and row-level security).

scripts/           poc.ts, odoo-probe.ts, local-db.ts, integration.test.ts
```

---

## Before this can touch real Odoo

Six things need confirming, and five of them the instance can answer itself.
Put the credentials in `.env` and run:

```bash
ODOO_MODE=live npm run odoo:probe
```

It only reads — nothing is created, written or deleted. It reports the Odoo
version, the hosting type, whether the external API is reachable, which of
`project.project` / `sale.order` / a custom model actually holds jobs, whether
Payroll and Planning are installed, whether coordinates are available for
geofences, and whether the integration user can write `hr.attendance`.

Paste the output back and `packages/odoo/src/mapping.ts` gets set for real.
Until then everything above that file is finished and tested against the mock.

**Still needs a human answer:** whether custom Odoo modules may be installed.
That decides whether site coordinates live on the job in Odoo or on the `site`
table here — see `GEO_NOTE` in `packages/odoo/src/mapping.ts` for the three
options and what each costs.

### Getting the credentials

`ODOO_API_KEY` is an API key, not a password: in Odoo, Settings → Users → the
integration user → Account Security → New API Key. Create a dedicated user for
this rather than using someone's personal login, so its actions are
distinguishable in Odoo's own audit trail.

---

## Deploying

1. **Database.** Create a Supabase project in `ap-southeast-2` (Sydney). Apply
   `supabase/migrations/*.sql` in filename order — all five, including `1001`,
   which is the one that turns on row-level security.
2. **Web.** Deploy `apps/web` with `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the Odoo variables set.
   Point a cron at `GET /api/sync` every few minutes with the `CRON_SECRET`
   bearer token.
3. **Mobile.** `cd apps/mobile && npx expo prebuild && npx expo run:android`.
   This needs a development build, not Expo Go — it uses native location and
   SQLite modules.
4. **Seed.** Import employees and jobs from Odoo before anyone tries to log in;
   a login with no matching employee record is refused by design.

---

## The parts worth knowing about

### Duplicate attendance is prevented in three independent places

The brief lists this as acceptance criterion 8, and one mechanism is not
enough, because there are three different ways a duplicate happens.

| What happens | What stops it |
| --- | --- |
| Phone retries a queued event after a lost response | `idempotency_key`, minted at press time, unique index on `(company_id, idempotency_key)` |
| Worker taps "Clock on" twice | The state machine — you cannot clock in while clocked in |
| Push to Odoo retried after the response was lost | The adapter searches `hr.attendance` by employee and check-in before creating |

The third is the one that would otherwise double someone's pay, and it holds
even if the local record of the Odoo id is lost entirely.

### Attendance is append-only, enforced by the database

`supabase/migrations/0002_integrity.sql` puts triggers on `attendance_event`
that reject an in-place edit of a time or a position, reject a delete, reject a
void with no reason, and reject un-voiding. A correction writes a *new* event
and marks the old one superseded. The original stays exactly as the worker's
phone recorded it, forever.

This is in the database rather than application code deliberately — application
code gets rewritten, and this is the guarantee payroll rests on.

### Unpaid breaks split the day in Odoo

`hr.attendance` computes `worked_hours` from `check_out - check_in`. Pushing
one record spanning the whole day would hand payroll a number 30 minutes too
high, every day. So an unpaid break ends one attendance record and starts
another, and Odoo's own total comes out equal to our paid hours with no
reconciliation step. See `packages/odoo/src/attendance-blocks.ts`.

### GPS never blocks a worker

Phone GPS on a scaffold deck is routinely 50–100m out. The system measures the
distance, records it, and raises an exception for the office — it does not
refuse the clock-on. If the worker is outside the fence the app asks for a
reason first, and "clock on anyway" is always available. A job with no
coordinates loaded yet produces `inside_geofence = null`, which is deliberately
different from `false` and raises nothing.

### The device clock is the payroll clock

Every event carries both `device_time` (what the phone said when the button was
pressed) and `server_time` (when we received it). After a day with no
reception these differ by hours. Everything that matters — the state machine,
the segment builder, the Odoo push — orders and measures on `device_time`.

### Timezones

Odoo stores datetimes as naive UTC strings and will silently misinterpret an
ISO string carrying an offset. Getting that wrong shifts every shift in the
system by 10 or 11 hours, so the conversion lives in one place
(`toOdooDatetime`) with tests covering AEST, AEDT and UTC.

---

## What is built

Phase 1 of the brief is complete and tested:

- Employee and job import from Odoo, keyed on the Odoo id
- Manual clock on/off with GPS capture and geofence evaluation
- Offline queue with idempotency, on-device SQLite, automatic flush
- Approval ladder: draft → worker confirmed → supervisor approved → synced → locked
- Odoo attendance push with retry, backoff, and a visible failure queue
- Admin dashboard: Working Now, Timesheets, Exceptions, Odoo Sync
- Full audit trail on every attendance change

Phase 2 exists in the service layer and is covered by tests — breaks, job and
activity switching, crew clocking, supervisor corrections, approvals,
exceptions — but only the worker-facing screens are built. **The supervisor's
mobile view is not yet built**; a supervisor can do all of it through the API
and the service layer, but not yet through a screen designed for them.

Phase 3 (automatic geofence clocking) is not started. The schema is ready for
it: `attendance_event.is_suggested` exists so a geofence-raised event lands as
a suggestion needing confirmation, never as an irreversible payroll record.

---

## Testing

```bash
npm test          # everything: 113 tests
npm run test:unit # domain logic only, no database, ~1s
```

The integration tests run against PGlite — real Postgres 17 compiled to WASM —
so the triggers, constraints and `for update skip locked` being asserted are
the same ones that will run on Supabase. No Docker needed.

Each block in `scripts/integration.test.ts` maps to one of the ten MVP
acceptance criteria in the brief.
