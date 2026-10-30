# ServiceWorks -- Architecture & Handoff Notes

This is the orientation doc for anyone (human or AI tool) picking this project
up fresh. `README.md` in this repo is the full, exhaustive feature-by-feature
log -- 3000+ lines, written chronologically as features shipped. This doc is
the opposite: a short "here's how it fits together and why" meant to be read
once, with pointers into `README.md` for any topic you need the full detail
on. Start here, then go deep in `README.md` only for the specific area
you're touching.

## What this is

Internal operations tool for C&W Services' Toyota account (Midwest
territory, built for RFM admin Krista Lee). Covers two things that used to
be separate manual processes:

1. **Labor allocation** -- technicians split their weekly UKG hours across
   E&F (general/standard time), WOM projects, and time off; admins review
   and reconcile against UKG and GL.
2. **Vendor/financial management** -- vendor compliance (COI/W-9/ACH),
   WOM (project) lifecycle from request through Toyota approval to
   invoicing, GL screening/reclass, PO tracking.

It's a working pilot, not yet a company-sanctioned system -- see **Open
risks / known gaps** below before assuming any part of this is production
infrastructure in the enterprise-IT sense.

## Stack, in one paragraph

Node.js + Express backend, plain vanilla JS frontend (native ES modules,
zero build step, zero framework), SQLite (`node:sqlite`, Node's own
built-in driver) as the only database, local disk for uploaded files
(encrypted at rest, see below). No cloud services required to run it at
all, except SendGrid for outbound email and (optionally) the Anthropic API
for one AI-summarization feature -- both are no-ops until their API keys
are set, nothing else depends on them. Currently deployed on a DigitalOcean
droplet via `scripts/deploy.sh`/`redeploy.sh`. Full detail: `README.md`
"Stack" and "Running it" sections.

## How to actually run it

```
npm install
npm start          # http://localhost:3000, auto-seeds server/data/store.sqlite on first run
npm test            # full suite, node:test -- no network, no external services needed
```

Delete `server/data/store.sqlite` (and `server/data/uploads/`) to reset to
seed data. `server/data/seed.js` is the mock data.

## The core domain model, and why it's shaped the way it is

Read this section before touching any of these areas -- the "why" here is
almost always a deliberate decision made after finding a real bug or a real
mismatch with how C&W/PurelyHR/Smartsheet actually work, not an accident.

### Technicians, weeks, allocations

