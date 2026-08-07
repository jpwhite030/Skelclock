# SkelClock

Field attendance for SkelScaff. Workers clock on and off from a phone, the
office reviews and approves, and approved hours are pushed into Odoo.

Odoo stays the source of truth for employees and jobs. This system owns the
attendance record and nothing else.

This file is the quick start. **The full developer handbook — architecture,
data model, every pipeline and invariant — is [DEVELOPERS.md](DEVELOPERS.md).**

---

## Run it right now

No credentials, no Docker, no Odoo account needed:

```bash
npm install
npm run poc      # the 7-step proof of concept, end to end
npm test         # 159 tests
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

## See the phone app

Two terminals. The API first, on port 3000, which is where the app looks:

```bash
cd apps/web && npx next dev -p 3000
```

Then build and run the app. `ios/` is generated from `app.json` rather than
committed, so the first run has a prebuild in it and takes a few minutes:

```bash
cd apps/mobile
npx expo prebuild --platform ios
npx expo run:ios --device "iPhone 17 Pro"
```

This needs a development build, not Expo Go — the app uses native location,
SQLite and Keychain modules. `npx expo run:android` is the equivalent.

With no Supabase project configured there is no SMS provider, so the login
screen switches to **demo mode**: it lists the five seeded workers, and any six
digits gets you in. The bearer token becomes `demo:+61412555208`, which
`requireCaller()` resolves straight to that `app_user`. It is a complete
authentication bypass, so the server refuses those tokens both in production
and the moment a real `SUPABASE_URL` is configured — see `apps/web/src/lib/auth.ts`.

Signing in as Dean Whitmore puts you on a live shift: job 1032 at 14 Kembla
Street, hours counting up, and Clock Off / Start Break driving the same queue,
idempotency and sync path a real handset would.

To run against a real device rather than the simulator, the phone needs a route
to your Mac — set `EXPO_PUBLIC_API_URL` to its LAN address rather than
`localhost`:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000 npx expo run:ios --device
```

---

## Layout

