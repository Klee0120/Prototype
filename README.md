# Labor Allocation Prototype

A functional prototype for internal weekly labor allocation: technicians allocate
their UKG-reported weekly hours across open Work Order Management (WOM) codes,
and admins review, approve/reject, and lock completed weeks.

This is a prototype, not a production system: mock data, mock auth, JSON-file
persistence, no encryption/hashing of PINs.

## Stack

- **Backend:** Node.js + Express, plain JS, in-memory data persisted to
  `server/data/store.json`.
- **Frontend:** Vanilla JS (native ES modules, no build step) + plain CSS,
  served as static files by Express.

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

The suite boots the Express app on an ephemeral port with a throwaway JSON
store per test file (`tests/helpers.js`), so it never touches your real
`server/data/store.json`. It covers login, allocation validation (hours
mismatch, closed/unknown WOM rejection, per-tech authorization), week
locking, admin approve/reject/unlock, WOM status management, and audit log
writes/read-access.

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
  rejections, unlocks, and WOM status changes
- Mobile-friendly responsive layout

## Data model

Mock data lives in `server/data/seed.js` and is loaded into
`server/data/store.json` on first run (subsequent runs read/write that file,
so state persists across restarts — delete it to reset to the seed).

## Folder structure

```
server/
  app.js                Express app + route wiring (exported for tests)
  index.js              Entry point: creates the app and listens
  data/
    seed.js             Mock data (technicians, WOMs, UKG hours, sample weeks)
    db.js               In-memory store + JSON persistence + accessors
  middleware/auth.js     Mock header-based auth
  routes/
    auth.js              POST /api/auth/login
    technicians.js        GET/PUT/POST week + allocations + submit
    woms.js               GET/POST/PATCH WOM list + status
    admin.js               Weekly review list, approve/reject/unlock
    audit.js                Audit log
  utils/week.js           Mon–Sun week date helpers
tests/
  helpers.js              Spins up an isolated app instance per test file
  auth.test.js
  allocation.test.js       Hour validation, WOM gating, locking
  admin.test.js             Approve / reject / unlock
  woms.test.js               WOM CRUD + authorization
  audit.test.js               Audit log writes and admin-only read access
public/
  index.html
  css/styles.css
  js/
    app.js                Shell, routing, shared state
    api.js                Fetch wrapper
    weekUtil.js            Client-side week date helpers
    views/
      login.js
      techWeek.js           Technician weekly allocation screen
      adminReview.js         Admin review / WOM management / audit trail
```
