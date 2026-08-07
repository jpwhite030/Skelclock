# SkelClock — Developer Handbook

Everything a developer needs to know about what this system does, how it is
put together, and which rules must not be broken. The [README](README.md) is
the quick start; this is the full picture.

Last updated: 2026-08-07.

---

## 1. What this system is

Field attendance for SkelScaff (scaffolding). Workers clock on and off from a
phone — manually or automatically when they walk onto a site — the office
reviews, corrects and approves the resulting timesheets, and approved hours
are pushed into Odoo as `hr.attendance` records.

The system boundary is deliberate and small:

- **Odoo is the source of truth for employees and jobs.** They are imported,
  never created here. Everything imported carries its `odoo_id`.
- **SkelClock is the source of truth for attendance.** Clock events, breaks,
  segments, timesheets, approvals, corrections, exceptions — and nothing else.

Three surfaces:

| Surface | Where | Who |
| --- | --- | --- |
| Mobile app | `apps/mobile` (Expo / React Native) | Workers in the field |
| Web dashboard | `apps/web` (Next.js 15) | Office: supervisors and admins |
| Sync worker | `packages/server/src/sync.ts`, driven by `GET /api/sync` | A cron, every few minutes |

The web app also hosts the mobile app's API (`apps/web/src/app/api/*`) — there
is one deployed backend, not two.

---

## 2. Repository map

npm workspaces monorepo. The dependency direction is strict and one-way:

```
core  ←  contracts        (contracts imports types from core)
  ↑         ↑
  └── server ──── odoo    (server orchestrates; odoo talks JSON-RPC)
        ↑
      apps/web            (API routes + dashboard; the only DB owner at runtime)

core + contracts  →  apps/mobile   (the phone imports domain logic + wire schemas,
                                    never server code)
```

| Path | What lives there | Hard rule |
| --- | --- | --- |
| `packages/core` | Domain logic: clock state machine, geofence maths, segment builder, exception detection, idempotency keys, operating-hours window maths | **No I/O, no database, no imports beyond the standard library.** It runs identically on the phone and the server — that is the point of it. |
| `packages/contracts` | Zod schemas for every API request/response shared by web and mobile | Pure data shapes. See §3 — this is what keeps the two apps codependent. |
| `packages/server` | The service layer: ingest, timesheet rebuild, approvals, corrections, crew clocking, suggestions, settings, authz, sync queue, dashboard read models | Everything takes a `Db` handle as its first argument; nothing here opens its own connection. |
| `packages/odoo` | Everything that knows an Odoo field name: adapter interface, live JSON-RPC client, mock adapter, `mapping.ts`, attendance-block splitting | The rest of the codebase never mentions an Odoo model name. |
| `apps/web` | Next.js dashboard (server components + server actions) **and** the mobile API routes | Routes validate their responses against `@skelclock/contracts` before sending. |
| `apps/mobile` | Expo app: clock screen, offline SQLite queue, GPS capture, background geofencing | Imports `@skelclock/core` and `@skelclock/contracts` only — never `@skelclock/server`. |
| `supabase/migrations` | The schema. `0001`–`0006` are portable Postgres (run on PGlite and Supabase unchanged); `1001` is Supabase-only (RLS) | Files numbered **≥ 1000 are skipped by local tooling** — keep Supabase-specific SQL there. |
| `scripts` | `poc.ts` (7-step proof of concept), `integration.test.ts`, `local-db.ts` (PGlite bootstrap), `odoo-probe.ts`, `shots.ts` (screenshots) | |

---

## 3. How web and mobile stay in lockstep

The two apps are codependent by construction, not by discipline. Two
mechanisms:

**1. Shared wire contracts (`@skelclock/contracts`).** Every API payload has a
Zod schema. The web route handler `parse()`s its own response against the
schema before sending; the mobile `ApiClient` (`apps/mobile/src/api.ts`)
`parse()`s everything it receives against the *same* schema. A route that
drifts from its contract fails loudly on the server side in dev/tests and on
the very first fetch on the phone — it cannot silently misread a field on a
worker's phone in the field.

Changing an endpoint is therefore always the same three-step change, in one
commit:

1. Edit the schema in `packages/contracts/src/*`.
2. Fix the route in `apps/web/src/app/api/*` until it compiles and parses.
3. Fix the consumer in `apps/mobile/src/*` until it compiles.

TypeScript and Zod between them make it impossible to complete step 1 without
2 and 3.

