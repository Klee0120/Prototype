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
per-tech authorization, admin-on-behalf-of), week locking, the Thu-Mon
technician edit window (open/past/future/gap). Every test file gets a
default clock pin (Thursday of "this week", via `tests/helpers.js`) so a
plain technician PUT/submit doesn't depend on which real day/time
`npm test` happens to run — `weekWindow.test.js` overrides that pin
per-test to specifically exercise the other three states. Also:
admin approve/reject/unlock, the UKG-confirmed checklist, WOM status
management, technician creation and employment status,
onboarding/devices/allocation history, file upload/download/delete
authorization, and audit log writes/read-access. The Reg/OT receipt
calculation exists client-side (technician's own view) and server-side
(admin Overview); the server copy has OT-flagging test coverage, the
client copy is verified manually (see "Where this stands").

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
  - **Every day starts pre-filled** with a full E&F split at home matching
    that day's UKG hours, so the common case (no WOM work that day) is
    already balanced with zero clicks. Only applies to days with nothing
    entered yet, and clears itself the moment it's no longer the whole
    story: clicking **+ Add split** removes it (so a new WOM split doesn't
    just stack on top and double the hours), picking a real **Time off**
    type removes it (and defaults the time-off hours to the day's full UKG
    total), and **Default to home** clears any WOM/other-location splits
    for that day and reverts to home for whatever's left after time off
- Submission blocked until **every day's** allocated hours exactly equal
  that day's UKG hours (not just the weekly total)
- A technician can mark a WOM project complete from their own allocation
  screen — it closes the WOM (for everyone) only once they successfully
  submit that week, not the moment they click it, so it can't lock them
  out of submitting their own in-progress draft; an admin can
  open/close/reopen any WOM directly at any time
- **Bulk UKG entry**: paste 7 space/comma-separated numbers (Mon→Sun) to
  fill a week's hours in one go instead of typing each day, with a live
  **Total** readout next to the day fields in both decimal (e.g. `42.5`)
  and UKG's own clock format (`42:30`), so it's easy to eyeball against
  the UKG screenshot you're transcribing from
- Admin review screen: approve, reject (with note, returns to technician), or
  unlock an approved week for correction; UKG screenshots/receipts for that
  week are visible right there, not just on the technician's own screen
- **Overview tab (RFM/admin)**: every technician's week at a glance for the
  selected week — total UKG hours, +/- 40, Regular/OT split, and OT broken
  into "on a WOM" vs. "not on a WOM." A row is **flagged** (and sorted to the
  top) when more than 3 overtime hours in the week aren't charged to any WOM
  project, since that's overtime nobody can currently explain by a specific
  job. Each row's "View" button jumps straight to that technician's expanded
  entry on the Weekly Review tab — hour-by-hour detail, approve/reject, and
  the UKG screenshot/receipt attachments — so admin/RFM can pull whatever
  they need from one table instead of opening each technician individually
- **Pending punch correction flag**: admin can flag a specific day (right
  next to that day's UKG hours field) as waiting on a real UKG punch fix
  (a missed clock-out, etc.). The technician sees a clear note on that
  day's card explaining the hours aren't final yet, instead of it looking
  like their time was forgotten or entered wrong. Toggle it off once the
  real punch is fixed and the correct hours are in.
- **WOM photo prompt**: after a technician submits a week (or an admin marks
  it "entered in UKG") that included WOM hours, a dismissible prompt offers
  to attach a work photo for each WOM touched that week — reusing the same
  WOM documents store as the WOM Status tab's Documents panel, so a photo
  added either way shows up in both places.
- **Labor Reports tab (admin)**: a simple month-by-month archive for the
  labor report finance sends over, saved here so it's kept alongside the
  timesheeting for that period — for comparing against what this app
  tracked. File storage only for now; see "Where this stands" for the
  bigger reconciliation idea this could grow into.
- **Team Roster** (admin's Technicians tab): filterable by location/status,
  showing name, UKG ID, position, and home location. Clicking a row opens a
  tabbed **employee profile**:
  - Basic Info (editable email/phone/UKG ID/position/home location/
    **employment status**: active/inactive/terminated/retired/**hire
    date**/**termination date**/**standard daily hours (net of break)**).
    The technician's own `id` (e.g. `T1001`) already serves as the stable
    internal identifier a UKG ID correction shouldn't be able to disturb —
    no separate "Employee ID" field was added on top of it
  - Labor Allocation History — every WOM/E&F/time-off row ever allocated to
    that technician, across all weeks, so you can see what's been worked on
  - Onboarding — a fixed 5-item checklist per technician (not yet an
    admin-editable template — see "Where this stands")
  - Devices — Phone or Laptop, each with its identifier (phone number, or
    an asset tag/serial for a laptop) and notes. Each device also has its
    own small **IT Requests** log (e.g. a Calero line cancellation): a
    request type + reference number that can be marked completed and
    reopened, so a pending vendor request doesn't get lost track of
  - Forms on File / Documents — file attachments, same mechanism as WOM docs
- **Add technician**: a form on the roster (ID, name, PIN, position,
  home location, contact info) creates a new technician who can log in
  immediately
- **Admin can allocate on a technician's behalf** (new "Tech Allocation"
  tab): the exact same day-by-day splitting screen a technician sees, with
  an employee switcher (dropdown + Prev/Next) to move through the roster —
  for when someone's on vacation or otherwise can't do it themselves. If
  the week they land on is already approved, an **"Unlock for correction"**
  link sits right there in the status banner — no need to switch over to
  Weekly Review to unlock it first (that's a separate action from the
  Weekly Review checklist's "Undo," which only un-checks your own "entered
  in UKG" confirmation and never touches submitted/approved status)
- **Weekly Reg/OT receipt**: live-updating breakdown (Week Total, Regular,
  Overtime, OT on WOM, Time Off, plus a per-bucket Reg/OT/Total table) shown
  under the day cards. Hours beyond 40/week are OT; WOM hours are charged to
  OT before E&F hours; time off is always straight time and excluded from
  the 40-hour threshold entirely (see "Where this stands" for a documented
  simplification in this calculation)
- **Technician edit window (Thu 12am – Mon 12pm Eastern)**: a technician can
  only fully allocate the one week whose window is currently open. Outside
  that window: past weeks are read-only (locked, same as an approved week,
  regardless of status), and future weeks are open for **time off only**
  (vacation/sick/bereavement/holiday) so someone can pre-book known time off
  before their actual hours are known — no WOM/E&F splitting, no submit,
  since there's nothing to balance against yet. A rejected week is always
  fully editable for the technician regardless of the window, so a late
  rejection never strands them. **Admin is never restricted by this window**
  — the existing allocate-on-behalf/unlock tools work exactly as before, any
  time. See "Where this stands" for the exact rule and how to change it.
- **Weekly Review's admin checklist**: three steps per technician per week —
  UKG hours entered, allocation matches UKG, and a third, purely
  admin-controlled confirmation ("entered in UKG") for once you've put it
  into the real UKG system. That third step is independent of the
  technician's own submit/approve status — since in practice you often
  drive all three steps yourself based on a conversation with the
  technician. Marking it moves that technician into a separate "Completed"
  list (undo-able) so Weekly Review always shows who still needs attention.
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

**JDE accounting codes.** Each location carries its own real E&F Contract Job
Number (from the JDE location lookup table) and a Region label (e.g.
"Southeast", "Region 1") used to match the location up against the monthly
labor-report/financial file. E&F general time itself always posts to a
single standard subsidiary/service code — `20920000` — the same at every
location; that's a fixed constant (`EF_SUBSIDIARY_CODE` in
`server/routes/locations.js`), not per-location data, and is surfaced to the
client as `efSubsidiaryCode` on every location so it's visible without being
editable. WOM projects are different: each WOM has its *own* subsidiary code
that varies project to project, entered by an admin when the WOM is created
or edited. Both fields are managed from the "WOM Status" tab, which now has
a Locations section above the WOM list (add/edit a location's name, E&F Job
Number, and Region) and lets the WOM add form and each WOM row's Edit button
set/change the subsidiary code.

## Where this stands

- **Storage is real, deployment isn't.** The database and file storage are
  no longer mock — they're the same engine and pattern you'd keep going
  forward. What's still missing for real use by your team is *reachability*:
  right now this only runs on whatever machine starts it, reachable at
  `localhost:3000` on that machine only.
- **Deployed on a $6/mo DigitalOcean droplet**, running as a systemd service
  (auto-restarts on crash or reboot) behind a basic firewall (only SSH + port
  80 open). See `scripts/deploy.sh` for first-time setup, and
  `scripts/redeploy.sh` to pull + restart afterward — both are single-line
  `curl | bash` commands so there's no multi-command line for a
  copy/paste-mangling terminal to break:
  ```
  curl -fsSL https://raw.githubusercontent.com/Klee0120/Prototype/claude/labor-allocation-prototype-b0y12v/scripts/redeploy.sh | bash
  ```
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
- **Standard daily hours is stored but not used anywhere yet.** It's
  plain reference data on the profile right now — a natural next step
  would be using it to pre-fill the admin's UKG hours form (instead of
  the current blank/last-saved default), but that's not wired up.
- **Onboarding is a fixed checklist, not a template.** The 5 tasks are
  hardcoded in `server/data/db.js` (`ONBOARDING_TASKS`); there's no UI yet
  to add/remove/reorder tasks. Fine for a stable process, a real limitation
  if the checklist needs to change often.
- **Devices is a list plus a request log, not a full workflow.** It records
  "this device is assigned to this person" and lets you log/track IT
  vendor requests against it (e.g. a Calero cancellation, by type +
  reference number, marked completed when resolved) — but there's still
  no due-back date, no approval step, and no device inventory shared
  across technicians (you can't see "who else has a Toyota laptop" across
  the roster, only per-person).
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
- **The Reg/OT math now exists in two places.** `public/js/views/techWeek.js`
  has the browser copy (for the technician's own live receipt);
  `server/utils/receipt.js` has a server copy (for the admin Overview
  report, computed across every technician at once). They're deliberately
  duplicated rather than shared, since one runs in the browser as an ES
  module and the other in Node as CommonJS — if the OT rule ever changes,
  both need updating together.
- **Overview's flag threshold (3 OT hours not on a WOM) is a first guess,
  not a rule you gave us.** It's easy to change
  (`OT_NOT_ON_WOM_FLAG_THRESHOLD` in `server/routes/admin.js`) if 3 hours is
  too sensitive or not sensitive enough in practice.
- **Overview doesn't (yet) replace the call-in tracking or the Smartsheet
  before/after screenshot process.** It shows the same UKG screenshot and
  receipt/invoice attachments the technician's own week already has,
  plus the live Reg/OT numbers — it doesn't have fields for call-in
  time, H&E, or a separate "before I made changes" snapshot the way the
  Smartsheet log does. If that turns out to matter for the audit trail (not
  just "what's the total" but "what did it look like before someone
  touched it"), the natural next step is persisting a locked snapshot of
  the receipt/allocations at approval time, rather than only ever showing
  the live numbers.
- **The technician edit window is hardcoded to Eastern Time.** Thursday
  12am through Monday 12pm, in `America/New_York`
  (`server/utils/week.js`'s `BUSINESS_TIMEZONE`) — picked because 3 of the
  4 seeded locations are Eastern; Kansas City is Central, so its
  technicians see the window open/close an hour later on their own clock.
  If that's not acceptable, either change the constant (one timezone for
  everyone) or the window needs to become per-location, which isn't built.
- **The "gap" between windows is deliberate, not a bug.** Monday noon
  through Wednesday night, no week is open for full allocation — the
  just-finished week has already closed for processing, and the coming
  week hasn't happened yet. A technician can still pre-book time off on
  the coming week during that gap; there's just nothing to submit until
  Thursday.
- **The three-step admin checklist ("entered in UKG") is a flag, not a
  fact-check.** Nothing verifies that the admin actually entered it into
  the real UKG system — it's a manual confirmation (`weeks.ukg_confirmed_at`
  in the database), the same way a paper checklist trusts whoever checks
  the box. If that ever needs to be tied to something verifiable (e.g. a
  UKG export file), that's a bigger integration, not a UI change.
- **The pending-punch flag is boolean, not a note.** It says "this day
  isn't final" but doesn't capture why (which punch, what the tech says
  happened) or log a resolution distinct from just re-entering the hours
  later — it's flagged, then someone edits the hours and clears it. If a
  documented "technician reported X, admin resolved with Y" trail turns
  out to matter (not just a visual flag), that's a distinct small feature,
  not an extension of this one — worth a separate design pass.
- **The WOM photo prompt is a one-time nudge, not enforcement.** It shows
  once right after the triggering action (submit, or admin confirming
  "entered in UKG") and is fully skippable — nothing blocks progress if no
  photo is ever added, and it won't reappear if dismissed. If photos ever
  need to be mandatory for certain WOMs, that needs a real requirement
  check, not just a prompt.
- **Labor Reports is storage only — there's no comparison logic yet.** It
  saves the monthly file finance sends so it's kept next to the
  timesheeting for that period; nothing in the app reads its contents or
  checks it against tracked hours. The real labor report (seen live use)
  breaks hours down by employee and WOM/subledger into ST/OT/Holiday/
  Sick/Vacation columns — close enough to what `computeReceipt` already
  produces that a real reconciliation (export our numbers in the same
  shape, or actually diff against a pasted-in report) is very buildable
  once there's a settled target format to build against.
- **Only Region and the E&F Job Number are tracked from the real JDE lookup
  table, not the whole sheet.** The real table (per the Midwest region
  screenshot) also has a PPS Contract Job Number, separate WMBE GMP/NON GMP
  job numbers, a Toyota Reference Code, and address/city/state/zip per
  location — none of that is captured yet since nothing in the app needs it
  today. Region was added now specifically because it's what the monthly
  labor report will need to be matched up against; the rest is a bigger
  "site directory" feature to build only if/when it's actually needed for
  reconciliation or reporting.

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
    woms.js               GET/POST/PATCH WOM list + status + :code/details (subsidiary code etc.),
                              POST :code/complete (tech-facing)
    admin.js               Weekly review + Overview report, UKG hours, pending-punch flag,
                              UKG-confirmed checklist, roster, profile (basic info, onboarding,
                              devices, allocation history), approve/reject/unlock
    locations.js             GET (any user) / POST+PATCH (admin) locations, incl. E&F Job
                              Number/Region and the standard EF_SUBSIDIARY_CODE constant
    audit.js                  Audit log
    files.js                   Upload/list/download/delete attachments (week/wom/technician/labor_report)
  utils/
    week.js                Mon–Sun week date helpers, business-timezone edit window
                              (classifyWeekForTech / getOpenWeekMonday)
    password.js             scrypt PIN hashing (hashPin/verifyPin)
    allocation.js            presentAllocation: translates a stored timeoff row's shape for API responses
    receipt.js               Server-side copy of the Reg/OT computeReceipt calculation (admin Overview)
scripts/
  deploy.sh               One-shot droplet setup: Node 22, app, systemd service, firewall
tests/
  helpers.js              Spins up an isolated app instance per test file; logs in for real tokens
  auth.test.js             Login, sessions, impersonation-is-blocked, rate limiting, logout
  allocation.test.js       Hour validation, WOM gating, locking
  admin.test.js             Approve / reject / unlock, Overview report OT-flagging, UKG-confirmed
                              checklist, pending-punch flag
  weekWindow.test.js         Edit-window classification + PUT/POST enforcement (open/past/future/gap)
  woms.test.js               WOM CRUD + authorization, subsidiary code, location E&F Job Number/Region
  roster.test.js              Basic info, onboarding, devices, allocation history
  files.test.js                 Upload/list/download/delete authorization, labor_report admin-only
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
      adminReview.js         Admin review / Overview report / WOM docs / Labor Reports archive / audit /
                              Tech Allocation switcher / Technicians tab entry
      technicianProfile.js    Team Roster (+ add technician) and tabbed employee profile
      attachments.js          Shared attachments list + upload component
      womPhotoPrompt.js        Dismissible "add a photo?" nudge after submit / UKG-confirmed, reused
                                  by both techWeek.js and adminReview.js
```
