# Labor Allocation Prototype

A functional prototype for internal weekly labor allocation: an admin enters
each technician's actual per-day UKG hours (from that week's UKG timesheet
screenshot), which prompts the technician to split those hours across
location-based general time (E&F), specific WOM projects, and time off, then
submit for approval. Admin reviews, approves/rejects, and locks completed
weeks, with everything — screenshots, WOM allocation history, budget
drawdown — kept on file.

This is a prototype, not a production system: mock login data (short PINs
instead of real passwords) and no HTTPS by default. Login itself is real,
though — PINs are hashed at rest, sessions are real random tokens, and
brute-force login attempts get rate-limited. See "Where this stands" below
for what that means in practice.

## Stack

- **Backend:** Node.js + Express, plain JS. Data lives in a real embedded
  SQLite database (`server/data/store.sqlite`, via Node's built-in
  `node:sqlite` — no external DB server, no native module to compile).
  Uploaded files are stored on local disk under `server/data/uploads/`,
  referenced by a `files` table.
- **Frontend:** Vanilla JS (native ES modules, no build step) + plain CSS,
  served as static files by Express.
- No cloud services of any kind are involved — the whole thing runs on one
  machine with two local files/folders as its only state.

## Running it

```
npm install
npm start
```

Then open http://localhost:3000

To run the automated test suite (Node's built-in test runner, no extra
dependency):

```
npm test
```

The suite boots the Express app on an ephemeral port with a throwaway
SQLite database and uploads folder per test file (`tests/helpers.js`), so
it never touches your real `server/data/store.sqlite`. It covers login,
allocation validation (hours mismatch, closed/unknown WOM rejection,
per-tech authorization, admin-on-behalf-of), week locking, admin
approve/reject/unlock, WOM status management, technician creation and
employment status, onboarding/devices/allocation history, file
upload/download/delete authorization, and audit log writes/read-access.
The Reg/OT receipt calculation is client-side only and isn't covered by
this suite — verified manually (see "Where this stands").

Demo logins:

| ID    | PIN  | Role       |
|-------|------|------------|
| T1001 | 1234 | Technician |
| T1002 | 1234 | Technician |
| T1003 | 2345 | Technician |
| ADMIN | 9999 | Admin      |

## Features