A technician's week is a set of "allocation" rows, each one `ef` (general
time, tied to a location), `wom` (tied to a specific WOM project), or
`timeoff` (vacation/sick/etc., logged retroactively on the timecard --
**not** the same system as the forward-looking Time Off request/approval
flow below, see that section for why these two are deliberately separate).
UKG hours are stored per technician/week/**day**, not one weekly total --
that granularity is what makes the per-day UKG-vs-allocated balance check
possible. A week has an edit window (`server/utils/week.js`,
`classifyWeekForTech`) that gates whether it's fully editable, time-off-only,
or locked, independent of whether an admin is viewing it.

### WOM lifecycle

A WOM project moves through `pending` -> `requested` -> `open` ->
`invoiced`/`closed` (or `cancelled`). Two ways a WOM enters the system:

- **Smartsheet sync** (`server/utils/smartsheetSync.js` +
  `db.js`'s `syncWomsFromSheetRows`) -- the historical/primary path. A row
  with no real WOM # yet gets a synthetic `PENDING-<smartsheetRowId>` code.
- **Native PSE Request intake** (`db.createWomRequest`, wired to the tech
  Locations & WOM tab's "+ Request a WOM" button) -- added to start
  replacing the external Smartsheet request form. Creates a real `woms` row
  with status `pending` and a `PENDING-REQ-<timestamp>` code, the same
  shape as a synced pending row. `requested_by_tech_id` is set (and
  `smartsheet_row_id` is null) only for a WOM created this way -- that's
  how you tell native-origin apart from synced-origin later. **Everything
  downstream of intake (estimate/applied cost breakdown, Toyota PO
  approval, reclass, invoicing) reuses the exact same `woms` columns either
  path writes to** -- there's deliberately no separate "requests" table.

The cost breakdown (estimated/applied x labor/materials/contracted/
other-direct/tax/contingency) is one set of columns on `woms`, itemized to
match the real PSE tracker's own columns. `checkWomLifecycleAutoSteps`
auto-completes lifecycle checklist steps based on what a *synced* row
already shows (e.g. "has a request date on the tracker" implies "already
sent to Toyota" for historical data) -- **never call this for a freshly
native-created request**, that heuristic is wrong for same-day data; see
`createWomRequest`'s own comment.

**Not yet built**: the "stop trusting Smartsheet for this WOM, trust the
native record instead" toggle Krista wants eventually, and a real duplicate-
Toyota-PO-across-projects check. Also: there's already a Cards/Grid toggle
on the admin WOM Projects tab (`womViewMode` in `adminReview.js`) that
renders a dense, sortable, filterable table -- this already covers most of
what "a spreadsheet-like admin view" would need; it just doesn't yet have
the duplicate-PO flag.

### Time Off (separate system from the `timeoff`-type allocation above)

A real forward-looking request/approval/balance system modeled on
PurelyHR, backing `time_off_requests` / `time_off_policies` /
`time_off_accrual_rules` / `time_off_accrual_events` (the discrete,
permanent ledger -- balance is always a sum over this, never a mutable
running total). A technician is assigned one policy; a policy has a rule
per time-off type.

**Tenure-tiered accrual** (`time_off_tenure_tiers`, `is_tiered` on
`time_off_accrual_rules`): a rule can either be one flat rate, or a
"years of service" breakpoint table (0-1yr, 2nd year, 3rd year, ... 10+,
matching the real PTO policy's own rate card). `resolveAccrualRateForTech`
+ `completedYearsOfService` pick the right tier per technician, per run, from
their own `hire_date` -- the rate advances automatically as someone crosses
a tenure boundary, no admin action needed. This replaced an earlier design
where tenure advancement was a manual policy reassignment every work
anniversary.

**Balance enforcement is a hard block**: a request (self-submitted or
admin-on-behalf) is rejected outright if it exceeds the requester's current
accrued balance for that type -- this was an explicit decision ("block
until they have time on their balance"), not a default. A technician with
no policy assigned, or whose policy doesn't cover a given type, shows no
balance for that type at all (`computeTimeOffBalance` filters to
`ruleByType.has(type)`).

**Manual balance adjustments** (`addTimeOffBalanceAdjustment`) exist
specifically to seed real opening balances from PurelyHR exports during
the pilot -- a one-off ledger entry, source `manual_adjustment`, distinct
from a real accrual.

### GL / financial data

GL import (`importGlEntries`) matches each line to a location once, at
import time -- by job number first, then by name -- and persists the match
(`matched_location_code`/`matched_location_source`). This is a deliberate
performance/consistency choice: re-matching on every read would be slower
and could silently change historical numbers. A Chart of Accounts import
can retroactively re-match previously-unassigned lines
(`rematchUnassignedGlEntries`) without re-importing GL.

Financial figures (GL amounts, PO amounts, WOM costs) are stored as plain
columns, not individually encrypted -- this data needs to be queried/summed
constantly, so it's treated as ordinary business data. The only thing
treated as a secret is the vendor banking details, and those only ever
exist inside an uploaded, encrypted ACH/voided-check file, never as a
database column -- see **Security** below.

That tradeoff makes the live database the single most exposed plaintext
copy of this data on disk, which is why the *backup* of it is encrypted
even though the live table isn't -- see **Security posture**'s backup
paragraph. Full column-level (or whole-file, SQLCipher-style) encryption
of the live database was considered and deliberately not done: `node:sqlite`
(this app's built-in, zero-extra-deps driver, see **Stack**) has no
transparent whole-database encryption support, and per-column encryption
would break every `SUM`/`GROUP BY` the reporting/reconciliation/export
pages run directly in SQL -- a rewrite of every aggregate query site, not
a config change. If that tradeoff ever needs revisiting, treat it as its
own project, not a quick follow-up.

### Vendor compliance & the Vendor Portal

Vendors have a compliance checklist (COI/W-9/ACH/etc., `VENDOR_DOC_CATEGORIES`
in `adminReview.js`) tracked via the `files` table (`relatedType: "vendor"`).
The **Vendor Portal** (`server/routes/vendorPortal.js`,
`public/vendor-portal/`) is a **completely separate auth/session system**
from the internal app -- vendors log in with their own credentials, never
touch the main `technicians`/admin session flow. COI review
(`coiDocumentReview.js`) does text extraction + a requirement checklist,
never a model call -- the one and only place in the app that calls an LLM
is `aiSummarizer.js` for vendor correspondence summaries, and it's a no-op
if `ANTHROPIC_API_KEY` isn't set.

## Security posture (verified against the code, not assumed)

- PINs hashed with scrypt, never stored/compared in plaintext.
- Session auth via a custom `x-session-token` header, not a cookie --
  no CSRF surface as a result.
- Uploaded documents (COI/W-9/ACH, anything with routing numbers or tax
  IDs) encrypted at rest, AES-256-GCM, fail-closed if the key isn't
  configured.
- Every SQL query is parameterized; every piece of user text is escaped
  before rendering (no framework auto-escaping -- this is done by hand,
  consistently, ~1000 call sites).
- Access control (`files.js`'s `canRead`/`canWrite`) is enforced
  server-side per request, not just hidden in the UI.
- Nightly automated backup of the DB + uploads folder, 14-day retention,
  database snapshot encrypted at rest (`server/utils/backup.js`). An
  **optional** off-site push (`server/utils/offsiteBackup.js`, see
  README's **Backups**) exists but isn't configured by default -- until
  `BACKUP_S3_*` is set, backups are still **same-disk only**, and a
  droplet-level disk failure (or the droplet being lost entirely) takes
  out the live data and every backup of it at once.

## Open risks / known gaps (be honest about these, don't paper over them)

- **Hosting is not currently approved infrastructure.** This runs on a
  personal/departmental DigitalOcean droplet, not a company-sanctioned
  cloud account -- confirmed as a real blocker in conversation with IT,
  not just a theoretical concern. Don't assume this is where it'll stay --
  see **Moving hosting off this droplet** below for what that actually
  involves once a destination is picked.
- **Backups are same-disk by default** -- the database snapshot is
  encrypted, but a droplet-level disk failure still takes out both the
  live data and every local backup unless the optional off-site push is
  configured (see **Security posture** above and README's **Backups**).
- No formal security audit or pen test has been done. The measures above
  are solid internal-tool practice, not a compliance certification.
- OCR for reading a UKG timesheet screenshot was evaluated and shelved --
  classical OCR performed badly on real screenshots at their actual
  resolution; a vision-capable LLM call would likely do much better but
  needs its own cost/access decision.
- The WOM admin table (Grid view) exists but doesn't yet have the
  duplicate-Toyota-PO check discussed as the next real improvement there.
- Bulk CSV import for Time Off opening balances (vs. one-at-a-time) is
  deferred until there's a real PurelyHR export file to build the column
  mapping against.

## Moving hosting off this droplet

No approved destination has been picked yet, so this isn't a build item --
it's the checklist for whenever one is. The app was built to make this a
known, low-risk move rather than a scramble:

- **Nothing here is DigitalOcean-specific.** It's Node.js + Express +
  `node:sqlite` + local disk for uploads -- see **Stack**. `scripts/
  deploy.sh` happens to target an Ubuntu droplet behind Caddy, but that's
  one deployment script, not a dependency the app itself has on
  DigitalOcean. The same app runs anywhere that can run Node 18+: another
  cloud VM, a container platform, on-prem.
- **What actually has to move**: `server/data/store.sqlite` (or wherever
  `LABOR_DB_PATH` points), the `server/data/uploads/` folder (or
  `LABOR_UPLOADS_DIR`), and the five secrets currently set as environment
  variables on the droplet (`FILE_ENCRYPTION_KEY` -- **the uploaded
  COI/W-9/ACH files are permanently unreadable without this exact key,
  copy it first** -- plus `SENDGRID_API_KEY`/`SENDGRID_FROM`,
  `ANTHROPIC_API_KEY`, and `PUBLIC_BASE_URL`). A fresh `runBackup()`
  (`server/utils/backup.js`) right before cutover gives you a single
  encrypted, consistent snapshot of the first two to carry over.
- **What doesn't need to change**: the schema, the query layer, the
  route/auth/session code, the frontend -- none of it knows or cares what
  host it's running on.
- Once a destination is picked, the concrete steps are: stand up Node
  22 there, `git clone`/`npm install --omit=dev` the repo (same as `scripts/
  deploy.sh` already does), copy over the DB file + uploads folder + the
  five secrets above, point a reverse proxy / TLS termination at it,
  switch DNS, confirm `npm test` and a login both work against the new
  box, then decommission the droplet. `scripts/deploy.sh` can likely be
  adapted almost as-is for whatever the new target turns out to be (a
  systemd + Caddy setup isn't DigitalOcean-specific either) -- expect to
  change the install steps, not the app.

## Testing conventions

`node:test`, no external test framework. Each test **file** gets its own
throwaway SQLite DB (`tests/helpers.js` sets `LABOR_DB_PATH` per-process
before the first `require` of server code) -- but every `startServer()`
call **within the same file** shares that one DB. If an earlier test in a
file mutates shared state (resets a PIN, deletes a policy, changes an
employment status), a later test in that *same file* can collide with it.
The established fix, used repeatedly: give a test that needs isolation its
own dedicated fixture technician/vendor (e.g. `BALTEST`, `TTIER`, `TCAP`),
or put it in its own new test file entirely if the whole file's state needs
to be independent.

## Where to go deeper

Every feature summarized above has a much fuller writeup in `README.md`'s
**Features** section (searchable by name) and **Data model** section. The
**Where this stands** section covers deployment, auth, and what's
real-vs-mock in detail. If you're an AI picking this up cold: read this
file first, then grep `README.md` for the specific feature name you're
about to touch before changing it -- the reasoning behind a design
decision is almost always written down there, and skipping it is the
fastest way to reintroduce a bug that was already found and fixed once.