**2. Shared domain logic (`@skelclock/core`).** The clock state machine, the
geofence evaluation, and the operating-hours window check run on *both* ends.
The phone runs them at press time so an offline worker gets the same answer
instantly ("you're already clocked in", "clock-on is only accepted between
06:00 and 18:00") that the server would give hours later at sync; the server
runs them again on ingest because the server is authoritative and a client is
never trusted. There is exactly one implementation of each rule.

---

## 4. Data model

Schema lives in `supabase/migrations/`, applied in filename order. Local
tooling (`scripts/local-db.ts`, `apps/web/src/lib/demo-db.ts`) applies
everything below 1000; Supabase gets all of them.

| Migration | Contents |
| --- | --- |
| `0001_core_schema.sql` | All core tables and enums (below) |
| `0002_integrity.sql` | The append-only triggers — see "Invariants" |
| `0003_defaults.sql` | Seeded defaults (work activities from the brief, etc.) |
| `0004_odoo_links.sql` | Odoo linkage columns |
| `0005_geofence_v2.sql` | `attendance_event.candidate_job_ids uuid[]`, `geofence_consent_event` |
| `0006_supervisor_settings.sql` | Payroll settings columns on `company` and `site`, `timesheet.total_auto_lunch_minutes`, `employee_site_exclusion` |
| `1001_supabase_rls.sql` | Supabase-only: `auth.users` linkage + row-level security policies |

### Tables, grouped

**Identity & org** — `company` (carries the timezone and, since 0006, the
payroll policy), `employee` (mastered in Odoo; `supervisor_employee_id` forms
the reporting tree), `app_user` (one row per login; `role` worker /
supervisor / admin; `auth_user_id` links to Supabase auth), `crew`,
`crew_member`.

**Work** — `site` (split from job because the geofence belongs to the place,
not the paperwork; `geofence_radius_m` defaults to **70 m**; since 0006 also
per-site `operating_hours_start/end`), `job` (mastered in Odoo; carries
`odoo_model` + `odoo_id` so the "which Odoo model is a job" question is a data
migration, not a schema change), `work_activity` (cost codes; `is_travel` and
`is_paid` flags drive the segment builder), `job_activity`, `assignment`.

**Attendance** — the heart:

- `attendance_event` — the **append-only spine of the whole system**. Every
  press of a button, every geofence trigger, every supervisor correction is a
  row here, forever. Carries both clocks (`device_time`, `server_time`), GPS
  (`latitude/longitude/gps_accuracy_m/inside_geofence/distance_from_site_m/outside_reason`),
  `clock_method` (`manual | auto_geofence | supervisor | admin`),
  `is_suggested` (a geofence event awaiting confirmation), `candidate_job_ids`
  (when a trigger landed inside more than one fence), `idempotency_key`
  (unique per company — the offline-retry guard), and the void/supersede
  fields (`voided_at/voided_by/void_reason/superseded_by`).
- `timesheet` — one per employee per day, `unique (employee_id, work_date)`.
  The unit of approval and of Odoo sync. Carries denormalised totals in
  integer minutes (`total_shift/break/paid/auto_lunch_minutes`) recomputed by
  the rebuild.
- `time_segment` — the day sliced into costable blocks (work / travel /
  break), derived from events. **Safe to delete and rebuild at any time**; the
  events are the permanent record. `break_period` is a view over it.
- `correction` — the audit record of every supervisor edit (original value,
  new value, reason, who, when). Written by `correctEvent` / `addMissingEvent`.
- `approval` — every rung of the ladder including reopens, append-only.
- `attendance_exception` — the office work queue; deduped per
  `(timesheet, type, event)` with `NULLS NOT DISTINCT` so re-running detection
  never piles up duplicates.

**Settings & access (0005/0006)** — `geofence_consent_event` (append-only:
`granted`/`revoked` + `policy_version`), `employee_site_exclusion`
(`unique (employee_id, site_id)`, reason required — the "lives next door to
the site" lockout).

**Integration & ops** — `odoo_sync_job` (the queue, both directions, with
attempts/backoff/`idempotency_key`), `audit_log` (generic before/after
trigger-fed log), `device` (per-device check-in: platform, app version, push
token, `location_permission` — feeds the permission-health banner).

### The two clocks

Every event stores `device_time` (what the phone believed at press) and
`server_time` (when we received it). After an offline day they differ by
hours. **Everything that matters — state machine ordering, segment building,
the Odoo push — uses `device_time`.** `server_time` is for audit and sync-lag
reporting only.

---

## 5. The clocking pipeline, end to end

```
press on phone ──► useClock (local state machine + operating-hours check)
                       │  refused? worker told instantly, nothing queued
                       ▼
                offline queue (SQLite; idempotency key minted HERE, at press)
                       │  flush when online
                       ▼
                POST /api/events  (batch; bearer token → requireCaller)
                       │
                       ▼
                ingestEvents (packages/server/src/ingest.ts)
                       │  per event: validate → write in a transaction
                       ▼
                rebuildTimesheet (segments → totals → exceptions)
```

### Ingest checks, in order

`ingestOne` runs these in a fixed order; the first failure wins. The order is
part of the design — cheap replays exit before any heavier lookups.

1. **Idempotency key well-formed** → else rejected `invalid_idempotency_key`.
2. **Device time parseable** → else rejected `invalid_device_time`.
3. **Replay check** — an event with this key already exists → `duplicate`
   (success, returns the existing event id; this is what makes retries safe).
4. **Employee exists and is active** → else `unknown_employee` /
   `inactive_employee`.
5. **State machine** (`applyTransition` over the prior 48 h of live events) →
   else the transition's own code: `already_clocked_in`, `not_clocked_in`,
   `already_on_break`, `not_on_break`, `job_change_requires_clock_in`.
6. **Auto-geofence debounce** — an `auto_geofence` event of the same type/job
   within `AUTO_GEOFENCE_DEBOUNCE_MS` (10 min) of an existing one folds into
   it as `duplicate`. GPS bouncing on a fence edge never creates a second row
   and never shows the worker an error.
7. **Job exists in this company** → else `unknown_job`.
8. **Site lockout** — `employee_site_exclusion` row exists for this employee
   and the job's site → rejected `site_excluded`. **Every clock method**, no
   override; removing the exclusion row is the only way back in.
9. **Geofence evaluation** (`evaluateGeofence`) — measures and records
   distance/inside-ness. **Never rejects.** A job with no coordinates yields
   `inside_geofence = null`, which is deliberately distinct from `false`.
10. **Operating hours** (`checkOperatingHours`) — only for `clock_in` with
    `clock_method` `manual` or `auto_geofence` → rejected
    `outside_operating_hours` if the local time falls outside the window.
    Clock-*out* is never gated (a worker must never be trapped clocked in);
    supervisor/admin methods bypass (a person deciding, not a sensor).
11. **Write**, inside a transaction: resolve/create the day's `timesheet` row,
    insert the event (a racing duplicate on the unique index degrades to
    `duplicate`), then `rebuildTimesheet`.

Outcome per event, returned in request order and validated against
`ingestResponseSchema`:

- `created` — with `autoConfirmed: boolean` (see §6) and the stored event.
- `duplicate` — replay or debounce fold; the phone dequeues silently.
- `rejected` — `code` + human `message`; the phone dequeues and shows the
  message. Transport failures (timeout, 5xx, 429) are the only thing that
  keeps an event queued for retry.

### Rebuild

`rebuildTimesheet` (`packages/server/src/timesheet.ts`) deletes the day's
segments and rebuilds from the live (non-voided, non-suggested) events via
`buildSegments` (`packages/core/src/segments.ts`), applies the payroll policy
(§7) via `payrollSegmentOptions`, writes totals onto the timesheet row, and
re-runs `detectExceptions`. It is called after every ingest, correction, void,
added event, and suggestion confirmation. Because segments are derived, this
is always safe.

### Exceptions

`detectExceptions` (`packages/core/src/exceptions.ts`) is deliberately
conservative — every false positive is a phone call to a scaffolder who did
nothing wrong. Severity 1 = look today, 2 = review at approval, 3 = FYI:

| Type | When | Sev |
| --- | --- | --- |
| `missing_clock_in` | Day starts with something other than a clock-in | 1 |
| `missing_clock_out` | Shift still open **and** the day is over (never mid-shift) | 1 |
| `overlapping_shift` | Time claimed on two jobs at once (checked across neighbouring days) | 1 |
| `outside_geofence` | Outside the fence, **no reason given**, and GPS error bars don't reach the fence | 2 |
| `very_long_shift` | Over `LONG_SHIFT_HOURS` (default 14) | 2 |
| `unassigned_job` | Clock-in with no job — hours can't be costed | 2 |
| `offline_event` | Once per day, informational: times came from the device clock | 3 |
| `odoo_sync_failure` | Raised by the sync worker on a dead push | — |
| `stale_suggestion` | Synthetic, never stored: computed live by `listStaleSuggestions` for geofence suggestions unactioned > 24 h | — |

---

## 6. Automatic geofence clocking

The design rule: **tap-to-confirm is the fallback, not the norm** — but
nothing auto-created becomes payroll unless the evidence is good, and the
server is the judge.

### Consent first

Auto-detect is opt-in per worker. The first toggle shows a plain-language
notice (what is monitored, that location is only recorded at clock events);
agreeing POSTs to `/api/geofence-consent`, which appends a
`geofence_consent_event` row with
`GEOFENCE_CONSENT_POLICY_VERSION` (`packages/contracts/src/consent.ts`,
currently `2026-08-07`). Turning it off records `revoked`. If the policy text
ever changes, bump the version — workers re-consent.

### On the phone (`apps/mobile/src/geofence.ts`)

- Registered via `expo-location` `startGeofencingAsync` + a `TaskManager`
  headless task, so it runs **with the app closed**. The task module is loaded
  by a side-effect import in `apps/mobile/app/_layout.tsx` — do not remove it.
- iOS caps monitored regions at 20. We watch at most `MAX_WATCHED_SITES = 20`
  (nearest first) and surface a "watching 20 of N sites" note when truncated.
- On a region trigger the task takes a fresh GPS fix and re-evaluates it with
  `evaluateGeofence` against **all** watched sites — the OS callback alone is
  not trusted, and this is how overlapping fences produce a candidate list.
- A client-side debounce (AsyncStorage, mirroring the server's 10 min)
  suppresses fence-edge retriggers before they even queue.
- The event is queued like any manual event, with
  `clockMethod: 'auto_geofence'` and `candidateJobIds` when ambiguous, then
  flushed. Nothing is ever written locally as "clocked in" — the server
  decides.
- The local notification copy follows the flush result: "You're clocked in"
  when the server auto-confirmed, "Open SkelClock to confirm" when it landed
  as a suggestion, "near N job sites" when ambiguous.

### On the server

Every `auto_geofence` event lands as a **suggestion** (`is_suggested = true`)
*unless* `shouldAutoConfirmGeofence` (`packages/core/src/geo.ts`) passes —
all three of:

1. exactly **one** candidate site (ambiguity always forces a tap),
2. the fix is **inside** the fence (`true`, not `null`),
3. GPS accuracy is reported and ≤ `AUTO_CONFIRM_MAX_ACCURACY_M` (30 m — the
   tuning knob lives in that file).

Suggested events are excluded from the state machine and from segments until
the worker acts:

- `GET /api/events/suggested` — pending list for the clock screen.
- `POST /api/events/:id/confirm` — accepts an optional `jobId`, required to
  disambiguate a multi-site suggestion (must be one of the stored
  `candidate_job_ids`, else `invalid_candidate_job`). Confirming clears
  `is_suggested`, sets the job, rebuilds the day.
- `POST /api/events/:id/reject` — dismisses with a reason.
- Suggestions unactioned for 24 h surface to the office as `stale_suggestion`
  on the Exceptions screen.

### Permission health

The app checks in via `POST /api/device` (platform, app version, push token,
current location permission). `checkPermissionHealth` classifies
`ok | needs_attention | disabled`; a revoked "Always allow" shows a
tap-to-fix banner on the clock screen instead of silently never triggering
again.

---

## 7. Payroll policy (Settings)

All policy lives on the `company` row, edited by admins on the **Settings**
screen (SHT 06), with per-site overrides where noted. Applied centrally by
`payrollSegmentOptions` (`packages/server/src/settings.ts`) so the rebuild,
the worker home payload and the Working Now board all agree.

**Auto lunch** (`auto_lunch_enabled`, default **off**;
`auto_lunch_threshold_minutes`, default 300; `auto_lunch_duration_minutes`,
default 30). If a worker clocked **no break at all** and the shift is at least
the threshold, the duration is deducted from paid time (capped at the paid
total). Mutually exclusive with real breaks by construction — a day with any
clocked break is never touched. Stored per day in
`timesheet.total_auto_lunch_minutes` and always visible where it applies: the
worker's home screen ("· 30m lunch auto-deducted"), the Timesheets ledger
Break column ("30m auto"), the timesheet detail totals strip. A worker's pay
never shrinks silently.

**Travel allocation** (`travel_allocation`:
`unallocated | first_site | second_site`, default `unallocated`). Travel
segments (from activities flagged `is_travel`) have no job; `allocateTravel`
(`packages/core/src/segments.ts`) is a post-pass that assigns each travel
segment the job of the preceding (`first_site`) or following (`second_site`)
work segment, so between-site travel costs to the site the company chooses.

**Operating hours** (`operating_hours_start/end` on `company`, overridable
per-field on `site`; empty = no restriction). Refusal semantics, not a flag:
a worker clock-in (manual or auto-geofence) outside the window is **rejected**
(§5 step 10). Start-inclusive, end-exclusive, string-compared as local time;
an overnight window (`start > end`, e.g. 18:00–06:00) wraps correctly.
Timezone conversion is done by Postgres
(`($ts::timestamptz at time zone company.timezone)::time`) so DST is tzdata's
problem, not ours. The phone mirrors the check
(`packages/core/src/operating-hours.ts`) using the resolved window delivered
in the `/api/jobs` payload — so an **offline** 4 a.m. clock-on is refused at
press time instead of queueing all day and dying at sync (which would have
taken the clock-out down with it).

**Site lockouts** (`employee_site_exclusion`). Hard block, all clock methods,
reason required, managed from the Sites screen (admins, and supervisors for
their own reports). Excluded sites' jobs are also filtered out of that
worker's `/api/jobs` list, so the job never even appears on their phone.

---

## 8. Roles and authorization

Three roles on `app_user`: `worker`, `supervisor`, `admin`. ("Manager" is not
a tier — managers are admins.)

**Two auth paths:**

- **Mobile API routes** — Supabase phone-OTP login
  (`apps/mobile/app/login.tsx`); every request carries the access token;
  `requireCaller` (`apps/web/src/lib/auth.ts`) resolves it to an `app_user`
  row. The JWT establishes *who*, never *what they may do* — role always
  comes from the database row.
- **Dashboard pages** — server components read the Supabase session from
  cookies (`getDashboardSession`, `apps/web/src/lib/session.ts`). With no
  Supabase configured (local dev) it falls back to an admin view of the single
  seeded company, flagged by a visible warning banner; the fallback is
  **refused when `NODE_ENV=production`**.

**Scope** (`packages/server/src/authz.ts`):

- `supervises(a, b)` — true if b is in a's reporting tree (recursive over
  `employee.supervisor_employee_id`) **or** a leads a crew b belongs to.
- `canManageEmployee` — admin: anyone in the company; supervisor: their
  reports only, **never themselves** (no self-approval, no editing your own
  hours); worker: no one.

These checks live in application code deliberately: the dashboard and API
connect via `DATABASE_URL`, which bypasses RLS entirely. The RLS policies in
`1001_supabase_rls.sql` are defense in depth for any future Supabase-client
access path, not the primary guard. **Never rely on RLS from `apps/web`.**

| Capability | Worker | Supervisor | Admin |
| --- | --- | --- | --- |
| Clock self, confirm own timesheet | ✔ | ✔ | ✔ |
| See dashboards | — | ✔ | ✔ |
| Correct / void / add events | — | own reports | anyone |
| Approve timesheets | — | own reports | anyone |
| Crew clock-in/out (service layer) | — | ✔ | ✔ |
| Site hours & exclusions | — | own reports | ✔ |
| Company payroll settings (SHT 06) | — | — | ✔ |
| Retry Odoo sync, reopen locked | — | — | ✔ |

---

## 9. Timesheets: rebuild, approvals, corrections

**Approval ladder** (`packages/server/src/approval.ts`):
`draft → worker_confirmed → supervisor_approved → synced → locked`, plus
`reject` (back to draft) and `reopen` (which requires a reason — the brief is
explicit). Every transition appends an `approval` row. Enum order matters;
code compares ordinality.

**Corrections** never touch history:

- `correctEvent` — voids the original (reason required) and inserts a
  replacement linked via `superseded_by`, in one transaction, plus a
  `correction` audit row.
- `voidEvent` — void without replacement (an event that should never have
  existed).
- `addMissingEvent` — inserts what the worker forgot (e.g. the missing
  clock-out), `clock_method: 'supervisor'`/`'admin'`.

All three refuse on a `locked` timesheet, are gated by `canManageEmployee`
(the server action re-derives the employee from the DB row — it never trusts
a form field), and end with a rebuild.

**Web UI**: Timesheets ledger (SHT 02) → click a date → detail (SHT 02a) with
the day's totals strip, the live event list, inline correct/remove forms and
an add-event form.

---

## 10. Odoo integration

- **Adapter interface** (`packages/odoo/src/adapter.ts`) with two
  implementations: `mock-adapter.ts` (fixtures; the default) and
  `odoo-adapter.ts` over the JSON-RPC `client.ts`. `ODOO_MODE=live` switches.
- **`mapping.ts` is the one file that changes** when the open Odoo questions
  are answered (which model is a job, where site coordinates live — see
  `GEO_NOTE` there). Run `ODOO_MODE=live npm run odoo:probe` (read-only) and
  paste the output to settle them.
- **Breaks split the day**: `hr.attendance` computes `worked_hours` from
  `check_out − check_in`, so one record spanning the day would overpay by
  every unpaid break. `attendance-blocks.ts` emits one attendance block per
  paid stretch, and Odoo's own total equals our paid minutes with no
  reconciliation step.
- **Timezones**: Odoo stores naive UTC strings and silently misreads offsets.
  All conversion goes through `toOdooDatetime` — tested for AEST/AEDT/UTC.
  Getting this wrong shifts every shift by 10–11 hours.
- **The queue** (`odoo_sync_job`): approval enqueues a push
  (`enqueueTimesheetPush`); `runSyncWorker` claims due jobs with
  `for update skip locked` (safe under concurrent crons), retries with
  backoff up to `max_attempts` (8), then marks `dead` and raises an
  `odoo_sync_failure` exception. The dashboard's Sync screen shows the queue
  and has a retry action.
- **Duplicate guard #3**: before creating, the adapter searches
  `hr.attendance` by employee + check-in — a push retried after a lost
  response updates rather than doubles, even if the local record of the Odoo
  id was lost.
- **Trigger**: `GET /api/sync` with the `CRON_SECRET` bearer token; point a
  cron at it every few minutes.

---

## 11. The web dashboard

Design language: a drawing-office "sheet" motif — a fixed rail of numbered
sheets (SHT 01–06), dark surfaces for glanceable/live screens, and **exactly
one light "paper" surface** (the Timesheets ledger, the longest sustained
read). If a second paper surface ever appears, the distinction stops meaning
anything. The Sites map uses Esri World Imagery satellite tiles (no API key)
with a slight brightness filter.

| Sheet | Route | What it does |
| --- | --- | --- |
| 01 Working now | `/` | Live board: who is on which job right now, state, shift length, plus "rostered, not on" from assignments. |
| 02 Timesheets | `/timesheets` | The pay-period ledger, grouped **by employee** (payroll reconciles per person). Filters: period, employee, crew, job, status. Break column shows "Xm auto" when auto-lunch applied. Date links to the detail. |
| 02a Correction | `/timesheets/[id]` | Totals strip (Shift / Break / Auto lunch / Paid + status mark), event list, inline correct/remove, add-missing-event. Access-gated by `canManageEmployee`. |
| 03 Exceptions | `/exceptions` | The office work queue, including stale geofence suggestions. |
| 04 Sites | `/sites` | Satellite map of sites and last clock positions; per-site operating-hours override editor; site-exclusion (lockout) panel. |
| 05 Odoo sync | `/sync` | Queue state, failures, retry. |
| 06 Settings | `/settings` | Admin-only payroll policy: auto lunch, travel allocation, company operating hours. |

Server components read via `packages/server` query functions
(`getWorkingNow`, `listTimesheets`, `getTimesheetDetail`, `listExceptions`,
`listSyncJobs`, …); mutations are server actions co-located per screen
(`server-actions.ts`), each re-checking authz.

---

## 12. The mobile app

Flow: phone-number OTP login → the clock screen (`app/index.tsx`). Buttons
offered come from `allowedEvents(state)` — you physically cannot press an
illegal transition. Everything works offline; a banner shows queued-event
count and the last sync.

| File | Role |
| --- | --- |
| `app/_layout.tsx` | Session routing + the side-effect `import '../src/geofence'` that registers the headless task |
| `app/login.tsx` | Phone + OTP, nothing to remember |
| `app/index.tsx` | Clock screen: state, buttons, job/activity pickers, suggestion cards, auto-detect toggle + consent, permission banner, auto-lunch note |
| `src/useClock.ts` | The screen's brain: state derivation, press handling (local state-machine + operating-hours refusal before anything queues), flush orchestration, suggestions |
| `src/queue.ts` | Offline queue core, storage-agnostic; `FlushResult` reports created/duplicate/rejected per event |
| `src/sqlite-store.ts` | expo-sqlite persistence for the queue |
| `src/api.ts` | `ApiClient` — the `Transport`; bearer auth, 15 s timeout, contract-validated responses, retryable-vs-fatal error split |
| `src/geofence.ts` | Region monitoring, headless trigger handling, candidates, debounce, notifications, permission health |
| `src/location.ts` | Foreground GPS capture at press time |
| `src/device.ts` / `src/supabase.ts` / `src/theme.ts` | Device identity, auth client, design tokens |

Needs a **development build** (`npx expo prebuild && npx expo run:android`) —
not Expo Go — because of native location, task-manager and SQLite modules.
Point it at the backend with `EXPO_PUBLIC_API_URL` (defaults to
`http://localhost:3000`).

---

## 13. API surface

All under `apps/web/src/app/api/`. Every route authenticates with
`requireCaller` (bearer token) unless noted, and validates its response
against the named contract in `packages/contracts/src/`.

| Route | Method | Purpose | Contract |
| --- | --- | --- | --- |
| `/api/events` | POST | Batch ingest from the offline queue | `ingestResponseSchema` |
| `/api/home?date=` | GET | Worker home: state, today's totals, auto-lunch minutes, timesheet to confirm | `workerHomeSchema` |
| `/api/jobs` | GET | Jobs for this worker — excluded sites filtered out; resolved operating hours + geofence per job | `jobsResponseSchema` |
| `/api/activities` | GET | Active work activities | `activitiesResponseSchema` |
| `/api/events/suggested` | GET | Pending geofence suggestions | `pendingSuggestionsResponseSchema` |
| `/api/events/[id]/confirm` | POST | Confirm a suggestion (optional `jobId` for ambiguity) | `suggestionActionResponseSchema` |
| `/api/events/[id]/reject` | POST | Dismiss a suggestion with a reason | `suggestionActionResponseSchema` |
| `/api/timesheets/[id]` | POST | `{action:'confirm'}` — worker confirms their day | `timesheetActionResponseSchema` |
| `/api/device` | POST | Device check-in (permission health, push token) | `deviceCheckinResponseSchema` |
| `/api/geofence-consent` | POST | Append a consent grant/revoke | `geofenceConsentResponseSchema` |
| `/api/sync` | GET | Run the Odoo sync worker — `CRON_SECRET` bearer, not a user token | — |

---

## 14. Local development

```bash
npm install
npm test                          # full suite (currently 159 tests)
npm run poc                       # the 7-step proof of concept, end to end
cd apps/web && npx next dev -p 3100   # dashboard at http://localhost:3100
npm run shots                     # screenshot every screen into .shots/current
npm run typecheck
```

**No credentials needed for any of that.** With no `DATABASE_URL`, the web
app boots an in-process Postgres (PGlite — real Postgres 17 compiled to
WASM), applies migrations `0001`–`0006`, and seeds a working day at SkelScaff
**through the real service layer** (`ingestEvents`, `rebuildTimesheet`,
`approveTimesheet`, `runSyncWorker`) — nothing on screen is data the system
could not actually have produced. The demo DB is rebuilt on each dev-server
boot. In production a missing `DATABASE_URL` is a hard error; the demo path
cannot be reached there. The demo dashboard session is the dev fallback
(admin) described in §8.

Demo defaults keep the new policy features quiet until you turn them on:
auto lunch off, no operating hours set, no exclusions. Flip them on the
Settings and Sites screens to see the behaviour.

### Environment variables

`.env.example` documents the Supabase/Odoo/app set. The full list:

| Var | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `apps/web/src/lib/db.ts` | Postgres. Absent → in-process demo DB (dev only) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | auth | Absent locally → dashboard dev fallback; mobile login needs them |
| `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`, `ODOO_JOB_MODEL`, `ODOO_ACTIVITY_MODEL`, `ODOO_MODE` | `packages/odoo` | `ODOO_MODE=mock` (default) runs against fixtures |
| `APP_TIMEZONE` | seed/scripts | Company timezone default (`Australia/Sydney`) |
| `LONG_SHIFT_HOURS` | exception detection | Default 14 |
| `DEFAULT_GEOFENCE_RADIUS_M` | ingest, jobs API | Default 70 |
| `CRON_SECRET` | `/api/sync` | Bearer token for the cron |
| `EXPO_PUBLIC_API_URL` | mobile | Backend base URL |

---

## 15. Tests

```bash
npm test          # everything
npm run test:unit # domain logic only, no database, ~1s
```

Four files, run with the built-in Node test runner via `tsx`:

- `packages/core/src/core.test.ts` — state machine, geofence maths,
  auto-confirm rules, segments, travel allocation, auto-lunch,
  operating-hours window maths, idempotency.
- `packages/odoo/src/odoo.test.ts` — mapping, attendance-block splitting,
  `toOdooDatetime` across AEST/AEDT/UTC.
- `apps/mobile/src/queue.test.ts` — queue semantics against a fake transport.
- `scripts/integration.test.ts` — the big one, against **PGlite**, so the
  triggers, constraints and `for update skip locked` being asserted are the
  same ones Supabase will run. Covers the ten MVP acceptance criteria plus:
  auto-confirm and ambiguity, server debounce, operating-hours
  refusal/bypass/overnight/site-override, site exclusions across all clock
  methods, supervisor authz, void/correct/add, auto-lunch through
  `getWorkerHome`.

A note for test authors: the high-accuracy default fixtures auto-confirm.
When a test needs the *suggestion* path, give the event `gpsAccuracyM` > 30 —
existing Phase-3 tests use 45–60 deliberately.

---

## 16. Invariants — read before changing anything

1. **Attendance is append-only, and the database enforces it.** Triggers in
   `0002_integrity.sql` reject in-place edits of times/positions, reject
   deletes, reject voids without a reason, reject un-voiding. Corrections are
   void + supersede. Do not work around the triggers; they are the guarantee
   payroll rests on.
2. **`device_time` is the payroll clock.** Order, measure and push on it.
3. **Idempotency keys are minted at press time, on the phone**, and replayed
   verbatim on retry. Three independent duplicate guards exist (key, state
   machine, Odoo search-before-create) — all three stay.
4. **GPS never blocks a worker.** Outside the fence asks for a reason and
   raises an exception; it does not refuse. The only hard refusals are the
   two deliberate, human-configured ones: site exclusion and operating hours
   — and operating hours never gates a clock-out.
5. **The server decides what counts.** Auto-geofence events become payroll
   only via the server's auto-confirm rule or the worker's explicit
   confirmation. A client never grants itself a confirmed clock.
6. **Contracts are validated on both ends.** Never ship a route change
   without its schema; never bypass `schema.parse` "just this once".
7. **Role checks live in app code** (`canManageEmployee`), because the web
   tier bypasses RLS. A supervisor never manages themselves.
8. **`packages/core` stays pure** — no I/O ever. It must keep running
   unmodified on the phone.
9. **Segments and totals are derived, events are truth.** Anything wrong on a
   timesheet is fixed by fixing events and rebuilding, never by editing
   totals.
10. **One paper surface** in the dashboard (Timesheets). Keep new screens on
    the dark ground and reuse the existing idioms (`.sht`, `.mk` marks,
    `.setout-counts`, `.spec`).

---

## 17. Current status and known gaps

**Done and tested**: Phase 1 (manual clocking, offline queue, approval
ladder, Odoo push, dashboard) · Phase 2 service layer (breaks, job/activity
switching, crew clocking, corrections, approvals, exceptions) with worker
screens · Phase 3 (background geofence clocking with consent, auto-confirm,
ambiguity, debounce, permission health) · payroll policy (auto lunch, travel
allocation, operating hours with site overrides, site lockouts) · supervisor
corrections UI on the web.

**Known gaps** (in rough priority order):

- **Supervisor mobile view.** Crew clock-on/off and approvals exist in the
  service layer (`clockCrew`, `moveCrewToJob`, approvals) and are tested, but
  there is no phone screen or API route for them yet — supervisors use the
  web.
- **Office login.** The dashboard reads a Supabase cookie session if present,
  but there is no office sign-in screen/middleware yet; local dev uses the
  admin fallback. Must be wired before production.
- **Geofence task doesn't pre-check operating hours.** An out-of-hours
  background trigger is correctly refused by the server, but the worker just
  sees no clock-in — no notification explains why.
- **Odoo mapping unconfirmed.** `mapping.ts` runs on assumptions until
  `npm run odoo:probe` output from the real instance settles the job model
  and site-coordinate questions.
- **Push notifications.** `device.push_token` is captured; nothing sends yet
  (all current notifications are local, from the geofence task).
- **Assignments/rostering** is minimally used (the "rostered, not on" board
  reads it; nothing writes it except seeds — Odoo `planning.slot` import is
  future work).
