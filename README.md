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
- No cloud services are required — the whole thing runs on one machine with
  two local files/folders as its only state. The one optional exception is
  outbound email (`nodemailer`, via `server/utils/mailer.js`): it's a no-op
  until you point it at an SMTP account (see "Where this stands"), and
  nothing else in the app depends on it.

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

- **Visual design pass**: an actual typeface (Inter, via Google Fonts --
  `public/index.html`) instead of the bare system-font stack, a refined
  color/shadow token set in `:root` (`--shadow-sm`/`--shadow-md`,
  a slightly richer accent/ink), a small logo mark and drop-shadowed
  header in place of a flat bottom border, elevated card surfaces (the
  Schedule detail panel, WOM Lookup's result card), and buttons/nav pills/
  tabs with real hover and active states and short transitions instead of
  instant, static color swaps. All in `public/css/styles.css`'s shared
  tokens and a handful of high-traffic components -- not a rewrite of
  every view's markup, but enough that the app doesn't read as an
  unstyled skeleton anymore.
- **"Add a new X" forms open as an actual pop-up dialog** (`public/js/modal.js`
  -- a small shared `openModal({ title, bodyHtml })` helper: centered card,
  dimmed backdrop, closes on its own &times;, Escape, or a backdrop click),
  not an inline form expanding into the page -- feedback from real use was
  that the inline pattern didn't feel like a real application. Converted:
  + New Task (Priorities), + Schedule a WOM (Schedule), + Add vendor
  (Vendors), + Add technician (Roster). A read-only detail panel (clicking
  a Schedule entry, a task card's "Details") stays inline, on purpose --
  this is specifically for *creating a new record*, not for viewing one.
- Technician login (mock ID + PIN)
- **Technician's own tabs**: "My Week" (the allocation screen below),
  **"Locations & WOM"** (view-only — every location and every WOM project,
  including closed/invoiced ones, so a technician can see what's out there
  and what they've worked on historically; no add/edit/close controls at
  all), and **"My Documents"** (view-only Forms & Certifications and
  Documents from their own profile — the same records an admin manages from
  the Technicians tab, just read-only here). Technicians can view their own
  stuff but can't delete anything anywhere in the app, including their own
  uploads — deleting is admin-only, full stop.
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
  out of submitting their own in-progress draft. **WOM status lifecycle:
  Pending → Requested → Open → Invoiced → Closed, with Cancelled as the
  other way a job can end** — an admin can set a WOM directly to any of
  those at any time from the E&F Locations & WOM tab's status dropdown,
  completely independent of whether (or when) a technician ever marked it
  complete. "Invoiced" is there specifically for the moment the invoice
  actually goes out, distinct from fully closing the job out; "Cancelled" is
  for a job that was declined or dropped and never billed at all — a
  technician can't allocate new hours to a WOM once it's anything other than
  Open. The **WOM Projects** list (E&F Locations & WOM tab) groups WOMs into
  three sections so day-to-day work isn't cluttered by old ones: **Active**
  (Pending/Requested/Open — the ones still in play), **Invoiced** (Invoiced
  and Closed together, since both mean the job was billed), and
  **Cancelled**. Each row leads with the **project name** and a **location**
  tag — the two things people actually recognize — with the WOM code shown
  small and secondary, since it mostly matters for keying into JDE/UKG.
  A WOM can also be **deleted** outright (its own button on the row,
  admin-only, `DELETE /api/woms/:code`) for one created by mistake — a test
  entry, a typo — rather than leaving it sitting under some status forever.
  Blocked with a clear error if hours are already allocated against it
  anywhere (deleting would otherwise silently pull those hours out from
  under a technician's timesheet); the confirm dialog surfaces that and asks
  again before forcing it through, which also removes those allocation rows.
  A row also flags **"Not imported from Smartsheet"** whenever no sync has
  ever touched it (`smartsheetSyncedAt` is still null) — those are exactly
  the ones worth a look when cleaning up test entries or typos, since a
  real WOM in active use almost always has a sync behind it
- **Bulk UKG entry**: paste 7 space/comma-separated numbers (Mon→Sun) to
  fill a week's hours in one go instead of typing each day, with a live
  **Total** readout in both decimal (e.g. `42.5`) and UKG's own clock format
  (`42:30`), so it's easy to eyeball against the UKG screenshot you're
  transcribing from — each individual day field shows this same live
  decimal/clock pairing too, not just the total.
- **UKG hours fields accept clock format directly, not just decimal.**
  Typing the number straight off a UKG timesheet screenshot into a
  decimal-only field is a trap: `8.25` decimal is 8h **15m**, not 8h25m, so
  naively typing "8.25" to mean "8:25" silently saves the wrong value on any
  punch that isn't a clean quarter hour. Every UKG hours field (the main
  per-day fields, the bulk-paste box, and the corrected-hours field when
  resolving a punch issue) now accepts either form — type `8:25` and it
  converts to the correct decimal (`8.42`) the moment you leave the field,
  or keep typing plain decimals as before. The live clock readout underneath
  each field is the way to sanity-check either way.
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
- **Employee OT Trends** (below the Overview table): the same OT-not-on-WOM
  number as the main table, but across the trailing 8 weeks per technician
  (`OT_TREND_WEEKS` in `server/routes/admin.js`), so a repeat pattern is
  visible instead of just this week's snapshot. Only lists technicians
  flagged at least once in that window, with a flagged-weeks count, the
  8-week average, and a simple Rising/Falling/Steady trend (comparing the
  first half of the window's average to the second half's) — a "View" jumps
  to that technician on Weekly Review the same as the main table's does
- **"Your hours are ready to allocate" notifications**: as soon as an admin
  saves UKG hours for a technician's still-draft week, that technician sees a
  clear in-app note the next time they open that week ("Your hours are in —
  go ahead and allocate your time below"). On top of that, each technician
  can pick **Notify me by: In-app only / Email** for themselves (right on
  their own week screen) — email is only offered once they have an email
  address on file (set by an admin on their Basic Info; not editable by the
  technician), and choosing it sends a real email at that same trigger
  point. Email delivery is opt-in infrastructure: it's a no-op (logs what it
  would have sent, doesn't error) until real SMTP credentials are set via
  environment variables — see "Where this stands" for exactly which ones.
- **Pending punch correction flag**: either side can flag a specific day as
  waiting on a real UKG punch fix (a missed clock-out, etc.) -- admin from
  the "Flag punch" link next to that day's UKG hours field, or the
  **technician themselves** from a "⚠ Flag a punch issue" link on their own
  day card, with an optional note (e.g. "forgot to clock out"), instead of
  their only option being a phone call or text. Either way the technician
  sees a clear note on that day's card ("waiting on admin" if they reported
  it themselves, a generic one if admin flagged it) explaining the hours
  aren't final yet, instead of it looking like their time was forgotten or
  entered wrong. A tech-reported issue also shows up in the admin's
  **Priorities** tab ("Punch issues reported by techs") with their note, so
  a new report never just sits unnoticed on a week admin isn't currently
  looking at. **Resolving one is a single step on Weekly Review**, same
  pattern as the weekend-hours addendum: the flagged day's existing
  allocation shows inline (with accounting codes) alongside a corrected-
  UKG-hours field, and clicking "Resolve" fixes both together and clears the
  flag -- without unlocking the rest of an already-submitted/approved week,
  which would otherwise reset the *whole* week to draft and force the
  technician to redo Mon-Fri even though only one day's number changed.
- **WOM photo prompt**: when a technician has WOM hours entered for the week,
  a dismissible prompt (shown *before* Submit, right alongside the day cards,
  not as an after-the-fact step with nothing left to do) offers to attach a
  work photo for each WOM touched that week — reusing the same WOM documents
  store as the E&F Locations & WOM tab's Documents panel, so a photo added either way
  shows up in both places. It's the technician's own reminder, so it's never
  shown to an admin (allocating on a technician's behalf on Tech Allocation,
  or confirming "entered in UKG" on Weekly Review) — an admin who wants to
  attach a WOM photo does it from the E&F Locations & WOM tab's Documents panel.
- **Vendors tab (admin)**: a vendor onboarding/compliance tracker, separate
  from technicians/locations since a vendor is a company, not a person who
  logs in or a place work happens. Each vendor tracks a JDE Vendor #, three
  independent statuses (**C&W** active/inactive, **Toyota** approved/not
  approved, **Forms** current/outdated — each defaulting to "unknown" until
  set), plus detail fields (phone/email/PO email, services, Midwest sites
  seen, invoicing history, notes, etc.). Search by name/JDE#/service and
  filter by C&W or Toyota status; click a vendor to expand and edit, or
  remove it outright (unlike locations/WOMs, which can't currently be
  deleted — see "Where this stands"). `scripts/import-vendors.js` bulk-loads
  or updates vendor records from a JSON file — built for importing an
  existing vendor tracker spreadsheet once, safe to re-run (matches
  existing vendors by JDE # or name and updates them instead of duplicating).
- **Vendor document compliance checklist**: specific checkboxes verified
  against the actual attached COI/W-9/ACH document, separate from the COI
  coverage-limit checks (`coiMeetsRequiredLimits`/`coiMeetsLanguageRequirements`)
  and from `formsStatus` (currency/expiration) — these are about the
  document itself being the right form and matching the vendor's other
  paperwork:
  - **COI**: issued on ACORD 25 (2016/03 version); matches the vendor's W-9
    name & address.
  - **W-9**: signed and dated; correct version (October 2018 or March
    2024); has a phone number; has a remit-to address; has the vendor's
    name. Plus a **blank invoice date** field — flagged stale once it's
    over 2 years old.
  - **ACH**: on bank letterhead; has the vendor's W-9 name; has the
    vendor's W-9 address.

  Any box left unchecked (or a stale invoice date) marks that vendor
  "Doc checks incomplete" on the Vendors list and rolls up into the
  Priorities tab, same flagging idea as an outdated form.
- **Schedule tab**: a month calendar of **WOM project work only** — no E&F
  time and no time off, since the point is seeing what's already scheduled
  project-wise, not a general timesheet view (Tech Allocation and Weekly
  Review already cover that). Each day's cell lists every technician's WOM
  assignment landing on that actual calendar date, headlined by the
  **project name and technician's own name** (the WOM code and Maximo # are
  secondary, shown on the smaller line below along with hours and site),
  built entirely from allocations already in this app
  (`GET /api/schedule/:month`, `server/routes/schedule.js`,
  month as `YYYY-MM`) with **Prev/Next month** navigation, and open to any
  logged-in user (not admin-only), since the point is letting anyone check
  what's already on the books before scheduling more onto a project or a
  person's plate. A **site filter** (`?location=CODE` on the same endpoint)
  narrows the whole calendar down to one location at a time, since a
  mixed-site day is hard to read at a glance — every entry also always shows
  its site regardless of the filter, for when "All sites" is selected.
  Every date shown is explicitly labeled **"Tentative"**: a technician's own
  planned allocation for that day, not a locked commitment, so the calendar
  reads as a working plan rather than a confirmed schedule. **A WOM
  scheduled across several consecutive days draws as a single bar spanning
  those days' columns** (`buildWeekRuns` in `schedule.js`), not a repeated,
  identical entry on every day it covers -- grouped by matching
  technician + WOM + hours, with overlapping bars in the same week packed
  into their own rows (a simple Gantt-style lane-packing algorithm) rather
  than piling on top of each other. **Clicking a bar** opens that WOM's own
  detail inline (status, location, budget/remaining hours, estimated/
  applied pricing, and the date range plus which technician it's assigned
  to) without leaving the calendar — the schedule API embeds this straight
  from the underlying WOM record on each entry, so no second request is
  needed. A single **"+ Schedule a WOM"** button in the calendar's own nav
  bar (not a `+` scattered on every day) opens a form to put a WOM on the
  calendar — a technician for themselves, admin/RFM for anyone — without
  leaving the calendar for Tech Allocation/My Week: pick a technician
  (admin only; a technician can only schedule their own time), then a
  **location, then that location's project name** (the same two-step
  location-first cascade Tech Allocation's own add-technician flow uses).
  The location defaults to **whichever technician is selected/logged in's
  own home location** (if it has open work) rather than the calendar's own
  site filter or just the first location alphabetically -- still fully
  open to pick anywhere else that has open WOMs, this just saves the most
  common case (someone scheduling their own site) a step; picking a
  different technician (admin only) re-defaults it to that technician's
  home location. Then hours per day, and a **first/last day date range**
  (one day is just a range of one), and it's added as a normal allocation
  alongside whatever else each technician already has on those days (never
  replacing it). A range spanning more than one calendar week is
  split by the client into per-day batches (capped at 62 days/~2 months per
  request) and saved via a **dedicated endpoint that ignores the week's own
  edit lock/window entirely** —
  `PUT /api/technicians/:id/weeks/:weekMonday/schedule-wom`
  (`server/routes/technicians.js`) — since scheduling is a planning action,
  not a timesheet edit: a locked/submitted/approved week, a past week, or a
  week whose window hasn't even opened yet all still accept a schedule
  entry. The one thing that still blocks a day is the WOM itself (still has
  to be open — closed/invoiced/pending/requested all still get rejected,
  same validation Tech Allocation/My Week use). Scoped to exactly one day
  per call (mirrors the existing weekend-allocations/resolve-punch-issue
  endpoints' own safety property) so this can never be used to quietly
  change the rest of an already-locked week — only the specific day(s)
  actually being scheduled are ever touched. **Not a Microsoft Teams/Outlook
  integration** — that would need Azure AD app registration and IT approval
  before any of it could be built; for now it only reflects what's been
  allocated here, not a technician's other real-world commitments. See
  "Where this stands" for what that future integration would actually need.
- **WOM projects closed here don't close on your external Smartsheet
  tracker** — a new Priorities section ("WOM projects closed -- update
  Smartsheet") lists every WOM that's been closed (by a technician's own
  "mark complete" or admin's status dropdown) but not yet reflected there,
  with a "Mark updated in Smartsheet" button that clears it once you've
  gone and done that by hand. Reopening and re-closing a WOM flags it again
  from scratch, so a second closure doesn't get silently skipped just
  because the first one was already handled.
- **PurelyHR time-off verification, 4th step on Weekly Review**: PurelyHR
  tracks time-off balances/requests separately from UKG and doesn't link to
  either UKG or this app, so a technician's PTO/Sick/Holiday/Bereavement
  hours logged here have to be manually cross-checked there. Any
  submitted/approved week containing time off gets a 4th checklist step
  ("PurelyHR verified") right alongside the existing three on Weekly Review
  — a week isn't "Completed" until that's checked too, same as the other
  three. Verification is per-week (not per individual time-off entry), set/
  unset via `PATCH /api/admin/weeks/:techId/:weekMonday/purelyhr-verified`
  (mirrors the existing `ukg-confirmed` step), and automatically clears if
  the week's allocations are edited afterward (an edit could add, remove,
  or change the time off that was already checked). Also rolled up into the
  Priorities tab ("Time off needing PurelyHR verification") so a past
  week's unverified time off doesn't just get missed once Weekly Review
  moves on to a later week.
- **Reports tab (admin)**: a month-by-month archive for four monthly report
  kinds -- **WOM Report, Labor Report, Financial Report, and GL Report** --
  saved here so each is kept alongside the timesheeting for that period, for
  comparing against what this app tracked. A **Month/Year dropdown picker**
  jumps straight to any period (rather than paging Prev/Next one month at a
  time), and each report kind gets its **own section**, always in the same
  WOM/Labor/Financial/GL order, so a given kind's history reads top to
  bottom without hunting through the others. File storage only for now; see
  "Where this stands" for the bigger reconciliation idea this could grow
  into.
- **Admin nav grouped into sections**: the 10 admin tabs used to sit in one
  flat, horizontally-scrolling row (Priorities, Tech Allocation, Schedule,
  Overview, Weekly Review, E&F Locations & WOM, Technicians, Vendors,
  Reports, Audit Trail) -- wide enough on most screens to need scrolling
  just to see the last few. They're now grouped under seven top-level
  sections (`public/js/views/adminReview.js`'s `NAV_SECTIONS`):
  **Priorities**, **Timekeeping** (Tech Allocation, Schedule, Overview,
  Weekly Review), **Roster** (Technicians), **Vendors**, **WOM** (Locations
  & WOM, plus the new WOM Lookup below), **Financials** (PSE Tasks, then
  Reports -- kept separate from Timekeeping since PO/PSE pipeline tracking
  and filing WOM/Labor/Financial/GL reports are financial tasks, not
  timekeeping ones), and **Audit Trail**. A section
  with only one tab behaves exactly as before (clicking it goes straight
  there); a section with more shows a second row of its own sub-tabs
  underneath, and remembers which sub-tab you were last on when you click
  back into it. No tab, route, or view was removed or renamed in the
  process -- purely a navigation-chrome change.
- **WOM Lookup**: a searchable "everything about one WOM" tool under the
  WOM section, open to technicians too (as an expandable "Details" row on
  their own read-only Locations & WOM list, `techHome.js`) since it's a
  lookup, not a management screen. A **location dropdown and a live text
  search** (by WOM # or project name) narrow the list down first -- a
  plain `<select>` can't be typed into to filter its own options, so the
  search box rebuilds the list as you type instead, same idea as the
  roster's own filters -- then picking a WOM shows its status, budget, and
  pricing (same data the admin's own WOM management screen already tracks)
  plus **every technician who's ever logged time against it and how much**
  -- `GET /api/woms/:code/lookup`, all-time across every week it's ever
  appeared on, not scoped to the current month the way most other views
  here are. This is the same all-time total the WOM's own budget math
  already used internally (`countWomAllocatedHours` in `server/data/db.js`)
  plus a new per-technician breakdown (`womHoursByTechnician`), just
  surfaced as its own lookup rather than buried in a budget-remaining
  calculation.
- **Smartsheet Line # and direct link on every synced WOM**: a WOM that
  syncs in without a real WOM # or description yet (a bare request row) used
  to be nearly impossible to trace back to the actual Smartsheet request --
  its only identifier was `smartsheet_row_id`, Smartsheet's own long opaque
  internal id with no relation to anything visible in the sheet itself.
  Every synced WOM now also carries `smartsheetLineNumber` (the small row
  number shown in the Smartsheet grid's own left-hand column -- "Line 42")
  and `smartsheetLink`, a direct **"Open in Smartsheet ↗"** link straight to
  that row in the Smartsheet web app (Smartsheet's own standard row-deep-
  link URL shape, built server-side from the sheet id this app is already
  configured with plus the row's internal id -- no extra API call needed).
  Both show up on the WOM Projects list, WOM Lookup, and PSE Tasks (below).
  Refreshed on every sync, so existing already-synced rows pick up their
  line number/link automatically the next time a sync touches them, not
  just newly-created ones.
- **PSE / PO pipeline ("PSE Tasks", under the Financials section)**: tracks
  a WOM through the real-world PSE-to-invoice workflow -- create WOM
  request (Smartsheet) &rarr; produce PSE &rarr; Toyota approval &rarr;
  issue WOM/PO &rarr; schedule work &rarr; check expenses &rarr; Status 95
  approval &rarr; invoice -- as a `pse_stage` field on the WOM, kept
  entirely separate from the existing `status` column (which still only
  ever gates whether a WOM can be allocated to; a WOM stays "open" for its
  entire time in this pipeline). A WOM auto-enters the pipeline at
  **Review & produce PSE** the moment it first syncs in from Smartsheet
  (never re-entered on a later sync, so progress already made is never
  reset). Two roles split the work, matching how this is actually done:
  - **Reviewer** (exactly one admin at a time, designated via a **"Set as
    reviewer"** toggle in Manage admin accounts on the Roster tab) --
    produces the PSE, liaises with Toyota, and approves Status 95.
  - **Financial** (any other active admin) -- generates the WOM/PO,
    monitors charges, and invoices.

  If nobody's been designated reviewer yet, every admin can act on every
  step, so the feature isn't locked up before that one-time setup. The full
  stage/action state machine (`PSE_STAGES`/`PSE_ACTIONS` in
  `server/data/db.js`, `PUT /api/woms/:code/pse/actions/:action`):

  | Stage | Owner | Action(s) that leave it |
  |---|---|---|
  | Review & produce PSE | Reviewer | PSE produced &rarr; sent to Toyota |
  | Awaiting Toyota approval | Reviewer | Approved &rarr; Generate WOM/PO; or snooze the follow-up |
  | Generate WOM / PO | Financial | Generated with PO in hand &rarr; Ready to schedule (or Blocked, see below); or generated but still missing the PO &rarr; back to Reviewer |
  | Awaiting Toyota PO # | Reviewer | PO received &rarr; Ready to schedule (or Blocked); or snooze the follow-up |
  | Blocked from scheduling (PO pending) | Reviewer | Clear the block &rarr; Ready to schedule |
  | Ready to schedule | *(technician, via Schedule/Tech Allocation)* | Marking the WOM complete auto-advances it |
  | Check expenses & invoicing | Financial | Sent for Status 95 approval (can be put **on hold** meanwhile -- see below) |
  | Sent for Status 95 approval | Reviewer | Approved &rarr; ready to invoice; or rejected ("not sufficient") &rarr; back to Check expenses |
  | Approved -- ready to invoice | Financial | Marked invoiced &rarr; **closed**, and the underlying WOM's own `status` flips to `invoiced` |

  A **"don't schedule until Toyota PO"** flag (settable at any stage before
  scheduling) routes a WOM to the reviewer's "Blocked" list instead of
  "Ready to schedule" once the WOM/PO is generated, for a job that
  shouldn't start until the real PO is confirmed. **Follow-up reminders**:
  entering "Awaiting Toyota approval" or "Awaiting Toyota PO #" sets a
  follow-up date 14 days out; a **"Still waiting"** button snoozes it
  another 30 days each time, so an approval that drags on keeps resurfacing
  rather than silently sitting untouched. **Hold reasons** (only while
  "Check expenses & invoicing"): vendor invoice pending, labor allocations
  pending, or a free-text "other" -- purely an annotation, doesn't change
  the stage, just flags the task as blocked rather than actionable right
  now. Every transition is audit-logged (`PSE_STAGE_ADVANCED`).
- **Task / workflow engine (Phase 1) -- "Priorities &rarr; My Work"**: a
  general-purpose task system built around one rule: **states create
  tasks, tasks create timestamps, timestamps create analytics.** Not a
  bolted-on to-do list -- WOM lifecycle changes, recurring admin
  responsibilities, and (later phases) vendor/financial exceptions all
  drive the same `tasks` table through one write path, so nothing has to
  be manually re-created every time something changes.
  - **One reusable board, not a page per employee** (`public/js/views/tasks.js`,
    mounted from both Priorities &rarr; My Work and the technician's own
    My Work tab): views are resolved server-side from who's asking
    (`GET /api/tasks?view=...`) --  a technician only ever sees their own
    assigned tasks plus their role's unclaimed queue (e.g. any open
    `tech`-role task); an admin sees everyone's by default and can filter
    by employee, role, location, WOM, vendor, category, due date, and
    status. Views: **My Work, Team Work, Overdue, Waiting, Workflow
    Exceptions, Recurring Tasks, Completed** (plus an admin-only
    **Unassigned**). A dashboard strip of tiles up top (Due Today,
    Overdue, High Priority, Waiting, Recurring, Workflow Exceptions) --
    click one to jump straight to that view.
  - **Every task carries**: title/description, assigned employee and/or
    role, category, priority, due date, status (`open` / `in_progress` /
    `waiting` / `completed` / `cancelled`), related WOM/vendor/location/
    technician/PO, source + source record id, the workflow rule that
    generated it (if any), and a full set of timestamps (created,
    assigned, started, completed, last status change) -- plus threaded
    comments. **Priority isn't purely manual**: a computed `urgency`
    (`computeTaskUrgency` in `server/routes/tasks.js`) bumps a task up for
    being overdue, flagged as a workflow exception, aging past 14 days, or
    due within 24 hours, regardless of its stored priority. **Emergency**
    is a fifth priority tier above Urgent (`low` / `normal` / `high` /
    `urgent` / `emergency`) for a hard-stop, drop-everything item (an urgent
    PO that just came in, etc.) -- it always reads as the top urgency
    tier no matter its due date, renders the *entire* task card as a solid
    red box (`.task-card-emergency` in `public/css/styles.css`, the same
    red-border-plus-tint treatment `.review-row-pending` already uses
    elsewhere) rather than just a colored badge, and always sorts to the
    top of every list regardless of due date.
  - **A WOM-workflow task's detail panel takes the real action, not a
    generic "mark complete."** Opening a task like "Produce PSE for X"
    fetches that WOM's live `pse_stage` and, if it has one, renders the
    actual PSE action buttons (mirroring `PSE_STAGE_ACTIONS` in
    `adminReview.js`'s own PSE Tasks tab, including hold reasons at
    Check expenses and the schedule-block toggle) -- clicking one calls
    the same `POST /api/woms/:code/pse/actions/:action` the dedicated
    Financials &rarr; PSE Tasks page uses, so it genuinely advances the
    WOM (which in turn completes the old task and creates the next one,
    per `syncPseStageTask`) instead of just closing the task card with
    nothing behind it. Falls back to the generic Start/Waiting/Complete/
    Cancel buttons for a stage with no PSE action of its own (e.g. a
    technician's "Schedule work" task at `ready_to_schedule`).
  - **No duplicate tasks, ever, no matter how many times a sync or action
    re-fires**: every automated task gets a deterministic `source_key`
    (e.g. `WOM-20528831-REVIEW-EXPENSES`) and is written through
    `upsertTaskBySourceKey` -- if that key already exists, its fields are
    refreshed in place (and it's reopened if it had been completed/
    cancelled, since the rule firing again means the work is genuinely
    back) rather than a second row ever being inserted. Recurring tasks
    pass `reopenIfClosed: false` instead, since re-upserting this week's
    already-completed task on the next page load must not silently
    un-complete it.
  - **WOM workflow rules, tied to the PSE pipeline's own stage changes**
    (`PSE_STAGE_TASKS`/`syncPseStageTask` in `server/data/db.js`, reusing
    the exact same `pse_stage` machine described above -- no separate
    "WOM missing a task" logic to keep in sync): entering **Review &
    produce PSE** creates the reviewer's produce-PSE task; **Generate WOM /
    PO** creates financial's create-WOM/PO task; **Ready to schedule**
    creates an unassigned `tech`-role "Schedule work" task any technician
    can pick up; marking work complete auto-completes that scheduling task
    and creates "Review expenses" (flagged as a **workflow exception**
    automatically while the WOM has an active hold reason -- re-evaluated
    live if a hold is set/cleared afterward, not just at task creation);
    **Approve for billing (Status 95)** and **Generate batch and bill
    Toyota** follow the same pattern through to invoicing, at which point
    every remaining task for that WOM is swept closed as a safety net.
  - **WOM status history** (`wom_status_history` table,
    `GET /api/woms/:code/history`, admin-only): every meaningful
    status/`pse_stage` change, recorded separately from the tasks
    themselves -- keeps both the real event time (`changed_at`, known for
    in-app actions) and when this app actually noticed it
    (`detected_at`, always known, since a Smartsheet sync is a manual,
    point-in-time pull) -- the raw material for later "how long does a
    project spend in each step" analytics without needing to reconstruct
    it from the tasks table.
  - **Recurring admin tasks**, not tied to any WOM (`ensureRecurringTasks`
    in `server/data/db.js`, called lazily whenever the task list loads --
    there's no cron/scheduler anywhere in this app): technician time
    allocation and final timecard review (weekly), AP open items
    (weekly), completed-WOM charge confirmation (biweekly), and open-PO/
    vendor-compliance cleanup (monthly) -- each keyed to its own period
    (e.g. the Monday of the current week) so it's a no-op once that
    period's task already exists.
  - **Smartsheet sync now reports what it actually changed downstream**:
    the sync panel persists a **"Last sync: &lt;when&gt; -- N WOMs
    updated, N tasks created, N tasks completed, N workflow exceptions"**
    line (`wom_sync_log` table, survives a page reload) with a **View Sync
    Details** toggle for the full breakdown -- diffed directly against the
    tasks table before/after that specific sync call, not inferred from
    WOM row counts.
  - **Manual tasks**: anyone can add one (a technician's own follow-up is
    force-assigned to themselves; only an admin can hand a task to someone
    else or drop it into a role queue with no owner yet), and everyone can
    comment on a task they can see. Every automated action is logged to
    the Audit Trail (`TASK_CREATED`, `TASK_COMPLETED`, `TASK_STATUS_CHANGED`,
    `TASK_REASSIGNED`, on top of the existing `WOM_STATUS_CHANGED`/
    `PSE_STAGE_ADVANCED`).
  - Deliberately **not yet built** (Phase 1 stops here by design, before
    the larger financial/vendor analytics pieces): vendor-triggered tasks,
    financial-module tasks/alerts, vendor profile analytics, the
    financial control-center fields, and bottleneck/lifecycle-duration
    analytics.
- **Priorities tab (admin)**: split into two sub-tabs -- **My Work** (the
  task engine above, now the default) and **Checklist** (everything below,
  unchanged). One calm, dedicated place gathering everything
  that needs a look -- outdated vendor forms, vendors with incomplete
  document checks, expiring/missing employee forms, technicians with zero
  UKG hours entered for the current week, pending weekend-hours addenda,
  punch issues reported by techs, WOM closures not yet reflected in
  Smartsheet, unverified PurelyHR time off, and trailing months with no
  report saved at all. Deliberately not
  more banners scattered across other tabs -- the only "in your face"
  surface is a small red count badge on the tab itself. That badge
  deliberately **excludes** the vendor document-checks-incomplete section:
  against a real, bulk-imported vendor list, "not yet checked" starts out
  true for nearly every vendor, so counting it in the badge would make the
  number reflect the size of that whole backlog rather than "a few things
  to look at today" -- it's still fully listed in its own section to work
  through at whatever pace makes sense, just not driving the badge. A
  **Today's focus** box at the top suggests a concrete daily target (try
  clearing 10 of however many outdated vendor/employee forms are
  outstanding) and calls out Mondays specifically (timecards + vendor case
  updates on ServiceEdge) -- fixed defaults for now, not yet
  admin-configurable goal numbers; see "Where this stands."
- **Short-hours flag, symmetric with the existing OT-not-on-WOM flag**: a
  week that comes in more than 3 hours under 40 (and has UKG hours entered
  at all, so this never fires on a week that's simply not been touched yet
  -- that's the separate "missing UKG" case above) now flags for RFM
  attention on Overview too, labeled distinctly ("short hours" vs. "OT not
  on WOM") since a week can only ever be one or the other. The technician
  sees the same two self-checks themselves, right on their own week, before
  they submit -- a dismissible nudge ("Was this approved by your RFM? Any
  additional WOM time to report?" for OT, or "Did you arrange to take these
  hours unpaid?" for a short week), not a submission gate. Answering "this
  is accurate" just tells them it'll show up flagged for RFM, since it
  already will via the same Overview mechanism -- it doesn't create a
  second, separate flag.
- **Admin succession**: each admin gets their own login (id + PIN) rather
  than sharing one account, via a small "Manage admin accounts" panel on
  the Technicians tab. Admins live in the same `technicians` table as
  everyone else (`role = 'admin'`), reusing the exact same active/inactive
  gate already built for technicians -- deactivating a departing admin's
  account blocks their login immediately without deleting anything or
  touching the audit trail, since every past entry already has that
  person's name baked into its details text at write time, not a live
  lookup. An admin can't deactivate their own account (the one guard that
  matters -- since only an active admin can reach this endpoint at all,
  and they can't touch their own account, there's always at least one
  active admin left after any call). An admin account's **name can be
  renamed** from that same panel (`PATCH /api/admin/admins/:id/name`,
  audit-logged as `ADMIN_RENAMED`) -- a legal name change, a typo at
  creation, or a seeded demo name that never got updated to whoever's
  actually using the account. Renaming yourself updates the stored session
  (`setUser` in `app.js`) so it's correct on the next reload/login; the
  header text on screen at the moment of the rename itself doesn't
  live-refresh (it's only drawn once per page load). The same panel also
  has a **"Set as reviewer" / "Reviewer -- remove"** toggle per admin,
  designating who plays the "reviewer" role in the PSE pipeline (see PSE
  Tasks below) -- only one at a time, enforced server-side
  (`PATCH /api/admin/admins/:id/pse-reviewer`).
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
  - Devices — Phone, iPad, or Laptop, each with its identifier (phone
    number, iPad #, or an asset tag/serial for a laptop), an optional
    **plan** (e.g. a phone's carrier plan), and notes. Each device also has
    its own small **IT Requests** log (e.g. a Calero line cancellation): a
    request type + reference number that can be marked completed and
    reopened, and edited after the fact (e.g. to correct or fill in a
    reference number once the vendor provides it), so a pending vendor
    request doesn't get lost track of
  - Forms on File — file attachments like the others, but with two extra
    fields for a form/certification: a **type** (e.g. "Forklift License")
    and an **expiration date**. A form past (or close to) its expiration
    date shows an Expired/Expiring badge here, and also surfaces in a
    dedicated banner at the top of the admin's **Overview** tab ("Forms &
    certifications needing attention") so it doesn't just sit unnoticed on
    an individual profile — a "View" link jumps straight to that
    technician's Forms on File tab
  - Documents — general file attachments, same mechanism as WOM docs but
    with no type/expiration tracking
- **Add technician**: a form on the roster (ID, name, PIN, position,
  home location, contact info, and an optional start date) creates a new
  technician who can log in immediately. This is the one-at-a-time form;
  see **Bulk add technicians** right below for onboarding several at once
  (a shorter, paste-based set of fields -- no PIN or start date entry, since
  those aren't practical to type per row for a whole roster).
- **Terminate employee**: a one-click quick action right on the roster
  toolbar next to + Add technician (same pop-up pattern), for the common
  "this person is leaving" case without having to open their full profile,
  find Basic Info, and change the status dropdown there (that path still
  works too, e.g. to un-terminate someone or edit other fields at the same
  time). Picks an employee (anyone not already terminated) and a
  termination date, then sets both the date and employment status in one
  step -- carries the technician's other Basic Info fields (email, phone,
  position, etc.) through unchanged rather than blanking them, since the
  underlying `basic-info` endpoint replaces that whole field set at once.
- **Typeable MM/DD/YYYY date fields, not native date pickers**: every date
  field a person actually fills in by hand (a new technician's start date,
  Basic Info's hire/termination dates, the Schedule tab's date range) is a
  plain text input with a slash-auto-inserting mask instead of a native
  `<input type="date">`, which forces month/day/year to be clicked and set
  as three separate segments and can't take a pasted or fully-typed date in
  one go. Typing all 8 digits in one go (`09252026`) or pasting an already-
  slashed date works the same way; the small shared helper
  (`public/js/dateMask.js` -- `wireDateMaskInput`/`isoFromUs`/`usFromIso`)
  converts to/from the app's own `YYYY-MM-DD` at the API boundary, so
  nothing server-side changed. An incomplete or malformed date shows a
  plain validation message rather than silently being sent as garbage.
- **Bulk add technicians**: for onboarding a whole real roster at once
  instead of one form per person. Paste one technician per line — `ID,
  Name, Position, Email, Location code` (tab or comma separated; a
  straight paste from a spreadsheet column selection works), location
  code optional — and `POST /api/admin/technicians/bulk` creates all of
  them, generating a random 4-digit PIN for each row rather than making
  anyone type one in. The response is the *only* place those PINs are ever
  shown — same as any password, there's no way to look one back up
  afterward — so the UI's result table has a **Copy list** button and a
  reminder to save it immediately. A bad row (missing id/name, a duplicate
  ID, an unknown location code) is skipped with its own per-row error
  rather than failing the whole batch, so one typo doesn't block everyone
  else in the paste.
- **Admin PIN reset**: a **Reset PIN** button on a technician's own profile
  (next to Delete) issues them a brand-new random PIN on demand —
  `POST /api/admin/technicians/:id/reset-pin`, admin-only, logged to the
  audit trail as `PIN_RESET` every time it's used — for when a technician
  calls in having forgotten theirs. There's deliberately no way to read
  back their *current* PIN (it's hashed one-way, same as any real password,
  and stays that way — see "Where this stands" for why that matters given
  the compliance-sensitive vendor documents gated behind this same login):
  resetting invalidates the old PIN and shows the new one once, right there
  on screen, for admin to relay — never baked into the roster or profile
  payload, and dismissed again on a second click so it isn't left sitting
  on screen. PINs are also never shown anywhere on the public login page
  itself — that used to carry a "Demo logins" hint with real technician IDs
  and PINs in plain sight of anyone who visited the site unauthenticated;
  it's been removed now that this is in real use, not just a demo.
- **Delete technician**: for one created by mistake — a test entry, real
  data typed into the wrong row — rather than leaving it under some
  employment status forever (own **Delete** button on the technician's
  profile, admin-only, `DELETE /api/admin/technicians/:id`). Blocked with a
  409 if they have any allocated hours on record; forcing it through
  removes that whole history along with them (allocations, UKG hours,
  weeks, onboarding progress, devices/device requests, any active session)
  but never their uploaded files/forms, same as a WOM's own documents
  surviving a WOM delete — those aren't the technician's identity, just
  attachments. Never touches an admin account; this only ever looks at
  `role = 'tech'` rows, same as every other `/technicians/:id` route.
- **Delete location**: same idea, but with no force option — a location in
  use by a whole set of technicians/WOMs/allocations is too large a blast
  radius for one confirm click, so it's blocked outright (409, naming
  exactly how many of each) until those are reassigned elsewhere first
  (`DELETE /api/locations/:code`, admin-only).
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
  until an admin rejects or unlocks it. **Unlock works on a merely-submitted
  week, not just an approved one** — the case that matters is admin
  correcting a technician's UKG hours after they've already submitted but
  before anyone's approved it, which used to leave the week stuck mismatched
  with no way back in (Reject would bounce it to the technician instead of
  letting admin fix it directly)
- **Weekend hours addendum**: if a technician gets called in over the
  weekend on a week that's already submitted/approved, they can still log
  Saturday/Sunday hours directly on their locked week — no unlock needed,
  and the hours don't have to match UKG at save time, since the technician
  just logs what they worked and admin true's it up at review time.
  Deliberately its own **Weekend hours** box (accent-bordered, own "Save
  weekend hours" button) placed right after the status banner — above the
  Mon-Fri grid, not buried in it and not at the bottom of the page — since
  this is meant to feel like a distinct add-on for an unplanned callout, not
  just another day card, and a technician shouldn't have to scroll past a
  whole locked week to find where to log it. Saving flags the week (a red
  "Weekend hours added -- needs review" banner on the admin's **Overview**
  tab, with a "View" link) so admin knows to look. **Correcting and
  accepting are one step, right on Weekly Review**: the flagged row there
  shows the actual Sat/Sun entries inline — allocation, accounting code, and
  an editable hours field — so admin can fix the hours to match UKG's actual
  time (if needed) and click **Accept weekend hours** in a single action.
  That one click both saves the correction and clears the flag; it never
  bounces anything back to the technician for their own re-approval, and
  never requires a separate "acknowledge" click or a detour to Tech
  Allocation. The underlying week status (draft/submitted/approved) never
  changes as part of any of this — it's a separate flag, not a status
  transition. **Accepting also defaults that day's UKG hours (from
  timesheet) to match** — otherwise the allocated total would jump by the
  accepted hours while UKG stayed at 0, leaving the row looking unbalanced
  until admin remembered to separately retype the same number into the UKG
  hours field. It's still just a default: the UKG hours form is always
  editable regardless of week status (never gated by the lock, on the
  client or the server), so admin can adjust it further once the real UKG
  punch is keyed in and comes out slightly different.
- **Sat/Sun don't have to match UKG hours to submit, even on a still-open
  week** — the same leniency as the weekend addendum above, just for the
  ordinary case where a technician gets called in on a weekend during a
  week that hasn't been submitted yet and UKG hasn't caught up (or picks up
  hours in odd non-15-minute punch times). Monday–Friday still has to
  balance exactly; only the weekend days are exempt from the check, both in
  the "Submit for review" button's enabled state and on the server. Admin's
  normal approve step is unaffected — a technician submits and admin
  approves through the exact same flow either way, no separate action
  needed for a weekend callout in an open week
- **Hours fields keep the cursor where you left it and no fixed step
  interval.** Every allocation edit re-renders the whole day grid live (to
  keep balance pills/totals/remaining-hours current), which used to fight
  with typing into an hours box mid-keystroke — losing focus, resetting the
  page's scroll position, and (since these were HTML number inputs)
  restricting values to quarter-hour steps and blocking the browser's own
  cursor-selection API. Fixed by switching these to plain text inputs
  (`inputmode="decimal"` for a numeric keyboard on mobile) with no step
  restriction at all — a WOM charged only its share of overtime can be
  something like 5h4m (5.07h), and there's no reason that should be hard to
  type — plus a small focus-preservation mechanism in `techWeek.js` that
  remembers which field (and exact cursor position) was focused before a
  re-render and restores both afterward, so the page never jumps and typing
  never gets interrupted. Clicking into a field also selects its whole
  current value, so typing immediately overwrites it instead of inserting
  wherever the cursor lands
- **A WOM that's closed after being picked no longer looks like a live
  selection.** A split row's WOM dropdown only ever listed *open* WOMs at
  that location — if the WOM you'd already picked was later closed or
  invoiced by someone else, it silently vanished from the list and the
  `<select>` fell back to showing whatever open WOM happened to be listed
  first, while the actual saved allocation still pointed at the closed one.
  That mismatch was only surfaced at submit time, as a generic "WOM ...
  is not open" error with no visual cue for which row caused it. Now the
  stale WOM stays visible in its own row's dropdown (disabled, labeled
  "closed — choose another"), with a red inline warning right under that
  row, so the discrepancy is obvious and localized instead of a mystery
  error after clicking Submit
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
    WOM (Documents panel on admin's E&F Locations & WOM tab)
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
Number *and* WOM Job Number (both from the JDE location lookup table) and a
Region label (e.g. "Southeast", "Region 1") used to match the location up
against the monthly labor-report/financial file. E&F general time itself
always posts to a single standard subsidiary/service code — `20920000` — the
same at every location; that's a fixed constant (`EF_SUBSIDIARY_CODE` in
`server/routes/locations.js`), not per-location data, and is surfaced to the
client as `efSubsidiaryCode` on every location so it's visible without being
editable. WOM projects are different: each WOM has its *own* subsidiary code
that varies project to project, entered by an admin when the WOM is created
or edited. All of this is managed from the **"E&F Locations & WOM"** tab
(named for what it actually covers, not just WOM status), which has a
Locations section above the WOM list (add/edit a location's name, E&F Job
Number, WOM Job Number, and Region) and lets the WOM add form and each WOM
row's Edit button set/change the subsidiary code.

A day's actual accounting code (Job Number + subsidiary code, e.g.
`100110042963.20920000` for E&F or `100110007530.20520001` for a WOM) is
computed and shown per allocation row when a technician's week is expanded
on Weekly Review — an "Accounting Code" column next to Day/Allocation/Hours,
so you can see exactly what a submitted day will post to without needing to
cross-reference the WOM Status list separately. It shows `?` in place of
whichever number (job number or subsidiary code) hasn't been entered yet, so
a missing code is obvious rather than silently blank.

**Task engine tables.** `tasks` (one row per task, every field the Priorities
board reads/filters on -- see the task-engine feature bullet above for the
full field list), `task_comments` (threaded notes on a task), `wom_status_history`
(every meaningful WOM `status`/`pse_stage` change, kept separately from the
tasks it drives so it survives independently of whatever task currently
exists for that state), and `wom_sync_log` (one row per Smartsheet sync,
backing the sync panel's persisted "Last sync" summary). None of this
replaces or restructures any existing table -- `tasks.related_wom_code` etc.
just reference the existing `woms`/`vendors`/`locations`/`technicians` rows
by their existing keys.

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
  (`server/utils/password.js`) -- there is deliberately no reversible copy
  anywhere, so a stolen database yields only unusable hashes, never a real
  PIN. (An earlier draft of this feature added a decryptable copy so admin
  could look a PIN back up; that was reverted before it shipped, in favor of
  a PIN *reset* instead -- see **Admin PIN reset** above -- since this login
  also gates the compliance-sensitive vendor documents in "Vendor documents"
  below, and a recoverable PIN would have weakened that.) Repeated wrong-PIN
  attempts lock out for 15 minutes (`server/routes/auth.js`). What's still
  missing: the site is served
  over plain HTTP, so credentials and data travel unencrypted over the
  network. Real HTTPS needs a domain name pointed at the droplet's IP (a
  bare IP can't get a trusted certificate) — a separate decision still ahead.
- **Vendor documents (COI/W-9/ACH, which can carry bank routing/account
  numbers and tax IDs) are already access-controlled at the application
  layer** — `server/routes/files.js`'s `canRead`/`canWrite` refuse any
  non-admin for `relatedType: "vendor"` outright (a technician can look up
  a vendor's active/contact info via the separate `/api/vendors` endpoint,
  but never sees or downloads its files), every file route requires a
  valid session token, and there's no public/unauthenticated route that
  serves uploaded files at all — nothing is reachable by just guessing a
  URL. What that access control doesn't cover is the **network** it
  travels over: see the HTTPS gap directly above. Until that's closed,
  anyone positioned to intercept traffic between a browser and the droplet
  (the same public wifi, a compromised router, etc.) could read a session
  token or a downloaded file's bytes in transit, even though they still
  couldn't just browse to it unauthenticated. Practically: **put a domain
  in front of the droplet and get it a free Let's Encrypt certificate**
  (e.g. via `certbot --nginx` once a reverse proxy is added, or a
  DigitalOcean App Platform / Cloudflare tunnel in front of it) before
  onboarding real ACH numbers — that one change closes the actual gap here.
  Everything else (hashed PINs, session-based auth, admin-only file access)
  is already in place and doesn't change with that migration.
- **PINs are still short (4 digits).** Hashing protects them if the database
  ever leaked; it doesn't make a 4-digit PIN itself less guessable. The
  rate-limit is what actually prevents brute-forcing it online. Worth moving
  to longer PINs or real passwords before this holds anything sensitive.
- **The Priorities tab's daily-focus goal numbers are fixed constants (10),
  not admin-configurable.** `DAILY_GOAL_TARGET` in `adminReview.js` — the
  suggestion text is generated from real backlog counts, but the "try
  clearing 10 today" target itself is hardcoded, not a setting you can
  change per admin or over time. A small settings form is the natural next
  step if 10 turns out to be the wrong number for either category.
- **The Schedule tab has no real Microsoft Teams/Outlook connection.** It
  shows what's allocated in this app, not a technician's actual calendar --
  so it can't yet prevent a real double-booking against a meeting or
  commitment that only exists in Teams. Building that would need: an Azure
  AD app registration (your Microsoft 365 admin's approval), Graph API
  read access to calendars/shifts (delegated or application permissions,
  whichever your IT prefers), and a decision on how to show "busy" time
  from Teams without necessarily exposing what the appointment is about
  (a free/busy overlay rather than pulling actual event titles/details is
  usually the least-invasive way to do this). None of that is wired up —
  today's grid is a same-system-visibility tool, not a real
  availability check.
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
- **OT Trends' "Rising/Falling/Steady" is a simple heuristic, not a
  statistical trend line.** It compares the average of the first half of the
  8-week window to the second half's average (more than half an hour apart
  either way calls it rising/falling) — good enough to eyeball a pattern,
  not a forecast. The window length is also a named constant
  (`OT_TREND_WEEKS`) if 8 weeks isn't the right lookback.
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
- **The WOM photo prompt is a one-time nudge, not enforcement.** It's
  dismissible for the current visit (dismiss it and it won't reappear until
  the page is reloaded) and fully skippable — nothing blocks Submit if no
  photo is ever added. If photos ever need to be mandatory for certain WOMs,
  that needs a real requirement check, not just a prompt.
- **Expiring-forms flag is visual only, not a notification.** It shows up in
  the Overview banner and on the form's own row whenever an admin happens to
  load that screen — there's no email/text alert sent when a form actually
  crosses its expiration date, and no daily digest. The warning window is a
  named constant (`FORM_EXPIRY_WARNING_DAYS` in `server/routes/admin.js`,
  currently 30 days) if that lead time needs to change. The email
  infrastructure now exists (`server/utils/mailer.js`, see below) if this
  ever needs a real email/SMS alert too — it just isn't wired up for it yet.
- **Email notifications need SMTP credentials to actually send anything.**
  Until then, `server/utils/mailer.js` just logs what it would have sent and
  the technician only ever sees the in-app note — nothing breaks, nothing
  silently lies about having emailed someone. To turn real email on, set
  these environment variables before starting the app (e.g. in the
  systemd service file, or a `.env` loaded by your process manager):
  `SMTP_HOST`, `SMTP_PORT` (defaults to 587), `SMTP_USER`, `SMTP_PASS`, and
  optionally `SMTP_FROM` (defaults to `SMTP_USER`). Any SMTP provider works
  (a Microsoft 365/Google Workspace mailbox's SMTP settings, or a
  transactional provider like SendGrid) — this app doesn't care which, it
  just needs standard SMTP auth.
- **Smartsheet connection: read-only pull that creates, promotes, and prices
  WOMs from the external PSE tracker.** `server/utils/smartsheet.js` is a
  thin, opt-in client (same no-crash-until-configured pattern as the mailer
  above) for a one-way pull from a single Smartsheet sheet — the external
  WOM/PSE project tracker. Set two environment variables before starting the
  app: `SMARTSHEET_API_TOKEN` (a personal access token — in Smartsheet, click
  your account icon → **Apps & Integrations** → **API Access** → **Generate
  new access token**; it's shown once, so copy it immediately) and
  `SMARTSHEET_SHEET_ID` (the numeric ID of the specific sheet — visible via
  the sheet's own **File → Properties**, or by right-clicking the sheet tab).
  **Never paste the access token into a chat, an email, or anywhere outside
  the server's own environment** — treat it exactly like a password, since
  anyone who has it can read (and, depending on the token's own permissions,
  possibly edit) every sheet it can see. Set both on the server itself (the
  systemd service file, or a `.env` your process manager loads), the same
  way the SMTP credentials above are set, then restart the app.
  The **E&F Locations & WOM tab** shows a "Smartsheet Connection" panel
  with a **Preview data** button (the sheet's real column names and first 5
  rows, useful for confirming the connection and checking column names) and
  a **Sync WOMs from Smartsheet** button. Per the real PSE process (a
  Smartsheet row exists from the initial request onward but doesn't get a
  real WOM # until admin actually creates the WOM and issues the PO — steps
  1–8 vs. step 9 onward), a sync no longer just matches existing WOMs — it
  keeps every sheet row in step with this app's own record of it:
  - A row whose **`WOM #`** column already has a real value creates (or
    updates) an **open** WOM using that number as the code — a real job
    exists and it can actually be billed to Toyota, so this is the only
    status a technician can allocate hours against.
  - A row with a blank or `0` WOM # but whose **`Date Requested`** column (or
    however the sheet spells it — see below) has something in it creates a
    **requested** WOM instead (code `PENDING-<smartsheet row id>`, e.g.
    `PENDING-501`): RFM has asked Toyota to generate the WOM/PO, but there's
    no real number yet, so nothing can be billed to Toyota for it — a
    technician still can't allocate against it.
  - A row with neither a WOM # nor a Date Requested yet creates a **pending**
    WOM (same `PENDING-...` code scheme) — RFM hasn't asked Toyota for
    anything yet.
  - Both `pending` and `requested` are invisible to technicians (they fail
    the same "must be open" check every other non-open WOM does when a
    technician tries to allocate against it) and don't count toward the
    admin Priorities badge. Only `pending` shows up in its own **"WOM
    requests not yet sent to Toyota"** Priorities section — a `requested` one
    doesn't need an RFM decision anymore, it's just waiting on Toyota, so it
    only shows in the plain WOM list with its own status badge.
  - Sync tracks each row by Smartsheet's own row id (not the WOM # cell), so
    a `pending` row whose Date Requested gets filled in later is bumped to
    `requested` in place (same code), and when either one's request is later
    approved and gets a real WOM # assigned, the *same* WOM record is renamed
    and promoted to `open` — it's never duplicated, and the old
    `PENDING-...` code disappears. All of this happens automatically from
    the sheet's own columns; nothing here is a manual status flip.
  - A row that's already synced before just gets its `estimatedPrice` /
    `appliedPrice` refreshed. A sync **never overwrites a status an admin
    set by hand** here (e.g. `closed`) back to `open`, `requested`, or
    `pending`.
  A sync never writes anything back to Smartsheet — it only ever reads. Every
  column is located by keyword (`findColumn` in `smartsheet.js`, tolerant of
  the sheet's exact punctuation rather than a hardcoded literal string) — the
  two dollar columns by "estimate"/"wom"/"$" or "applied"/"wom"/"$", the
  description by "project"/"name", the requested-status column by
  "date"/"requested" (matches the real tracker's own `Date Requested (Auto)`
  column, filled in automatically there when RFM checks its `Order WOM/PO`
  box), the Maximo work order # by "maximo", and the JDE subsidiary/service
  code by "subsid"/"code" — deliberately the truncated root "subsid" rather
  than "subsidiary", since the real tracker's own column is spelled
  "Subsidary Code" (missing the second "i"); "subsid" matches both the
  correct and the misspelled version, so a later fix to the sheet's spelling
  wouldn't break the match either way (a real column on the tracker in its
  own right — pulled in as-is, not derived from anything). **Location is the one
  exception**: the sheet only has a plain site name ("Site Location"), no
  notion of this app's own location codes, so it's matched by name against
  `db.listLocations()` — an exact case-insensitive match first, then
  tolerant of a shortened form either direction (the sheet often drops a
  suffix, e.g. "NAPCK" for "NAPCK Georgetown"). No match means the site
  likely doesn't exist here yet, so it's left null rather than guessed at —
  and once a location is matched once, a later sync never overwrites it (in
  case that guess needs a manual correction). This location match matters
  for billing, not just display: a WOM's own accounting code is its
  location's **WOM Job Number** + that WOM's own subsidiary code — a
  completely different code from the same location's E&F Job Number, since
  WOM work is Toyota-billed and E&F is this contract's own yearly budget
  (see `accountingCode` in `adminReview.js`). If no column matches
  "date"/"requested", every not-yet-open row just stays `pending` — sync
  still works, it just can't tell `pending` and `requested` apart.
  **Every other column on the tracker** — every estimate/applied line item
  (labor, materials, contracted services, other direct costs, sales tax,
  contingency), PO numbers, invoice/batch tracking, RFM/PSE approval flags,
  whatever else is there — is kept too, verbatim, as one JSON blob
  (`smartsheet_raw_data`) rather than a dedicated database column per field;
  most of the ~75 columns on the real tracker will only ever matter for a
  handful of WOMs, and the sheet gains new columns over time. The WOM
  Projects tab has a **"Smartsheet detail"** button on any row a sync has
  touched, showing every column/value pair from that row's own last sync —
  covers "I want to see every column" without a schema change every time
  the sheet grows one. A WOM without a Smartsheet match yet can still have
  pricing hand-entered (`PATCH /api/woms/:code/pricing`) — a later sync
  overwrites both fields once that WOM code is found there, since they're meant to
  mirror Smartsheet once a match exists, not be independently maintained
  here. **Admin-triggered for now, not on a schedule** — click "Sync WOMs
  from Smartsheet" whenever you want the latest numbers; automatic periodic
  syncing is a natural next step once this has been used successfully a few
  times.
- **SMS was considered but isn't built.** It needs a paid third-party
  provider (e.g. Twilio) and a phone number on file for every technician —
  a bigger decision than email, which most workplaces already have
  infrastructure for. Easy to add later behind the same
  `notification_pref` field (just another option alongside `email`) if it
  turns out to matter more than email in practice.
- **Vendor statuses are a simplified read on messy source data.** The
  imported tracker's "Current Use Status" column was really free text with
  ~50 slightly different phrasings of the same handful of states (typos,
  inconsistent capitalization, etc.) — the import script normalizes that
  into the three clean statuses the app actually uses, but the original
  text is preserved per vendor (`rawStatusText`, shown under "Original
  tracker status text" when editing) in case a normalization guess turns
  out wrong and needs a human to double check it. "Forms Outdated" is only
  ever set when the original text said so explicitly; there's no positive
  "forms confirmed current" signal in the source data, so most vendors show
  "Forms Unknown" until someone actually verifies and updates them.
- **Vendor search/filtering is entirely client-side.** With ~300 vendors
  that's instant either way, but if this list grows into the thousands,
  the search would want to move server-side (SQL `LIKE`/status filtering
  in `server/routes/vendors.js`) rather than shipping the whole table to
  the browser on every visit.
- **The technician's read-only Locations & WOM tab deliberately hides JDE
  accounting codes.** It shows location name/region and WOM code/
  description/location/status/budget — not E&F/WOM Job Numbers or
  subsidiary codes, which are internal accounting data with no bearing on
  a technician's own work. If that turns out to be wanted after all, it's
  a small addition to `techHome.js`'s read-only rendering (the data is
  already tech-readable via the same `/api/locations`/`/api/woms`
  endpoints admin uses — this is a display choice, not a permission one).
- **"Invoiced" as a WOM status was a judgment call, not a spec you gave
  us.** The three-state Open/Invoiced/Closed lifecycle assumes a
  technician's own "mark complete" action should still set a WOM straight
  to Closed (unchanged from before) while Invoiced is purely an
  admin-driven middle state for tracking billing progress independently.
  If the intent was instead for tech-complete to land on Invoiced (pending
  admin's own close-out), that's a one-line change in
  `server/routes/woms.js`'s `/:code/complete` handler.
- **Reports is storage only — there's no comparison logic yet.** It
  saves the monthly file finance sends (WOM/Labor/Financial/GL, each in
  its own section) so it's kept next to the timesheeting for that period;
  nothing in the app reads its contents or checks it against tracked hours.
  The real labor report (seen live use)
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
    technicians.js        GET/PUT/POST week + allocations + submit (per-day validation),
                              PUT schedule-wom (Schedule tab: one day's WOM entry, ignores the
                              week's own edit lock/window entirely -- only the WOM's own open
                              status still blocks it, and only that one day is ever touched),
                              PUT weekend-allocations (Sat/Sun addendum on a locked week),
                              POST accept-weekend-hours (admin-only: correct + accept in one step),
                              POST report-punch-issue (tech or admin flags a day, optional note),
                              POST resolve-punch-issue (admin-only: correct one day's hours +
                              allocation and clear the flag, without unlocking the rest of the week)
    woms.js               GET/POST/PATCH WOM list + status + :code/details (subsidiary code etc.),
                              :code/pricing (hand-entered estimated/applied $, overwritten by a
                              later Smartsheet sync), GET :code/lookup (WOM Lookup: all-time total
                              hours + a per-technician breakdown, open to any logged-in user),
                              POST :code/complete (tech-facing, also advances the PSE pipeline if
                              the WOM was ready_to_schedule -- see advancePseOnComplete),
                              GET pse/tasks (admin-only, role-filtered PSE pipeline task list),
                              POST :code/pse/actions/:action (admin-only, the state machine's own
                              stage transitions), POST :code/pse/hold (vendor_invoice/
                              labor_allocations/other, admin-only), POST :code/pse/schedule-block
                              ("don't schedule until Toyota PO" flag, admin-only),
                              GET :code/history (admin-only, the wom_status_history rows behind
                              the task engine's WOM-triggered tasks -- every status/pse_stage
                              change with both real event time and detected-by-this-app time),
                              DELETE :code (admin-only, blocked if hours are already allocated
                              against it unless force is passed)
    admin.js               Weekly review + Overview report, ot-trends (trailing-8-week OT
                              pattern), UKG hours, pending-punch flag, UKG-confirmed checklist,
                              roster, profile (basic info, onboarding, devices + IT requests,
                              allocation history, expiring-forms list), approve/reject/unlock
                              (works on submitted OR approved), weekend-addenda list +
                              acknowledge-weekend, punch-issues list (tech-reported only),
                              smartsheet/status (now includes lastSync, the persisted
                              wom_sync_log row behind the sync panel's "Last sync: ..." line) +
                              smartsheet/preview (read-only sheet preview),
                              smartsheet/sync-woms (creates open WOMs from rows with a real
                              WOM #, pending/requested WOMs from rows without one yet based on
                              whether Date Requested is filled in, promotes a pending or requested
                              WOM once its row gets a real WOM #, refreshes estimated/applied
                              pricing/Maximo #/subsidiary code on every synced WOM, matches +
                              fills in location by name, once, on any WOM missing one, and now
                              also diffs the tasks table before/after to report + persist how
                              many tasks that sync created/completed and how many workflow
                              exceptions it flagged), technicians/bulk
                              (paste-many technician creation, one generated PIN per row, per-row errors),
                              POST technicians/:id/reset-pin (issues + returns a brand-new random PIN,
                              audit-logged as PIN_RESET -- no way to read back the current one),
                              DELETE technicians/:id (blocked if hours are allocated unless force is passed)
    locations.js             GET (any user) / POST+PATCH (admin) locations, incl. E&F/WOM Job
                              Numbers, Region, and the standard EF_SUBSIDIARY_CODE constant; DELETE
                              (admin-only, blocked outright -- no force -- if still referenced by any
                              technician/WOM/allocation)
    audit.js                  Audit log
    files.js                   Upload/list/download/delete attachments (week/wom/technician/labor_report),
                                  incl. formType/expiresAt for tech_form uploads
    vendors.js                  GET/POST/PATCH/DELETE vendor onboarding/compliance records (admin-only)
    schedule.js                  GET /:month -- read-only WOM-only month calendar, by actual date (any logged-in
                                     user), optional ?location=CODE filter, each entry carries its WOM's own
                                     status/budget/pricing detail for click-to-view on the client
    tasks.js                       GET / (?view=my|team|unassigned|overdue|waiting|exceptions|recurring|completed,
                                       plus admin-only ?assignedTo/role/location/wom/vendor/category/dueDate/status
                                       filters -- server resolves the viewer's own role/identity scope, see
                                       rolesForViewer), GET /summary (dashboard tile counts), GET /:id (with
                                       comments), POST / (manual creation -- a technician is force-assigned to
                                       themselves), PATCH /:id/status, PATCH /:id/assign (admin-only),
                                       POST /:id/comments -- see server/data/db.js's task-engine section
                                       (createTask/upsertTaskBySourceKey/listTasks/etc.) for the actual writes
  utils/
    week.js                Mon–Sun week date helpers, business-timezone edit window
                              (classifyWeekForTech / getOpenWeekMonday)
    password.js             scrypt PIN hashing (hashPin/verifyPin) -- one-way only, no reversible copy
    allocation.js            presentAllocation: translates a stored timeoff row's shape for API responses
    receipt.js               Server-side copy of the Reg/OT computeReceipt calculation (admin Overview)
    mailer.js                 Opt-in SMTP email (no-op until SMTP_* env vars are set) for the
                                 "your hours are ready" notification
    smartsheet.js              Opt-in, read-only Smartsheet client (no-op until
                                  SMARTSHEET_API_TOKEN/SMARTSHEET_SHEET_ID are set) --
                                  fetchSheet/fetchSimplifiedSheet/simplifySheet
scripts/
  deploy.sh               One-shot droplet setup: Node 22, app, systemd service, firewall
  import-vendors.js         One-time/repeatable bulk import of vendor records from a JSON
                               file into the live database (see the Vendors feature above)
tests/
  helpers.js              Spins up an isolated app instance per test file; logs in for real tokens
  auth.test.js             Login, sessions, impersonation-is-blocked, rate limiting, logout
  allocation.test.js       Hour validation, WOM gating, locking, Sat/Sun exempt from the
                              UKG-match check at submit time, schedule-wom ignores the week
                              lock (still rejects a closed WOM, day-scoped only, 403 for
                              another technician)
  admin.test.js             Approve / reject / unlock (incl. on a merely-submitted week),
                              Overview report OT-flagging, ot-trends, UKG-confirmed checklist,
                              pending-punch flag, weekend hours addendum (log without
                              unlocking, no UKG-match required, admin adjust + acknowledge),
                              accept-weekend-hours (admin-only correct + accept in one step,
                              rejects with no pending addendum, rejects a weekday payload),
                              punch issues (tech reports with a note, shows up in
                              admin's punch-issues list, admin-only resolve corrects the
                              day's hours + allocation and clears the flag without
                              unlocking the rest of an approved week), short-hours flag
                              (symmetric with OT, excluded from OT trends),
                              missing-UKG list, report-gap months, admin account
                              create/deactivate/self-deactivation-blocked/rename (logged to
                              the audit trail, rejects an empty name, 404 unknown, 403 for a
                              technician), PurelyHR verification (hasTimeOff, set/unset,
                              cleared on edit, submitted/approved + time-off required)
  weekWindow.test.js         Edit-window classification + PUT/POST enforcement (open/past/future/gap)
  woms.test.js               WOM CRUD + authorization, WOM Lookup (all-time hours by
                                 technician, 404 for an unknown WOM), subsidiary code,
                                 location E&F/WOM Job Number/Region,
                                 Smartsheet-reflected flag (set on close, cleared on reopen, admin-only),
                                 cancelling a WOM blocks technician allocation same as any non-open status,
                                 deleting a WOM (admin-only, 404 unknown, blocked with allocated hours
                                 unless forced, force removes those allocations too), deleting a location
                                 (admin-only, 404 unknown, blocked outright -- naming every technician/
                                 WOM/allocation still pointing at it -- with no force option)
  schedule.test.js               WOM-only month calendar: auth required, malformed-month rejected,
                                    tech-visible, E&F/time-off excluded, correct calendar date,
                                    inactive techs excluded, entries carry WOM detail for the
                                    click-to-view panel, ?location= filter narrows to one site
  roster.test.js              Basic info, onboarding, devices (incl. iPad + plan) + IT requests
                                 (add/complete/edit), notification-pref, allocation history,
                                 creating a technician (with an optional start date; malformed
                                 date rejected), bulk-create technicians (admin-only, generated
                                 PIN actually logs in, bad rows skipped with their own error, 400
                                 if all rows fail),
                                 admin PIN reset (new PIN logs in, old one no longer does, logged
                                 to the audit trail, 403 for a technician, 404 for an unknown id),
                                 deleting a technician (admin-only, 404 unknown, blocked with
                                 allocated hours unless forced, force clears that history --
                                 usedHours drops with it -- and never touches an admin account)
  files.test.js                 Upload/list/download/delete authorization, labor_report admin-only,
                                    tech_form type/expiration + admin expiring-forms list
  vendors.test.js                 Vendor CRUD + authorization + audit logging
  audit.test.js                   Audit log writes and admin-only read access
  mailer.test.js                   Email is a safe no-op (not a crash) when SMTP isn't configured
  smartsheet.test.js                 simplifySheet's column-id-to-title reshaping, findColumn's
                                        keyword tolerance, safe 409 (not a crash) when Smartsheet
                                        isn't configured, admin-only
  smartsheetSync.test.js               WOM sync: a real-WOM# row creates an open WOM, a blank/"0"
                                        WOM# row creates a pending WOM invisible to techs, its own
                                        Date Requested column filling in later bumps it to requested
                                        (still invisible to techs) automatically, a pending or
                                        requested row later getting a real WOM# promotes it without
                                        duplicating, re-syncing never reverts an admin's own status
                                        change, Site Location/Subsidiary Code/Maximo # all sync in
                                        (location matched by name, tolerant of a shortened form, left
                                        null rather than guessed at if nothing matches), every column
                                        from the row kept verbatim as smartsheetData, admin-only,
                                        hand-entered pricing survives until a
                                        real sync, a synced row's line number/Smartsheet link come
                                        through and it auto-enters the PSE pipeline at pse_review
  pse.test.js                Full PSE pipeline state machine: a synced WOM enters at pse_review;
                                 before a reviewer is designated any admin can act, once one is set a
                                 non-reviewer is blocked from reviewer-only actions (and vice versa); a
                                 technician can't call any PSE endpoint; wrong-stage and unknown-action
                                 requests are rejected; snoozing a follow-up changes the date without
                                 changing stage; the full happy path from PSE production through Toyota
                                 approval, WOM/PO generation (including the "still missing the PO" branch
                                 back to the reviewer), marking a WOM complete auto-advancing it to
                                 check_expenses, hold reasons (fixed + free-text "other", and clearing
                                 one), a Status 95 rejection looping back before approval, invoicing
                                 closing the pipeline and flipping the WOM's own status, a closed WOM
                                 never appearing on anyone's task list, and the schedule-block flag
                                 routing a generated WOM/PO to "blocked" instead of "ready to schedule"
  tasks.test.js               Task engine: manual creation (technician force-assigned to self,
                                 only an admin can assign to someone else), status transitions
                                 (start/complete timestamps), comments (own task only, empty
                                 rejected), overdue/waiting/exceptions view filtering + computed
                                 urgency, recurring tasks staying idempotent across repeated loads
                                 within the same period (and not un-completing themselves), WOM-sync-
                                 triggered workflow tasks getting a stable source key (re-syncing
                                 never duplicates), a PSE stage advance completing the old stage's
                                 task and creating the new one, a hold flagging check_expenses as a
                                 workflow exception live (not just at task creation), wom_status_history
                                 recording both status and pse_stage transitions (admin-only to read),
                                 and the Smartsheet sync route's task/exception counters + persisted
                                 wom_sync_log last-sync summary
public/
  index.html
  css/styles.css
  js/
    app.js                Shell, routing, shared state
    api.js                Fetch wrapper (+ multipart upload, blob download)
    weekUtil.js            Client-side week date helpers
    dateMask.js            Typeable MM/DD/YYYY date inputs (wireDateMaskInput,
                              isoFromUs/usFromIso) used in place of native date pickers
    views/
      login.js
      techHome.js            Technician's own tab shell: My Work (tasks.js) / My Week (techWeek.js) /
                                Schedule / Locations & WOM (view-only) / My Documents (view-only)
      techWeek.js           Technician weekly allocation screen, attachments, computeReceipt (Reg/OT)
      adminReview.js         Admin review / Overview report / WOM docs / Vendors tracker / Labor
                              Reports archive / audit / Tech Allocation switcher / Technicians tab entry /
                              Priorities section (My Work via tasks.js, plus the existing Checklist)
      tasks.js                The one reusable Priorities/My Work task board -- mounted from both
                                adminReview.js and techHome.js; views, dashboard tiles, filters
                                (admin only), manual task creation, and the task detail/comments panel
                                all live here, not duplicated per role
      technicianProfile.js    Team Roster (+ add technician) and tabbed employee profile
      attachments.js          Shared attachments list + upload component
      womPhotoPrompt.js        Dismissible "add a photo?" nudge after submit / UKG-confirmed, reused
                                  by both techWeek.js and adminReview.js
```
