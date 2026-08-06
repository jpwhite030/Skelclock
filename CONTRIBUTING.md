# Working on SkelClock

Nobody pushes straight to `main`. You work on your own branch, open a pull
request, and it goes into `main` once it is reviewed and CI is green.

That is not bureaucracy — it is what stops two people editing the same files
from stepping on each other, and it means `main` is always a version that
actually runs.

---

## Setting up

```bash
git clone https://github.com/jpwhite030/Skelclock.git
cd Skelclock
npm install

npm test          # 119 tests — should all pass before you change anything
npm run poc       # the end-to-end proof of concept
```

You do not need Docker, a database, or Odoo credentials. Tests run against an
in-process Postgres and a mock Odoo.

To see the dashboard:

```bash
cd apps/web && npx next dev -p 3100
```

Then open http://localhost:3100. It seeds itself with a day's worth of demo
data on first load.

---

## The loop

**1. Start from an up-to-date `main`.**

```bash
git checkout main
git pull
```

**2. Make a branch. Name it after what you are doing.**

```bash
git checkout -b matt/supervisor-dashboard
```

The `matt/` prefix keeps everyone's work visibly separate in the branch list.
Use `jack/` if you are Jack. One branch per piece of work — not one branch that
lives forever and collects everything.

**3. Do the work. Commit as you go.**

```bash
git add -A
git commit -m "Add supervisor crew list"
```

**4. Push your branch.**

```bash
git push -u origin matt/supervisor-dashboard
```

This is safe. Your branch is yours; pushing it changes nothing in `main`.

**5. Open a pull request.**

```bash
gh pr create --fill
```

Or use the "Compare & pull request" button GitHub shows on the repo page.

**6. Wait for the checks.**

CI runs the tests, the typecheck, the proof of concept and the dashboard build.
Green means it is safe to look at. Red means fix it first — the run log says
which step failed.

**7. Jack reviews and merges.**

Once merged, delete the branch and start the next one from a fresh `main`.

---

## Keeping out of each other's way

Branches stop you overwriting each other. They do not stop *merge conflicts* —
those happen when two branches change the same lines of the same file.

Two things that avoid most of it:

- **Split by area.** If one of you is on `apps/mobile` and the other is on
  `apps/web`, you will almost never collide.
- **Pull `main` into your branch often**, especially before opening the pull
  request. Small conflicts sorted daily beat one large one at the end:

  ```bash
  git checkout main && git pull
  git checkout matt/supervisor-dashboard
  git merge main
  ```

If you do hit a conflict and are not sure, stop and ask rather than guessing.
Nothing is lost — the work is all still there.

---

## Before you open a pull request

```bash
npm test
npm run typecheck
npm run poc
```

All three should pass. If you changed how attendance is recorded, corrected or
synced, add a test for it — those are the paths where a bug costs somebody
their pay, and where "it looked right when I tried it" is not enough.

---

## Things that need a conversation first

Not off limits, just worth a message before you spend a day on them:

| Area | Why |
| --- | --- |
| `supabase/migrations/` | Changes the database shape. Hard to undo once real attendance is in it. |
| `packages/odoo/` | Writes into the system payroll actually runs from. |
| `packages/server/src/sync.ts` | A bug here means a shift silently never reaches payroll. |
| `packages/server/src/approval.ts` | Controls what counts as approved hours. |
| The append-only triggers in `0002_integrity.sql` | They are the audit guarantee. Loosening them defeats the point of the system. |

---

## Never commit

- `.env` — it is gitignored, keep it that way. **The repo is public.**
- Odoo credentials, Supabase service-role keys, API keys of any kind.
- `node_modules/`, `.next/` — also gitignored.

If a credential does get committed, say so immediately. It has to be rotated,
not just deleted — the history keeps it.

---

## Where things live

```
packages/core      Pure logic, no database. Clock state machine, geofence
                   maths, hours calculation. Runs on the phone and the server.
packages/odoo      Everything that knows an Odoo field name.
packages/server    Ingest, timesheets, approvals, the sync queue.
apps/mobile        The Expo app workers use.
apps/web           The office dashboard, and the API the phone talks to.
supabase/          The database schema.
```

`README.md` explains the design decisions worth knowing before changing any of
it — particularly why duplicate attendance is prevented three separate ways,
and why attendance rows can never be edited or deleted.
