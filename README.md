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
per-tech authorization), week locking, admin approve/reject/unlock, WOM
status management, file upload/download/delete authorization, and audit
log writes/read-access.

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
- Admin review screen: approve, reject (with note, returns to technician), or
  unlock an approved week for correction
- Week locking: a submitted/approved week can't be edited by the technician
  until an admin rejects or unlocks it
- Audit trail of logins, allocation saves, submissions, approvals,
  rejections, unlocks, WOM status changes, home-location changes, UKG hour
  entries, and file uploads/deletes
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
    admin.js               Weekly review, UKG hours entry, home location, approve/reject/unlock
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
  files.test.js               Upload/list/download/delete authorization
  audit.test.js                 Audit log writes and admin-only read access
public/
  index.html
  css/styles.css
  js/
    app.js                Shell, routing, shared state
    api.js                Fetch wrapper (+ multipart upload, blob download)
    weekUtil.js            Client-side week date helpers
    views/
      login.js
      techWeek.js           Technician weekly allocation screen + attachments
      adminReview.js         Admin review / WOM docs / technician forms / audit
      attachments.js          Shared attachments list + upload component
```