```
packages/core      Domain logic. No I/O, no database, runs on the phone and
                   the server alike: the clock state machine, geofence maths,
                   segment building, exception detection, idempotency keys,
                   operating-hours window maths.

packages/contracts The wire contract between web and mobile. Zod schemas that
                   both the API routes and the phone validate against, so the
                   two apps cannot drift apart silently.

packages/odoo      Everything that knows an Odoo field name. Adapter interface,
                   live JSON-RPC client, mock adapter, and mapping.ts — the one
                   file that changes when the Odoo questions are answered.

packages/server    Service layer. Ingest, timesheet rebuild, approval ladder,
                   corrections, crew clocking, suggestions, payroll settings,
                   authz, the sync queue, dashboard reads.

apps/mobile        Expo app. Clock screen, live site map, offline SQLite queue,
                   GPS capture, shift tracking, background geofence clocking.
                   auth.ts is the one sign-in interface the screens see, with
                   Supabase behind it, or demo sign-in when it is unconfigured.
apps/web           Next.js. The mobile API plus the six office screens.

supabase/migrations  The schema. 0001-0006 are portable Postgres; 1001 is
                     Supabase-only (auth linkage and row-level security).

scripts/           poc.ts, odoo-probe.ts, local-db.ts, integration.test.ts,
                   shots.ts (screenshots every dashboard screen)
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
   `supabase/migrations/*.sql` in filename order — all seven, including `1001`,
   which is the one that turns on row-level security.
2. **Web.** Deploy `apps/web` with `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the Odoo variables set.
   Point a cron at `GET /api/sync` every few minutes with the `CRON_SECRET`
   bearer token.
3. **Mobile.** `cd apps/mobile && npx expo prebuild && npx expo run:ios` (or
   `run:android`). This needs a development build, not Expo Go — it uses native
   location, SQLite and Keychain modules. Set `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_ANON_KEY` so the app uses real SMS login rather than
   the demo sign-in, and `EXPO_PUBLIC_API_URL` to point at the deployed web app.
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

### The phone is SETOUT on paper

The dashboard's drawing language, on the handset: the rosette ladder, the three
faces, the CAD legend with its meanings intact, and not a rounded corner on
either screen. `apps/mobile/src/theme.ts` lifts its values from
`apps/web/src/app/globals.css` rather than re-picking them, because two halves
of one system that merely resemble each other are worse than either done
properly.

It uses the **paper** ground rather than the dark one. The dashboard splits
those by reading time — dark for a glance, paper for the twenty-minute read —
but a phone breaks the tie on a different axis: this screen is read at arm's
length in direct sun on a scaffold deck, which is the one condition a dark
ground fails hardest. SETOUT already specifies the paper inks and the legend
re-cut for paper, so this is the system's second ground, not a third look.

Two places the phone departs from the drawing, both for the hand:

- **Tap targets are 1.5 rosettes (60px), not one.** A rosette is 40px and a
  gloved thumb needs 56. The clock button is 3 rosettes. The ladder still
  governs; the hand sets the floor.
- **Archivo ships at wdth 75, not 78.** React Native cannot drive a variation
  axis, so it embeds the nearest genuine width instance rather than squashing
  the normal width — which is the thing the axis existed to avoid.

Magenta is deliberately absent from the Clock Off button. Knocking off is not
an exception, and spending the "something has crossed a line" colour on the
most-pressed control would leave nothing to say when something actually has.

### The fence blocks clocking on, and never blocks clocking off

A worker has to be inside the site boundary to clock on. This is a change from
the original brief, which said GPS must never stop someone starting work, and
it is enforced on the phone rather than the server — see below for why.

The important half is what it does *not* refuse, because phone GPS on a
scaffold deck is routinely 50–100m out and a bad fix must not cost somebody a
shift. `blocksClockIn()` in `packages/core/src/geo.ts` lets three cases
through:

| Case | Why |
| --- | --- |
| No position at all | A basement, a shed, a flat GPS, a refused permission. Unknown is not the same as outside. |
| Site has no coordinates | `inside_geofence = null`. The fence does not exist yet, so there is nothing to be outside of. |
| Error bars reach the fence | If the accuracy margin overlaps the boundary we do not know which side they are on, and a guess there is a guess about someone's pay. |

**Clocking off is never blocked.** A worker who has already left the site must
always be able to end their shift — otherwise the fence traps them on the clock
and the hours run all night. Off-site clock-offs still record a reason and
raise an exception for the office, exactly as before.

**Enforcement is client-side only, deliberately.** If the server rejected
off-site events, an event queued offline at a bad moment would be refused
permanently and the shift would be lost. The server keeps recording every event
and raising the exception; the phone is what declines to send one.

### Tracking runs for the shift, and only the shift

While a worker is clocked on, SkelClock follows their position — foreground
watcher plus a background task — so the site map stays live and the fence check
is answered from a current position rather than a stale one. It starts on
clock-on and stops on clock-off, on sign-out, and on any other exit from the
clocked-on state; `apps/mobile/src/tracking.ts` owns that rule so no caller has
to remember it.

Those positions stay on the handset. There is no breadcrumb trail uploaded to
the office: only the single position taken at the moment of the press is sent,
which is what hours are matched to. A stored history of everywhere a worker
went is a much larger thing to hold than an attendance record, and would need a
schema decision and a retention policy rather than just pointing this task
somewhere new.

This is a materially different thing for a worker to agree to than the original
one-fix-per-press design, so it is stated plainly in three places that must
agree: the header of `location.ts`, the permission strings in `app.json`, and
the privacy section on the clock screen itself.

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
- Admin dashboard: Working Now, Timesheets, Exceptions, Sites, Odoo Sync, Settings
- Full audit trail on every attendance change

Phase 2 exists in the service layer and is covered by tests — breaks, job and
activity switching, crew clocking, approvals, exceptions — and supervisors
correct, void and add events from the web timesheet detail screen. **The
supervisor's mobile view is not yet built**; crew clocking works through the
service layer but has no phone screen.

Phase 3 (automatic geofence clocking) is built: the phone watches site
geofences in the background (with recorded worker consent), a walk-on raises
an `auto_geofence` event, and the server either auto-confirms it (single
site, inside the fence, GPS accuracy ≤ 30 m) or lands it as a suggestion the
worker taps to confirm — ambiguous multi-site triggers always ask, with a
site picker. Nothing auto-created silently becomes payroll otherwise.

On top of the brief: configurable payroll policy (auto lunch deduction,
travel allocation, company operating hours with per-site overrides, enforced
at clock-in) and per-employee site lockouts. See
[DEVELOPERS.md](DEVELOPERS.md) for how each works.

---

## Testing

```bash
npm test          # everything: 159 tests
npm run test:unit # domain logic only, no database, ~1s
```

The integration tests run against PGlite — real Postgres 17 compiled to WASM —
so the triggers, constraints and `for update skip locked` being asserted are
the same ones that will run on Supabase. No Docker needed.

Each block in `scripts/integration.test.ts` maps to one of the ten MVP
acceptance criteria in the brief.