- Technician login (mock ID + PIN)
- **Admin enters UKG hours per day, per technician** (Weekly Review → a
  technician's Details) — this is the actual source-of-truth input, not mock
  data; it's what the tech's target is checked against
- **Split allocation per day**, matching how the hours actually get worked:
  - **E&F** — general (non-project) time at a location
  - **WOM Project** — a specific job; picking a location filters which WOMs
    are selectable, and each shows remaining budget hours (e.g. "104h left
    of 120h"), computed live from everyone's allocations against it
  - **Time off** — vacation/sick/bereavement/holiday, counts toward the
    day's target like any other split
  - **"Default to home"** one-click button fills a day's remaining
    unallocated hours as E&F time at the technician's home location
- Submission blocked until **every day's** allocated hours exactly equal
  that day's UKG hours (not just the weekly total)
- A technician can mark a WOM project complete from their own allocation
  screen; an admin can open/close/reopen any WOM
- **Bulk UKG entry**: paste 7 space/comma-separated numbers (Mon→Sun) to
  fill a week's hours in one go instead of typing each day
- Admin review screen: approve, reject (with note, returns to technician), or
  unlock an approved week for correction; UKG screenshots/receipts for that
  week are visible right there, not just on the technician's own screen
- **Team Roster** (admin's Technicians tab): filterable by location/status,
  showing name, UKG ID, position, and home location. Clicking a row opens a
  tabbed **employee profile**:
  - Basic Info (editable email/phone/UKG ID/position/home location/**employment status**: active/inactive/terminated/retired)
  - Labor Allocation History — every WOM/E&F/time-off row ever allocated to
    that technician, across all weeks, so you can see what's been worked on
  - Onboarding — a fixed 5-item checklist per technician (not yet an
    admin-editable template — see "Where this stands")
  - Devices — a simple assigned-device list (not a request/approval workflow)
  - Forms on File / Documents — file attachments, same mechanism as WOM docs
- **Add technician**: a form on the roster (ID, name, PIN, position,
  home location, contact info) creates a new technician who can log in
  immediately
- **Admin can allocate on a technician's behalf** (new "Tech Allocation"
  tab): the exact same day-by-day splitting screen a technician sees, with
  an employee switcher (dropdown + Prev/Next) to move through the roster —
  for when someone's on vacation or otherwise can't do it themselves
- **Weekly Reg/OT receipt**: live-updating breakdown (Week Total, Regular,
  Overtime, OT on WOM, Time Off, plus a per-bucket Reg/OT/Total table) shown
  under the day cards. Hours beyond 40/week are OT; WOM hours are charged to
  OT before E&F hours; time off is always straight time and excluded from
  the 40-hour threshold entirely (see "Where this stands" for a documented
  simplification in this calculation)
- Week locking: a submitted/approved week can't be edited by the technician
  until an admin rejects or unlocks it
- Audit trail of logins, allocation saves, submissions, approvals,
  rejections, unlocks, WOM status changes, home-location/employment-status
  changes, technician creation, UKG hour entries, and file uploads/deletes
- Every save/edit action shows a real error if it fails, rather than
  silently appearing to succeed (a bug class found and fixed across the
  onboarding checklist, device list, home-location field, WOM status
  toggle, approve/reject/unlock, and file delete)
- File attachments, stored in a real database + disk folder rather than a
  mock:
  - UKG timesheet screenshots and receipts/invoices — attached by a
    technician to their own week (Attachments panel on the week screen)
  - Work order documents/photos — attached by any technician or admin to a
    WOM (Documents panel on admin's WOM Status tab)
  - Technician forms/certifications — admin-managed, attached to a
    technician's record (admin's Technicians tab)
- Mobile-friendly responsive layout

## Data model

Mock seed data lives in `server/data/seed.js` and is loaded into
`server/data/store.sqlite` the first time it's created (an empty
`technicians` table is the signal to seed). Subsequent runs read/write that
one file, so state persists across restarts — delete
`server/data/store.sqlite` (and `server/data/uploads/` if you want uploaded
files gone too) to reset to the seed.

Locations are a first-class table: WOMs belong to a location (and
optionally a total budget hours), technicians have a home location, and an
allocation "split" row is either `ef` (general time, tied to a location),
`wom` (tied to a specific WOM, which is itself tied to a location), or
`timeoff` (vacation/sick/bereavement/holiday, no location). UKG hours are
stored per technician/week/day, not one weekly lump — that's what makes the
per-day balance check possible. `server/data/db.js` auto-detects and rebuilds
these tables from the older flat schema if it finds one (safe at this stage
since only mock data has ever been in them).

## Where this stands

- **Storage is real, deployment isn't.** The database and file storage are
  no longer mock — they're the same engine and pattern you'd keep going
  forward. What's still missing for real use by your team is *reachability*:
  right now this only runs on whatever machine starts it, reachable at
  `localhost:3000` on that machine only.
- **Deployed on a $6/mo DigitalOcean droplet**, running as a systemd service
  (auto-restarts on crash or reboot) behind a basic firewall (only SSH + port
  80 open). See `scripts/deploy.sh`.
- **Auth is real but the transport isn't encrypted yet.** Login issues a
  genuine random session token (`server/data/db.js`'s `sessions` table); PINs
  are hashed with scrypt, never stored or compared in plain text
  (`server/utils/password.js`); repeated wrong-PIN attempts lock out for 15
  minutes (`server/routes/auth.js`). What's still missing: the site is served
  over plain HTTP, so credentials and data travel unencrypted over the
  network. Real HTTPS needs a domain name pointed at the droplet's IP (a
  bare IP can't get a trusted certificate) — a separate decision still ahead.
- **PINs are still short (4 digits).** Hashing protects them if the database
  ever leaked; it doesn't make a 4-digit PIN itself less guessable. The
  rate-limit is what actually prevents brute-forcing it online. Worth moving
  to longer PINs or real passwords before this holds anything sensitive.
- **Onboarding is a fixed checklist, not a template.** The 5 tasks are
  hardcoded in `server/data/db.js` (`ONBOARDING_TASKS`); there's no UI yet
  to add/remove/reorder tasks. Fine for a stable process, a real limitation
  if the checklist needs to change often.
- **Devices is a list, not a workflow.** It records "this device is
  assigned to this person" — no request/approval step, no due-back date,
  no device inventory shared across technicians.
- **The OT calculation is a weekly aggregate, not day-by-day.** Hours over
  40/week are OT, computed from the week's totals. The description this was
  built from said OT applies "on the day the threshold is crossed," which
  implies a chronological, day-sequential calculation (e.g. Monday's hours
  count before Friday's) — that's not what's implemented. If OT ever needs
  to land on a specific day rather than being a week-level total, this needs
  revisiting.
- **OT split across multiple WOMs is proportional, not prioritized.** The
  rule "WOM before E&F" is implemented exactly. What's *not* specified
  anywhere is which WOM if a technician worked OT hours across more than
  one — this splits the OT proportionally by each WOM's share of the
  week's WOM hours. If there's a real priority order (e.g. last-worked WOM
  first), the calculation in `techWeek.js`'s `computeReceipt` needs that
  rule instead.
- **The receipt isn't persisted.** It's computed live in the browser from
  that week's allocations every time the page renders — nothing is saved
  to the database when a week is submitted/approved. If you need to look up
  a specific week's exact Reg/OT numbers later without recomputing (e.g.
  for JDE export), that needs a stored snapshot, not just a live calc.

## Folder structure

```
server/
  app.js                Express app + route wiring (exported for tests)
  index.js              Entry point: creates the app and listens
  data/
    seed.js             Mock seed data (technicians, WOMs, UKG hours, sample weeks)
    db.js               SQLite schema, seeding, and all data accessors
    store.sqlite         (generated) the actual database file — gitignored
    uploads/              (generated) uploaded file contents — gitignored
  middleware/auth.js     Verifies the x-session-token header against the sessions table
  routes/
    auth.js              POST /api/auth/login (rate-limited), POST /api/auth/logout
    technicians.js        GET/PUT/POST week + allocations + submit (per-day validation)
    woms.js               GET/POST/PATCH WOM list + status, POST :code/complete (tech-facing)
    admin.js               Weekly review, UKG hours, roster, profile (basic info, onboarding,
                              devices, allocation history), approve/reject/unlock
    locations.js             GET (any user) / POST (admin) locations
    audit.js                  Audit log
    files.js                   Upload/list/download/delete attachments
  utils/
    week.js                Mon–Sun week date helpers
    password.js             scrypt PIN hashing (hashPin/verifyPin)
scripts/
  deploy.sh               One-shot droplet setup: Node 22, app, systemd service, firewall
tests/
  helpers.js              Spins up an isolated app instance per test file; logs in for real tokens
  auth.test.js             Login, sessions, impersonation-is-blocked, rate limiting, logout
  allocation.test.js       Hour validation, WOM gating, locking
  admin.test.js             Approve / reject / unlock
  woms.test.js               WOM CRUD + authorization
  roster.test.js              Basic info, onboarding, devices, allocation history
  files.test.js                 Upload/list/download/delete authorization
  audit.test.js                   Audit log writes and admin-only read access
public/
  index.html
  css/styles.css
  js/
    app.js                Shell, routing, shared state
    api.js                Fetch wrapper (+ multipart upload, blob download)
    weekUtil.js            Client-side week date helpers
    views/
      login.js
      techWeek.js           Technician weekly allocation screen, attachments, computeReceipt (Reg/OT)
      adminReview.js         Admin review / WOM docs / audit / Tech Allocation switcher / Technicians tab entry
      technicianProfile.js    Team Roster (+ add technician) and tabbed employee profile
      attachments.js          Shared attachments list + upload component
```
