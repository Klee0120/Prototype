# Labor Allocation Prototype

A functional prototype for internal weekly labor allocation: technicians allocate
their UKG-reported weekly hours across open Work Order Management (WOM) codes,
attach supporting files, and admins review, approve/reject, and lock completed
weeks.

This is a prototype, not a production system: mock login data, no password
hashing, and it isn't deployed anywhere — everything runs locally. See
"Where this stands" below for what that means in practice.

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
- Weekly Mon–Sun hour allocation against a list of open WOMs
- UKG total hours shown as the weekly source-of-truth target
- Submission blocked until allocated hours exactly equal UKG hours
- Admin review screen: approve, reject (with note, returns to technician), or
  unlock an approved week for correction
- WOM open/closed status management (only open WOMs are selectable for new
  allocations)
- Week locking: a submitted/approved week can't be edited by the technician
  until an admin rejects or unlocks it
- Audit trail of logins, allocation saves, submissions, approvals,
  rejections, unlocks, WOM status changes, and file uploads/deletes
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

## Where this stands

- **Storage is real, deployment isn't.** The database and file storage are
  no longer mock — they're the same engine and pattern you'd keep going
  forward. What's still missing for real use by your team is *reachability*:
  right now this only runs on whatever machine starts it, reachable at
  `localhost:3000` on that machine only.
- **No hosting decision has been made on purpose.** Getting this in front of
  11 technicians means picking how they reach it — a private VPN mesh
  (e.g. Tailscale) so nothing touches the public internet, a small
  self-purchased VPS, or a managed host — and that's a real tradeoff between
  convenience and where technician data physically lives. Worth deciding
  deliberately rather than defaulting into it.
- **Auth is still mock.** PINs are stored in plain text and there's no
  session/token mechanism — fine while it's just you testing, not fine once
  it's reachable by anyone other than you.

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
  middleware/auth.js     Mock header-based auth
  routes/
    auth.js              POST /api/auth/login
    technicians.js        GET/PUT/POST week + allocations + submit
    woms.js               GET/POST/PATCH WOM list + status
    admin.js               Weekly review list, technician list, approve/reject/unlock
    audit.js                Audit log
    files.js                 Upload/list/download/delete attachments
  utils/week.js           Mon–Sun week date helpers
tests/
  helpers.js              Spins up an isolated app instance per test file
  auth.test.js
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
