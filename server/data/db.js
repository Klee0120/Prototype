const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { seed } = require("./seed");
const { hashPin, verifyPin } = require("../utils/password");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Overridable so tests can point at a throwaway file instead of the real
// mock database.
const DB_PATH = process.env.LABOR_DB_PATH || path.join(__dirname, "store.sqlite");
const UPLOADS_DIR = process.env.LABOR_UPLOADS_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");

// Schema v1 (flat wom_code per allocation row, single weekly UKG total, no
// locations) predates locations/WOM budgets/E&F split rows. Rather than
// hand-migrate mock rows that were never real technician data, detect the
// old shape and rebuild those tables fresh from the current seed.
function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
if (tableExists("woms") && !hasColumn("woms", "location_code")) {
  db.exec("DROP TABLE technicians");
  db.exec("DROP TABLE woms");
  db.exec("DROP TABLE allocations");
  db.exec("DROP TABLE ukg_hours");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ef_job_number TEXT,
    wom_job_number TEXT,
    region TEXT
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    home_location_code TEXT,
    email TEXT,
    phone TEXT,
    ukg_id TEXT,
    position TEXT,
    notification_pref TEXT NOT NULL DEFAULT 'in_app'
  );

  CREATE TABLE IF NOT EXISTS woms (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    location_code TEXT,
    budget_hours REAL,
    subsidiary_code TEXT,
    smartsheet_reflected_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ukg_hours (
    tech_id TEXT NOT NULL,
    week_monday TEXT NOT NULL,
    day TEXT NOT NULL,
    hours REAL NOT NULL,
    PRIMARY KEY (tech_id, week_monday, day)
  );

  CREATE TABLE IF NOT EXISTS weeks (
    tech_id TEXT NOT NULL,
    week_monday TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    submitted_at TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    note TEXT DEFAULT '',
    weekend_addendum_at TEXT,
    purelyhr_verified_at TEXT,
    PRIMARY KEY (tech_id, week_monday)
  );

  CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tech_id TEXT NOT NULL,
    week_monday TEXT NOT NULL,
    day TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'wom',
    location_code TEXT,
    wom_code TEXT,
    hours REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    related_type TEXT NOT NULL,
    related_id TEXT NOT NULL,
    category TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    form_type TEXT,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    tech_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS onboarding_progress (
    tech_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (tech_id, task_key)
  );

  CREATE TABLE IF NOT EXISTS tech_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tech_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    assigned_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    request_type TEXT NOT NULL,
    reference_number TEXT DEFAULT '',
    requested_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    jde_vendor_number TEXT,
    cw_status TEXT NOT NULL DEFAULT 'unknown',
    toyota_status TEXT NOT NULL DEFAULT 'unknown',
    forms_status TEXT NOT NULL DEFAULT 'unknown',
    raw_status_text TEXT DEFAULT '',
    po_email TEXT DEFAULT '',
    invoiced_previously TEXT DEFAULT '',
    successful_invoice_records INTEGER,
    successful_since_date TEXT,
    midwest_sites_seen TEXT DEFAULT '',
    services TEXT DEFAULT '',
    tracker_work_examples TEXT DEFAULT '',
    coverage_outside_midwest TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    online_source_url TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    coi_meets_required_limits INTEGER NOT NULL DEFAULT 0,
    coi_meets_language_requirements INTEGER NOT NULL DEFAULT 0,
    coi_gl_liability_occ TEXT DEFAULT '',
    coi_gl_liability_agg TEXT DEFAULT '',
    coi_auto_liability TEXT DEFAULT '',
    coi_workers_comp TEXT DEFAULT '',
    coi_umbrella_liability TEXT DEFAULT '',
    coi_e_and_o TEXT DEFAULT '',
    coi_pollution TEXT DEFAULT '',
    coi_crime TEXT DEFAULT '',
    coi_products_compl_op_agg TEXT DEFAULT '',
    coi_is_acord25_2016_03 INTEGER NOT NULL DEFAULT 0,
    coi_matches_w9 INTEGER NOT NULL DEFAULT 0,
    w9_signed_dated INTEGER NOT NULL DEFAULT 0,
    w9_correct_version INTEGER NOT NULL DEFAULT 0,
    w9_has_phone INTEGER NOT NULL DEFAULT 0,
    w9_has_remit_to_address INTEGER NOT NULL DEFAULT 0,
    w9_has_name INTEGER NOT NULL DEFAULT 0,
    ach_bank_letterhead INTEGER NOT NULL DEFAULT 0,
    ach_has_w9_name INTEGER NOT NULL DEFAULT 0,
    ach_has_w9_address INTEGER NOT NULL DEFAULT 0,
    w9_invoice_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vendor_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    request_type TEXT NOT NULL,
    reference_number TEXT DEFAULT '',
    status TEXT DEFAULT '',
    requested_at TEXT NOT NULL
  );

  -- The generic task/workflow engine: "states create tasks, tasks create
  -- timestamps, timestamps create analytics." A task is always the record
  -- of something a person needs to do -- generated automatically off a WOM
  -- state change or a recurring schedule, or entered by hand. source_key is
  -- the dedup handle for anything auto-generated (e.g.
  -- "WOM-20528831-REVIEW-EXPENSES") -- re-running the same generation logic
  -- upserts the existing row instead of creating a duplicate. Manual tasks
  -- have no source_key. Never deleted once created (see setTaskStatus) --
  -- a completed/cancelled task stays as history.
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assigned_to TEXT,
    assigned_role TEXT,
    category TEXT NOT NULL DEFAULT 'manual',
    priority TEXT NOT NULL DEFAULT 'normal',
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    related_wom_code TEXT,
    related_vendor_id INTEGER,
    related_location_code TEXT,
    related_tech_id TEXT,
    related_po TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_record_id TEXT,
    workflow_rule TEXT,
    is_exception INTEGER NOT NULL DEFAULT 0,
    is_change_order INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    snoozed_until TEXT,
    last_status_change_at TEXT NOT NULL
  );

  -- Comments/notes on a task, kept as their own timestamped log rather than
  -- one overwritable text field, since "let me open the task for
  -- details/history/comments" implies more than one note over its life.
  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- A running status log for a WOM-workflow task that's being snoozed
  -- forward week over week rather than acted on today ("$100 expenses
  -- posted, labor posted, vendor $ posted" this week, a different note
  -- next week) -- kept separate from task_comments (a request to keep this
  -- as its own dedicated field, not mixed into the general activity feed),
  -- and as its own timestamped log rather than one overwritable note since
  -- the whole point is watching the story change across repeated snoozes.
  CREATE TABLE IF NOT EXISTS task_reschedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    note TEXT NOT NULL,
    snoozed_until TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- A user-defined recurring task, distinct from the fixed hardcoded specs
  -- in ensureRecurringTasks() -- this is "remind me to do X every Monday
  -- and Wednesday" set up by hand from the New Task form, rather than a
  -- built-in admin responsibility. The template itself is never shown as
  -- a task; ensureRecurringTasks() upserts today's actual task row (by a
  -- source key derived from this template's id + today's date) whenever
  -- today's weekday is in days_of_week, the same lazy-on-read pattern
  -- every other recurring task in this app already uses.
  CREATE TABLE IF NOT EXISTS recurring_task_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    assigned_to TEXT,
    assigned_role TEXT,
    related_wom_code TEXT,
    days_of_week TEXT NOT NULL,
    due_time TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL
  );

  -- A WOM's own status/stage changes, kept separately from the woms table
  -- itself (which only ever holds the CURRENT value) so how long a project
  -- spent in each step can be calculated later. changed_at is the real
  -- event time when the source can tell us one (an admin/reviewer's own
  -- action, timestamped the moment they click it); Smartsheet sync can only
  -- tell us detected_at (when this app noticed), since sync is manual and
  -- Smartsheet doesn't hand back a per-field last-changed timestamp.
  CREATE TABLE IF NOT EXISTS wom_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wom_code TEXT NOT NULL,
    field TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    changed_at TEXT,
    detected_at TEXT NOT NULL,
    changed_by TEXT,
    source TEXT NOT NULL
  );

  -- The WOM lifecycle checklist's own progress -- one row per WOM per step
  -- once it's completed (an incomplete step has no row at all). Backs the
  -- one persistent task per WOM described where WOM_LIFECYCLE_STEPS is
  -- defined, instead of a single pse_stage column.
  CREATE TABLE IF NOT EXISTS wom_lifecycle_steps (
    wom_code TEXT NOT NULL,
    step_key TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    completed_by TEXT,
    PRIMARY KEY (wom_code, step_key)
  );

  CREATE TABLE IF NOT EXISTS wom_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT NOT NULL,
    synced_by TEXT,
    woms_created INTEGER NOT NULL DEFAULT 0,
    woms_promoted INTEGER NOT NULL DEFAULT 0,
    woms_updated INTEGER NOT NULL DEFAULT 0,
    tasks_created INTEGER NOT NULL DEFAULT 0,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    exceptions_flagged INTEGER NOT NULL DEFAULT 0,
    total_rows INTEGER NOT NULL DEFAULT 0
  );
`);

// A sync's actual per-WOM changes (code/description/which fields differed),
// as JSON -- so "View Sync Details" can say what changed, not just how many
// rows were touched, and still show it after a page reload.
if (!hasColumn("wom_sync_log", "changed_woms_json")) {
  db.exec("ALTER TABLE wom_sync_log ADD COLUMN changed_woms_json TEXT");
}

// Additive columns for existing databases created before the roster
// expansion — safe to just add, unlike the relational rebuild above.
for (const col of ["email", "phone", "ukg_id", "position", "hire_date", "termination_date"]) {
  if (!hasColumn("technicians", col)) {
    db.exec(`ALTER TABLE technicians ADD COLUMN ${col} TEXT`);
  }
}
if (!hasColumn("technicians", "standard_daily_hours")) {
  db.exec("ALTER TABLE technicians ADD COLUMN standard_daily_hours REAL");
}
// How a technician wants to hear "your hours are ready, go allocate them" --
// the in-app banner always shows regardless, but email additionally sends a
// real message (see server/utils/mailer.js) when this is set to 'email'.
if (!hasColumn("technicians", "notification_pref")) {
  db.exec("ALTER TABLE technicians ADD COLUMN notification_pref TEXT NOT NULL DEFAULT 'in_app'");
}

// employment_status (active/inactive/terminated/retired) replaces the old
// boolean `active` flag with something a roster can actually filter/manage.
// Backfill from the old column so existing inactive techs aren't silently
// reactivated by a column default.
if (!hasColumn("technicians", "employment_status")) {
  db.exec("ALTER TABLE technicians ADD COLUMN employment_status TEXT");
  db.exec("UPDATE technicians SET employment_status = CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END");
}

// A short-lived attempt at a reversible (admin-decryptable) PIN copy was
// added and then reverted -- storing anything that lets a PIN be read back
// after creation weakens the one-way hash below for no real gain, given
// there's compliance-sensitive vendor documents (COI/W-9/ACH) gated behind
// this same login. If this database ever ran that migration, clear any
// leftover encrypted values rather than leaving them sitting around.
if (hasColumn("technicians", "pin_encrypted")) {
  db.exec("UPDATE technicians SET pin_encrypted = NULL WHERE pin_encrypted IS NOT NULL");
}

// Admin's own "I've entered this into the real UKG system" checklist step --
// deliberately separate from status (draft/submitted/approved/rejected),
// since in practice the admin often drives the whole allocation on a
// technician's behalf and tracks this as their own third confirmation step.
if (!hasColumn("weeks", "ukg_confirmed_at")) {
  db.exec("ALTER TABLE weeks ADD COLUMN ukg_confirmed_at TEXT");
  db.exec("ALTER TABLE weeks ADD COLUMN ukg_confirmed_by TEXT");
}
// Set when a technician adds/changes Sat/Sun hours on a week that's already
// submitted/approved (a weekend callout after the rest of the week was
// already locked in) -- see saveWeekendAllocations. Flags the week for
// admin's attention without touching its already-locked Mon-Fri status.
if (!hasColumn("weeks", "weekend_addendum_at")) {
  db.exec("ALTER TABLE weeks ADD COLUMN weekend_addendum_at TEXT");
}
// PurelyHR tracks time-off balances/requests separately from UKG (and
// doesn't link to it), so a week's PTO/Sick/Holiday/Bereavement hours have
// to be manually cross-checked there. NULL means "this week has time off
// and hasn't been checked yet" -- see setPurelyHrVerified. Cleared
// back to NULL whenever the week's allocations are rewritten (saveAllocations/
// saveWeekendAllocations), since an edit could add, remove, or change the
// time off that was verified.
if (!hasColumn("weeks", "purelyhr_verified_at")) {
  db.exec("ALTER TABLE weeks ADD COLUMN purelyhr_verified_at TEXT");
}

// Flags a specific day as waiting on a real UKG punch correction (a missed
// clock-out, etc.) -- visible to the technician so a wrong/zero UKG number
// reads as "not final yet" rather than "admin forgot about me".
if (!hasColumn("ukg_hours", "pending_punch")) {
  db.exec("ALTER TABLE ukg_hours ADD COLUMN pending_punch INTEGER NOT NULL DEFAULT 0");
}

// Who flagged a pending punch and why -- lets a technician report their own
// punch issue (with an optional note) instead of only admin being able to
// set the flag. Only populated while pending_punch = 1; both clear back to
// NULL once resolved.
if (!hasColumn("ukg_hours", "pending_punch_note")) {
  db.exec("ALTER TABLE ukg_hours ADD COLUMN pending_punch_note TEXT");
}
if (!hasColumn("ukg_hours", "pending_punch_reported_by")) {
  db.exec("ALTER TABLE ukg_hours ADD COLUMN pending_punch_reported_by TEXT");
}

// A device is either a phone (device_name holds the phone number) or a
// laptop (device_name holds an asset tag/serial) -- existing rows predate
// this distinction, so they default to "phone" since that's what the old
// single free-text field was actually labeled.
if (!hasColumn("tech_devices", "device_type")) {
  db.exec("ALTER TABLE tech_devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'phone'");
}
// Optional plan/line info (e.g. a phone's carrier plan) -- free text since
// plan names/tiers vary by carrier and change over time.
if (!hasColumn("tech_devices", "plan")) {
  db.exec("ALTER TABLE tech_devices ADD COLUMN plan TEXT DEFAULT ''");
}

// Real JDE accounting codes: each location's own job number for general
// (E&F) time, and each WOM's own subsidiary/service code -- these vary per
// WOM project, unlike the E&F subsidiary code, which is a single standard
// value across every location (see EF_SUBSIDIARY_CODE in routes/locations.js).
// Region (e.g. "Southeast", "Region 1") groups locations for matching against
// the monthly labor-report/financial file, which is organized by region.
if (!hasColumn("locations", "ef_job_number")) {
  db.exec("ALTER TABLE locations ADD COLUMN ef_job_number TEXT");
}
if (!hasColumn("locations", "region")) {
  db.exec("ALTER TABLE locations ADD COLUMN region TEXT");
}
// Territory (Midwest/HQ/East/West) -- a label for now, no access-control
// scoping yet, but every WOM/task/allocation/technician that keys off a
// location_code inherits it for free the moment that location is tagged,
// rather than needing its own territory column that could drift out of
// sync with where it's actually located. Everything predates territories,
// so every existing location backfills to Midwest.
const TERRITORIES = ["Midwest", "HQ", "East", "West"];
if (!hasColumn("locations", "territory")) {
  db.exec("ALTER TABLE locations ADD COLUMN territory TEXT NOT NULL DEFAULT 'Midwest'");
}
// A location's E1 WOM Job Number (from the same JDE lookup table as the E&F
// Contract Job Number) -- the base job number WOM work at that location
// posts to; combined with a WOM's own subsidiary code to form its full
// accounting code, the same way efJobNumber + EF_SUBSIDIARY_CODE do for E&F.
if (!hasColumn("locations", "wom_job_number")) {
  db.exec("ALTER TABLE locations ADD COLUMN wom_job_number TEXT");
}
if (!hasColumn("woms", "subsidiary_code")) {
  db.exec("ALTER TABLE woms ADD COLUMN subsidiary_code TEXT");
}
// Closing a WOM here doesn't touch the external Smartsheet tracker -- this
// timestamps when admin has gone and reflected that closure there by hand.
// NULL while status is 'closed' means "still needs that manual update";
// cleared back to NULL if the WOM ever reopens, so a later re-close needs
// its own fresh update too. See setWomStatus/markWomSmartsheetReflected.
if (!hasColumn("woms", "smartsheet_reflected_at")) {
  db.exec("ALTER TABLE woms ADD COLUMN smartsheet_reflected_at TEXT");
}
// Estimated/applied dollar figures pulled in from the Smartsheet WOM
// tracker (matched by WOM code -- see syncWomPricingFromSmartsheet in
// server/utils/smartsheet.js). Still manually editable here for a WOM that
// doesn't have a Smartsheet match yet; a later sync overwrites both
// whenever that WOM code is found there, since these are meant to mirror
// Smartsheet once a match exists, not be independently maintained here.
if (!hasColumn("woms", "estimated_price")) {
  db.exec("ALTER TABLE woms ADD COLUMN estimated_price REAL");
}
if (!hasColumn("woms", "applied_price")) {
  db.exec("ALTER TABLE woms ADD COLUMN applied_price REAL");
}
if (!hasColumn("woms", "smartsheet_synced_at")) {
  db.exec("ALTER TABLE woms ADD COLUMN smartsheet_synced_at TEXT");
}
// Tracks which underlying Smartsheet row a WOM record came from, so a
// later sync can find and update/promote it even after its code changes
// (a 'pending' request gets renamed to the real WOM # once one is
// assigned -- see syncWomsFromSheetRows) rather than creating a duplicate.
// Only set on WOM records that actually came from a sync; a WOM created by
// hand has no Smartsheet row to track.
if (!hasColumn("woms", "smartsheet_row_id")) {
  db.exec("ALTER TABLE woms ADD COLUMN smartsheet_row_id TEXT");
}
// The small, human-facing row number shown in the Smartsheet grid itself
// (e.g. "Line 42") -- refreshed on every sync same as pricing, since a
// row's position in the sheet can shift. Much easier to actually find and
// identify a request by than smartsheet_row_id, which is a long opaque
// internal id with no relation to what's visible in Smartsheet.
if (!hasColumn("woms", "smartsheet_row_number")) {
  db.exec("ALTER TABLE woms ADD COLUMN smartsheet_row_number INTEGER");
}
// The Maximo work order # a WOM traces back to -- a separate identifier
// from the WOM # itself, the C&W PO #, and the Toyota PO # on the real PSE
// tracker (see syncWomsFromSheetRows). Hand-editable here same as
// subsidiary code; a later sync overwrites it once a "Maximo #" column is
// found there.
if (!hasColumn("woms", "maximo_number")) {
  db.exec("ALTER TABLE woms ADD COLUMN maximo_number TEXT");
}
// The tracker has ~75 columns (every estimate/applied line item -- labor,
// materials, contracted services, other direct costs, sales tax,
// contingency -- plus PO numbers, batch/invoice tracking, RFM/PSE approval
// flags, and more) that don't each deserve their own dedicated column here
// -- most WOMs will only ever be looked at for a handful of them, and new
// ones get added to the sheet over time. Instead every synced row's full
// {ColumnTitle: value} object (from simplifySheet) is kept verbatim as
// JSON, refreshed on every sync same as pricing -- so nothing from the
// sheet is ever lost, and the WOM Projects tab can show all of it in one
// expandable panel without a schema change every time the sheet grows a
// column. estimated_price/applied_price/maximo_number/subsidiary_code stay
// their own columns because this app's own logic (accounting codes,
// allocatability, Priorities) reads them directly.
if (!hasColumn("woms", "smartsheet_raw_data")) {
  db.exec("ALTER TABLE woms ADD COLUMN smartsheet_raw_data TEXT");
}
// Legacy columns from an earlier stage-machine version of the PSE/PO
// pipeline, superseded by the WOM lifecycle checklist below
// (wom_lifecycle_steps) -- kept only because SQLite can't cheaply drop a
// column, and no code reads them anymore.
if (!hasColumn("woms", "pse_stage")) {
  db.exec("ALTER TABLE woms ADD COLUMN pse_stage TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_hold_reason TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_hold_note TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_schedule_block INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE woms ADD COLUMN pse_followup_at TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_stage_updated_at TEXT");
}
// Which email address the PSE was actually sent to at Toyota, and when --
// recorded on the "PSE produced -- send to Toyota" action itself, since
// otherwise that step is a bare button click with no record of who at
// Toyota received it or on what date, which matters when following up.
if (!hasColumn("woms", "pse_toyota_email")) {
  db.exec("ALTER TABLE woms ADD COLUMN pse_toyota_email TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_toyota_sent_at TEXT");
}
// The last two steps of the WOM lifecycle checklist -- batch/invoice #
// entered together, the moment that's ready to bill Toyota.
if (!hasColumn("woms", "batch_number")) {
  db.exec("ALTER TABLE woms ADD COLUMN batch_number TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN invoice_number TEXT");
}
// The estimate/applied breakdown by category -- labor (this app's own
// technicians' time, billed to Toyota) vs. contracted services (money paid
// out to an external vendor) -- pulled out of the ~75-column raw-data blob
// into their own columns for the same reason estimated_price/applied_price
// already are: Cost Analysis needs to compare and sort on them directly,
// and the aggregate project-total fields alone can't say *which* category
// drove an overage. vendor_id links a WOM to the vendor named in the
// tracker's own "Vendor(s) Name/#/Phone" column (matched by name, same
// tolerant approach as matchLocationCodeByName -- see
// matchVendorIdByName), so an increase can be attributed to a specific
// vendor rather than just the WOM.
if (!hasColumn("woms", "estimated_labor")) {
  db.exec("ALTER TABLE woms ADD COLUMN estimated_labor REAL");
  db.exec("ALTER TABLE woms ADD COLUMN estimated_contracted REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_labor REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_contracted REAL");
  db.exec("ALTER TABLE woms ADD COLUMN vendor_id INTEGER");
}
// The actual dollar amount on the real Toyota-approved PO ("TOY Value" in
// the tracker) -- a distinct figure from estimated_price (what the PSE
// asked for) and applied_price (what actually got posted). Cost Analysis
// needs this to compare applied cost against what Toyota actually approved,
// not just against the original estimate.
if (!hasColumn("woms", "toyota_po_value")) {
  db.exec("ALTER TABLE woms ADD COLUMN toyota_po_value REAL");
}
// The tracker itemizes estimate/applied cost into six categories, not just
// labor and contracted services -- materials, other direct costs, sales
// tax, and contingency each get their own estimate/applied pair too (all
// six sum to the WOM's project total). See WOM_COST_BREAKDOWN_FIELDS below.
if (!hasColumn("woms", "estimated_materials")) {
  db.exec("ALTER TABLE woms ADD COLUMN estimated_materials REAL");
  db.exec("ALTER TABLE woms ADD COLUMN estimated_other_direct REAL");
  db.exec("ALTER TABLE woms ADD COLUMN estimated_tax REAL");
  db.exec("ALTER TABLE woms ADD COLUMN estimated_contingency REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_materials REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_other_direct REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_tax REAL");
  db.exec("ALTER TABLE woms ADD COLUMN applied_contingency REAL");
}
// The tracker's own "Date Requested" column, kept verbatim (not just the
// transient pending/requested-promotion check syncWomsFromSheetRows already
// does with it) -- a real WOM that already has this filled in has plainly
// already cleared Toyota approval, even if nobody's clicked "Send PSE to
// Toyota" in this app to log it. Lets checkWomLifecycleAutoSteps complete
// that checklist step from the sheet's own record instead of leaving the
// entire pre-existing backlog stuck showing as still needing to be sent.
if (!hasColumn("woms", "date_requested")) {
  db.exec("ALTER TABLE woms ADD COLUMN date_requested TEXT");
}
// One-time cleanup for tasks left behind by the old 9-stage PSE state
// machine this app used before the WOM lifecycle checklist replaced it
// ("Produce PSE for X", "Follow up: Toyota approval for X", etc.) --
// removing that code never deleted the task rows it had already created,
// so they've sat on every board since as permanently-stuck clutter no
// current code path can ever complete or clean up (nothing sets `pse_stage`
// anymore, so nothing can ever move them). Identified by the exact
// `workflow_rule` values that old code used (the stage name itself --
// see PSE_STAGE_TASKS in git history, commit 04e4c8f, for the full
// mapping); the current lifecycle checklist always uses 'wom_lifecycle'
// instead, so this can never match anything the current code creates.
// A plain function (not inline top-level code) so it's callable again --
// it's still run once below at load time, and safe to call again any time
// after, since once these rows are gone the condition never matches again.
function cleanupLegacyPseWorkflowTasks() {
  const legacyPseWorkflowRules = [
    "pse_review",
    "awaiting_toyota_approval",
    "generate_wom_po",
    "awaiting_toyota_po",
    "schedule_blocked",
    "ready_to_schedule",
    "check_expenses",
    "pending_status95_approval",
    "ready_to_invoice",
  ];
  const legacyIds = db
    .prepare(`SELECT id FROM tasks WHERE workflow_rule IN (${legacyPseWorkflowRules.map(() => "?").join(",")})`)
    .all(...legacyPseWorkflowRules)
    .map((r) => r.id);
  if (legacyIds.length > 0) {
    db.prepare(`DELETE FROM task_comments WHERE task_id IN (${legacyIds.map(() => "?").join(",")})`).run(...legacyIds);
    db.prepare(`DELETE FROM files WHERE related_type = 'task' AND related_id IN (${legacyIds.map(() => "?").join(",")})`).run(
      ...legacyIds.map(String)
    );
    db.prepare(`DELETE FROM tasks WHERE id IN (${legacyIds.map(() => "?").join(",")})`).run(...legacyIds);
    console.log(`Cleaned up ${legacyIds.length} leftover task(s) from the retired PSE stage machine.`);
  }
  return legacyIds.length;
}
cleanupLegacyPseWorkflowTasks();
// A future date this task is snoozed until -- separate from due_at (an
// ordinary task's own deadline, unaffected by any of this) so rescheduling
// a WOM-workflow task forward doesn't change what it's actually due, just
// when it's next worth looking at. My Work/Team Work/etc. hide a task
// while snoozed_until is still in the future; the Upcoming tab is the one
// place that still shows it, and a snooze clears itself the moment that
// date arrives (a live comparison against "now," not a value anything
// has to remember to reset).
if (!hasColumn("tasks", "snoozed_until")) {
  db.exec("ALTER TABLE tasks ADD COLUMN snoozed_until TEXT");
}
// Splits the single "Toyota paperwork gap" exception into the two distinct
// cases it's always actually been: no Toyota PO on file yet at all (a
// paperwork-catch-up problem) vs. a real cost overage needing Toyota's
// sign-off on a change order (a money problem, and the more urgent of the
// two). is_exception alone couldn't tell a caller which one it was looking
// at, so both rendered identically -- same red badge, same flag -- despite
// meaning very different things to RFM.
if (!hasColumn("tasks", "is_change_order")) {
  db.exec("ALTER TABLE tasks ADD COLUMN is_change_order INTEGER NOT NULL DEFAULT 0");
}
if (!tableExists("task_reschedules")) {
  db.exec(`
    CREATE TABLE task_reschedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      snoozed_until TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}
// Which admin plays the "reviewer" role in the PSE pipeline (produces the
// PSE, liaises with Toyota, approves Status 95) -- distinct from the
// "financial" role (generates the WOM/PO, monitors charges, invoices),
// which any other active admin can act on. Exactly one admin should hold
// this at a time; setPseReviewer below enforces that by clearing it from
// everyone else whenever it's set.
if (!hasColumn("technicians", "is_pse_reviewer")) {
  db.exec("ALTER TABLE technicians ADD COLUMN is_pse_reviewer INTEGER NOT NULL DEFAULT 0");
}
// Forms on File (tech_form uploads) can carry a type (e.g. "Certification",
// "License") and an expiration date, so expired ones can be flagged for
// admin/RFM attention on the Overview tab -- see listExpiringForms below.
if (!hasColumn("files", "form_type")) {
  db.exec("ALTER TABLE files ADD COLUMN form_type TEXT");
}
if (!hasColumn("files", "expires_at")) {
  db.exec("ALTER TABLE files ADD COLUMN expires_at TEXT");
}
// COI (Certificate of Insurance) coverage limits requested/on file per
// vendor -- a fixed, small set of coverage types (matches the real vendor
// tracker), so plain named columns rather than a flexible key/value shape.
const VENDOR_COI_TEXT_COLUMNS = [
  "coi_gl_liability_occ",
  "coi_gl_liability_agg",
  "coi_auto_liability",
  "coi_workers_comp",
  "coi_umbrella_liability",
  "coi_e_and_o",
  "coi_pollution",
  "coi_crime",
  "coi_products_compl_op_agg",
];
for (const col of VENDOR_COI_TEXT_COLUMNS) {
  if (!hasColumn("vendors", col)) {
    db.exec(`ALTER TABLE vendors ADD COLUMN ${col} TEXT DEFAULT ''`);
  }
}
if (!hasColumn("vendors", "coi_meets_required_limits")) {
  db.exec("ALTER TABLE vendors ADD COLUMN coi_meets_required_limits INTEGER NOT NULL DEFAULT 0");
}
if (!hasColumn("vendors", "coi_meets_language_requirements")) {
  db.exec("ALTER TABLE vendors ADD COLUMN coi_meets_language_requirements INTEGER NOT NULL DEFAULT 0");
}

// Specific per-document compliance checks admin verifies against the real
// attached file (COI/W-9/ACH) -- separate from coi_meets_required_limits
// above, which is about coverage *amounts*; these are about the document
// itself being the right form, signed, and matching the vendor's other
// documents. Any unchecked box means that document hasn't been confirmed
// compliant yet, same flagging idea as forms_status = 'outdated'.
const VENDOR_FORM_CHECK_BOOL_COLUMNS = [
  "coi_is_acord25_2016_03",
  "coi_matches_w9",
  "w9_signed_dated",
  "w9_correct_version",
  "w9_has_phone",
  "w9_has_remit_to_address",
  "w9_has_name",
  "ach_bank_letterhead",
  "ach_has_w9_name",
  "ach_has_w9_address",
];
for (const col of VENDOR_FORM_CHECK_BOOL_COLUMNS) {
  if (!hasColumn("vendors", col)) {
    db.exec(`ALTER TABLE vendors ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
}
// The date on the blank invoice W-9 documentation is expected to include --
// flagged stale once it's more than 2 years old (see W9_INVOICE_MAX_AGE_YEARS).
if (!hasColumn("vendors", "w9_invoice_date")) {
  db.exec("ALTER TABLE vendors ADD COLUMN w9_invoice_date TEXT");
}
// Mirrors the email-folder workflow already used to track onboarding by
// hand: a vendor sits "in_progress" while it's actively being worked,
// moves to "denied" (with a reason) or "onboarded" when it's resolved.
// "not_started" is the default for the bulk of already-imported vendors
// that were never run through an explicit onboarding process here.
if (!hasColumn("vendors", "onboarding_stage")) {
  db.exec("ALTER TABLE vendors ADD COLUMN onboarding_stage TEXT NOT NULL DEFAULT 'not_started'");
}
if (!hasColumn("vendors", "denied_reason")) {
  db.exec("ALTER TABLE vendors ADD COLUMN denied_reason TEXT DEFAULT ''");
}
// Case-log entries need their own updated_at too -- the real signal for
// "has anyone touched this vendor in the last 7 days" is the most recent
// touch to *either* the vendor record or one of its case-log entries, not
// just whichever the vendor row's own updated_at happens to reflect.
if (!hasColumn("vendor_requests", "updated_at")) {
  db.exec("ALTER TABLE vendor_requests ADD COLUMN updated_at TEXT");
  db.exec("UPDATE vendor_requests SET updated_at = requested_at WHERE updated_at IS NULL");
}

// A case marked "Needs Adjustment" or "Denied" is much more useful with a
// reason ("missing Auto Liability language") than the bare status alone --
// but that text can't just be appended onto `status` itself, since
// deriveOnboardingStage matches `status` against "approved"/"denied"
// exactly; a separate free-text column keeps that comparison intact.
if (!hasColumn("vendor_requests", "note")) {
  db.exec("ALTER TABLE vendor_requests ADD COLUMN note TEXT DEFAULT ''");
}

// The date a case's status is actually true as of -- e.g. "Missing E&O" was
// found on the COI as of the date someone actually reviewed the document,
// which may not be today, the day it's finally getting logged. Separate
// from updated_at (when this row was last touched, used for sorting/"has
// anyone touched this vendor recently") since the two can legitimately
// differ and conflating them would make a backdated entry sort out of
// order against other cases. Defaults to the log date for history logged
// before this existed.
if (!hasColumn("vendor_requests", "as_of")) {
  db.exec("ALTER TABLE vendor_requests ADD COLUMN as_of TEXT");
  db.exec("UPDATE vendor_requests SET as_of = date(requested_at) WHERE as_of IS NULL");
}

seedIfEmpty();

function seedIfEmpty() {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM technicians").get();
  if (count > 0) return;

  const data = seed();

  const insertLocation = db.prepare("INSERT INTO locations (code, name) VALUES (?, ?)");
  for (const l of data.locations) insertLocation.run(l.code, l.name);

  const insertTech = db.prepare(
    `INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email, phone, ukg_id, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of data.technicians) {
    insertTech.run(
      t.id,
      t.name,
      hashPin(t.pin),
      t.role,
      t.active,
      t.active ? "active" : "inactive",
      t.homeLocationCode,
      t.email || null,
      t.phone || null,
      t.ukgId || null,
      t.position || null
    );
  }

  const insertWom = db.prepare(
    "INSERT INTO woms (code, description, status, location_code, budget_hours) VALUES (?, ?, ?, ?, ?)"
  );
  for (const w of data.woms) insertWom.run(w.code, w.description, w.status, w.locationCode, w.budgetHours);

  const insertUkg = db.prepare("INSERT INTO ukg_hours (tech_id, week_monday, day, hours) VALUES (?, ?, ?, ?)");
  for (const u of data.ukgHours) {
    for (const [day, hours] of Object.entries(u.hours)) {
      insertUkg.run(u.techId, u.weekMonday, day, hours);
    }
  }

  const insertWeek = db.prepare(`
    INSERT INTO weeks (tech_id, week_monday, status, submitted_at, reviewed_at, reviewed_by, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlloc = db.prepare(`
    INSERT INTO allocations (tech_id, week_monday, day, type, location_code, wom_code, hours) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const w of data.weeks) {
    insertWeek.run(w.techId, w.weekMonday, w.status, w.submittedAt, w.reviewedAt, w.reviewedBy, w.note || "");
    for (const a of w.allocations) {
      insertAlloc.run(w.techId, w.weekMonday, a.day, a.type, a.locationCode, a.womCode, a.hours);
    }
  }

  const insertAudit = db.prepare("INSERT INTO audit_log (timestamp, actor, action, details) VALUES (?, ?, ?, ?)");
  for (const e of data.auditLog) insertAudit.run(e.timestamp, e.actor, e.action, e.details);
}

function ensureWeekRow(techId, weekMonday) {
  db.prepare("INSERT OR IGNORE INTO weeks (tech_id, week_monday, status) VALUES (?, ?, 'draft')").run(
    techId,
    weekMonday
  );
}

// ---- Technicians ----

function findTechnician(id) {
  return db.prepare("SELECT * FROM technicians WHERE UPPER(id) = UPPER(?)").get(String(id));
}

function listTechnicians() {
  return db.prepare("SELECT * FROM technicians WHERE role = 'tech' ORDER BY rowid").all();
}

const EMPLOYMENT_STATUSES = ["active", "inactive", "terminated", "retired"];

function verifyLogin(id, pin) {
  const tech = findTechnician(id);
  if (!tech || tech.employment_status !== "active") return null;
  if (!verifyPin(pin, tech.pin)) return null;
  return tech;
}

function setHomeLocation(techId, locationCode) {
  db.prepare("UPDATE technicians SET home_location_code = ? WHERE id = ?").run(locationCode, techId);
  return findTechnician(techId);
}

function setEmploymentStatus(techId, status) {
  db.prepare("UPDATE technicians SET employment_status = ?, active = ? WHERE id = ?").run(
    status,
    status === "active" ? 1 : 0,
    techId
  );
  return findTechnician(techId);
}

function createTechnician({ id, name, pin, homeLocationCode, email, phone, ukgId, position, hireDate }) {
  db.prepare(
    `INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email, phone, ukg_id, position, hire_date)
     VALUES (?, ?, ?, 'tech', 1, 'active', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    hashPin(pin),
    homeLocationCode || null,
    email || null,
    phone || null,
    ukgId || null,
    position || null,
    hireDate || null
  );
  return findTechnician(id);
}

// Admin can't look a PIN back up once it's hashed -- by design, same as any
// real password -- so the fix for "this technician forgot their PIN" is
// issuing them a new one, not reading back the old one. Overwrites the
// login hash only; nothing about the technician's own record changes.
function setTechnicianPin(techId, pin) {
  db.prepare("UPDATE technicians SET pin = ? WHERE id = ?").run(hashPin(pin), techId);
  return findTechnician(techId);
}

function countTechnicianAllocatedHours(id) {
  const { total } = db.prepare("SELECT COALESCE(SUM(hours), 0) AS total FROM allocations WHERE tech_id = ?").get(id);
  return total;
}

// A technician created by mistake -- a test entry, a typo'd ID, real data
// typed into the wrong row -- should just go away rather than sit around
// under some employment status forever. Blocked by default if they have any
// allocated hours on record (force removes the whole history along with
// them: allocations, UKG hours, weeks, onboarding progress, devices/device
// requests, and any active session -- but never their uploaded
// files/forms, same as a WOM's own documents surviving a WOM delete,
// since those aren't this technician's identity, just attachments that
// can be re-linked or cleaned up separately). Never touches an admin
// account -- this only ever looks at role = 'tech' rows, same as every
// other /technicians/:id route.
function deleteTechnician(id, { force = false } = {}) {
  const tech = findTechnician(id);
  if (!tech || tech.role !== "tech") return { error: "not_found" };
  const allocatedHours = countTechnicianAllocatedHours(id);
  if (allocatedHours > 0 && !force) {
    return { error: "has_allocations", allocatedHours };
  }
  db.prepare("DELETE FROM device_requests WHERE device_id IN (SELECT id FROM tech_devices WHERE tech_id = ?)").run(id);
  db.prepare("DELETE FROM tech_devices WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM onboarding_progress WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM allocations WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM ukg_hours WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM weeks WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE tech_id = ?").run(id);
  db.prepare("DELETE FROM technicians WHERE id = ?").run(id);
  return { ok: true, allocatedHoursRemoved: allocatedHours };
}

// ---- Admin accounts ----
// Admins live in the same technicians table (role = 'admin') so login,
// sessions, and the active/employment_status gate are all the exact same
// mechanism already built for technicians -- deactivating a departing
// admin's account (instead of deleting it) blocks their login without
// touching any audit entry, since addAudit stores the actor's name in the
// details string at write time, not a live lookup.

function listAdmins() {
  return db.prepare("SELECT * FROM technicians WHERE role = 'admin' ORDER BY rowid").all();
}

function createAdmin({ id, name, pin }) {
  db.prepare(
    `INSERT INTO technicians (id, name, pin, role, active, employment_status)
     VALUES (?, ?, ?, 'admin', 1, 'active')`
  ).run(id, name, hashPin(pin));
  return findTechnician(id);
}

// Legal name changes, a typo at creation, or just a seeded demo name
// (the account someone's actually using day to day) needing to read right.
// Scoped to role = 'admin' -- there's no equivalent rename for a
// technician yet, since nothing's asked for one.
function renameAdmin(id, name) {
  db.prepare("UPDATE technicians SET name = ? WHERE id = ? AND role = 'admin'").run(name, id);
  return findTechnician(id);
}

// An admin's own record-keeping details (home location, UKG ID, hire date)
// -- real columns a technician row already has, but an admin account never
// had a way to set them, since none of this feeds any admin-side logic the
// way it does for a technician's allocations/scheduling. Scoped to exactly
// these three columns (unlike setTechnicianBasicInfo, which overwrites
// every basic-info field at once) since an admin account has never set
// email/phone/position/terminationDate/standardDailyHours and this
// shouldn't be the thing that silently blanks them out if that ever
// changes.
function setAdminBasicInfo(id, { ukgId, hireDate, homeLocationCode }) {
  db.prepare("UPDATE technicians SET ukg_id = ?, hire_date = ?, home_location_code = ? WHERE id = ? AND role = 'admin'").run(
    ukgId || null,
    hireDate || null,
    homeLocationCode || null,
    id
  );
  return findTechnician(id);
}

function setTechnicianBasicInfo(techId, { email, phone, ukgId, position, hireDate, terminationDate, standardDailyHours }) {
  db.prepare(
    `UPDATE technicians
     SET email = ?, phone = ?, ukg_id = ?, position = ?, hire_date = ?, termination_date = ?, standard_daily_hours = ?
     WHERE id = ?`
  ).run(
    email || null,
    phone || null,
    ukgId || null,
    position || null,
    hireDate || null,
    terminationDate || null,
    standardDailyHours === "" || standardDailyHours == null ? null : Number(standardDailyHours),
    techId
  );
  return findTechnician(techId);
}

// A technician's own choice of how they hear "your hours are ready to
// allocate": the in-app banner always shows regardless of this, but 'email'
// additionally sends a real email (requires the technician to have an email
// on file -- see server/utils/mailer.js and the ukg-hours route).
const NOTIFICATION_PREFS = ["in_app", "email"];

function setNotificationPref(techId, pref) {
  db.prepare("UPDATE technicians SET notification_pref = ? WHERE id = ?").run(pref, techId);
  return findTechnician(techId);
}

// A fixed checklist for now rather than an admin-editable template — the
// simplest version that's still a real, working checklist per technician.
const ONBOARDING_TASKS = [
  { key: "ukg_account", label: "UKG account created" },
  { key: "badge_issued", label: "Badge issued" },
  { key: "safety_training", label: "Safety training completed" },
  { key: "uniform_issued", label: "Uniform issued" },
  { key: "vehicle_assigned", label: "Vehicle assigned" },
];

function getOnboardingProgress(techId) {
  const rows = db.prepare("SELECT task_key, completed_at FROM onboarding_progress WHERE tech_id = ?").all(techId);
  const completedByKey = Object.fromEntries(rows.map((r) => [r.task_key, r.completed_at]));
  return ONBOARDING_TASKS.map((t) => ({ ...t, completedAt: completedByKey[t.key] || null }));
}

function setOnboardingTask(techId, taskKey, completed) {
  if (completed) {
    db.prepare(
      "INSERT INTO onboarding_progress (tech_id, task_key, completed_at) VALUES (?, ?, ?) ON CONFLICT (tech_id, task_key) DO UPDATE SET completed_at = excluded.completed_at"
    ).run(techId, taskKey, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM onboarding_progress WHERE tech_id = ? AND task_key = ?").run(techId, taskKey);
  }
  return getOnboardingProgress(techId);
}

// ---- Devices ----

const DEVICE_TYPES = ["phone", "laptop", "ipad"];

function listDeviceRequests(deviceId) {
  return db
    .prepare(
      `SELECT id, request_type AS requestType, reference_number AS referenceNumber,
              requested_at AS requestedAt, completed_at AS completedAt
       FROM device_requests WHERE device_id = ? ORDER BY id DESC`
    )
    .all(deviceId);
}

function listDevices(techId) {
  const devices = db
    .prepare(
      "SELECT id, device_type AS deviceType, device_name AS deviceName, notes, plan, assigned_at AS assignedAt FROM tech_devices WHERE tech_id = ? ORDER BY id DESC"
    )
    .all(techId);
  return devices.map((d) => ({ ...d, requests: listDeviceRequests(d.id) }));
}

function addDevice(techId, deviceType, deviceName, notes, plan) {
  db.prepare(
    "INSERT INTO tech_devices (tech_id, device_type, device_name, notes, plan, assigned_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(techId, deviceType, deviceName, notes || "", plan || "", new Date().toISOString());
  return listDevices(techId);
}

function removeDevice(techId, id) {
  db.prepare("DELETE FROM device_requests WHERE device_id = ?").run(id);
  db.prepare("DELETE FROM tech_devices WHERE id = ? AND tech_id = ?").run(id, techId);
  return listDevices(techId);
}

function findDevice(techId, id) {
  return db.prepare("SELECT id FROM tech_devices WHERE id = ? AND tech_id = ?").get(id, techId);
}

// A "Calero" (or similar telecom/IT vendor) request against a device --
// e.g. a line cancellation -- tracked with a reference number so it can be
// followed up on until marked complete.
function addDeviceRequest(deviceId, requestType, referenceNumber) {
  db.prepare(
    "INSERT INTO device_requests (device_id, request_type, reference_number, requested_at) VALUES (?, ?, ?, ?)"
  ).run(deviceId, requestType, referenceNumber || "", new Date().toISOString());
  return listDeviceRequests(deviceId);
}

function setDeviceRequestCompleted(deviceId, requestId, completed) {
  db.prepare("UPDATE device_requests SET completed_at = ? WHERE id = ? AND device_id = ?").run(
    completed ? new Date().toISOString() : null,
    requestId,
    deviceId
  );
  return listDeviceRequests(deviceId);
}

function setDeviceRequestDetails(deviceId, requestId, { requestType, referenceNumber }) {
  db.prepare("UPDATE device_requests SET request_type = ?, reference_number = ? WHERE id = ? AND device_id = ?").run(
    requestType,
    referenceNumber || "",
    requestId,
    deviceId
  );
  return listDeviceRequests(deviceId);
}

// ---- Vendors ----
//
// A vendor onboarding/compliance tracker (JDE vendor record, C&W approval,
// Toyota approval, forms currency) -- separate from technicians/locations
// since a vendor isn't a person who logs in or a place work happens, just a
// company being tracked for onboarding/compliance status.

const CW_STATUSES = ["active", "inactive", "unknown"];
const TOYOTA_STATUSES = ["approved", "not_approved", "unknown"];
const FORMS_STATUSES = ["current", "outdated", "unknown"];

// The fixed set of COI (Certificate of Insurance) coverage types tracked
// per vendor -- matches the real vendor tracker's columns. Values are free
// text (e.g. "$1M", "-") rather than numbers, since "-" (not required for
// this vendor's service type) is a valid, common value.
const VENDOR_COI_FIELDS = [
  ["glLiabilityOcc", "coi_gl_liability_occ"],
  ["glLiabilityAgg", "coi_gl_liability_agg"],
  ["autoLiability", "coi_auto_liability"],
  ["workersComp", "coi_workers_comp"],
  ["umbrellaLiability", "coi_umbrella_liability"],
  ["eAndO", "coi_e_and_o"],
  ["pollution", "coi_pollution"],
  ["crime", "coi_crime"],
  ["productsComplOpAgg", "coi_products_compl_op_agg"],
];

// Specific compliance checks verified against the actual attached document
// -- distinct from coiMeetsRequiredLimits/coiMeetsLanguageRequirements
// (coverage amounts) above, and from formsStatus (currency/expiration).
// A vendor with any of these unchecked shows up as needing attention
// (formChecksComplete below), same idea as an outdated form.
const VENDOR_FORM_CHECK_FIELDS = [
  ["coiIsAcord25_2016_03", "coi_is_acord25_2016_03"],
  ["coiMatchesW9", "coi_matches_w9"],
  ["w9SignedDated", "w9_signed_dated"],
  ["w9CorrectVersion", "w9_correct_version"],
  ["w9HasPhone", "w9_has_phone"],
  ["w9HasRemitToAddress", "w9_has_remit_to_address"],
  ["w9HasName", "w9_has_name"],
  ["achBankLetterhead", "ach_bank_letterhead"],
  ["achHasW9Name", "ach_has_w9_name"],
  ["achHasW9Address", "ach_has_w9_address"],
];

const W9_INVOICE_MAX_AGE_YEARS = 2;

// How much contracted-services $ this vendor has actually been paid across
// every WOM linked to them, and when they were last invoiced -- pulled from
// the WOM lifecycle checklist's own "invoiced" step timestamp (see
// wom_lifecycle_steps), since that's the one point in the checklist that
// means "this job, and this vendor's charge on it, is done and billed."
// null lastInvoicedAt just means none of this vendor's WOMs have reached
// that step yet.
function getVendorContractedSummary(vendorId) {
  const spend = db
    .prepare(
      "SELECT COALESCE(SUM(applied_contracted), 0) as total, COUNT(*) as womCount FROM woms WHERE vendor_id = ? AND applied_contracted IS NOT NULL AND status != 'cancelled'"
    )
    .get(vendorId);
  const lastInvoiced = db
    .prepare(
      `SELECT MAX(wls.completed_at) as lastInvoicedAt FROM wom_lifecycle_steps wls
       JOIN woms w ON w.code = wls.wom_code WHERE w.vendor_id = ? AND wls.step_key = 'invoiced'`
    )
    .get(vendorId);
  return {
    totalContractedApplied: spend.total || 0,
    contractedWomCount: spend.womCount || 0,
    lastInvoicedAt: lastInvoiced ? lastInvoiced.lastInvoicedAt : null,
  };
}

function presentVendorRow(v) {
  const coiLimits = {};
  for (const [key, col] of VENDOR_COI_FIELDS) coiLimits[key] = v[col] || "";

  const formChecks = {};
  for (const [key, col] of VENDOR_FORM_CHECK_FIELDS) formChecks[key] = Boolean(v[col]);
  const formChecksComplete = VENDOR_FORM_CHECK_FIELDS.every(([key]) => formChecks[key]);

  let w9InvoiceStale = false;
  if (v.w9_invoice_date) {
    const maxAge = new Date(v.w9_invoice_date);
    maxAge.setFullYear(maxAge.getFullYear() + W9_INVOICE_MAX_AGE_YEARS);
    w9InvoiceStale = maxAge < new Date();
  }

  return {
    id: v.id,
    name: v.name,
    jdeVendorNumber: v.jde_vendor_number,
    cwStatus: v.cw_status,
    toyotaStatus: v.toyota_status,
    formsStatus: v.forms_status,
    rawStatusText: v.raw_status_text,
    poEmail: v.po_email,
    invoicedPreviously: v.invoiced_previously,
    successfulInvoiceRecords: v.successful_invoice_records,
    successfulSinceDate: v.successful_since_date,
    midwestSitesSeen: v.midwest_sites_seen,
    services: v.services,
    trackerWorkExamples: v.tracker_work_examples,
    coverageOutsideMidwest: v.coverage_outside_midwest,
    phone: v.phone,
    email: v.email,
    onlineSourceUrl: v.online_source_url,
    notes: v.notes,
    coiMeetsRequiredLimits: Boolean(v.coi_meets_required_limits),
    coiMeetsLanguageRequirements: Boolean(v.coi_meets_language_requirements),
    coiLimits,
    formChecks,
    formChecksComplete,
    w9InvoiceDate: v.w9_invoice_date || null,
    w9InvoiceStale,
    onboardingStage: v.onboarding_stage,
    deniedReason: v.denied_reason || "",
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    ...getVendorContractedSummary(v.id),
  };
}

const ONBOARDING_STAGES = ["not_started", "in_progress", "denied", "onboarded"];

function listVendors() {
  return db.prepare("SELECT * FROM vendors ORDER BY name").all().map(presentVendorRow);
}

function findVendor(id) {
  const row = db.prepare("SELECT * FROM vendors WHERE id = ?").get(Number(id));
  return row ? presentVendorRow(row) : null;
}

function createVendor(fields) {
  const now = new Date().toISOString();
  const coiLimits = fields.coiLimits || {};
  const formChecks = fields.formChecks || {};
  const columns = [
    "name",
    "jde_vendor_number",
    "cw_status",
    "toyota_status",
    "forms_status",
    "raw_status_text",
    "po_email",
    "invoiced_previously",
    "successful_invoice_records",
    "successful_since_date",
    "midwest_sites_seen",
    "services",
    "tracker_work_examples",
    "coverage_outside_midwest",
    "phone",
    "email",
    "online_source_url",
    "notes",
    "coi_meets_required_limits",
    "coi_meets_language_requirements",
    ...VENDOR_COI_FIELDS.map(([, col]) => col),
    ...VENDOR_FORM_CHECK_FIELDS.map(([, col]) => col),
    "w9_invoice_date",
    "onboarding_stage",
    "denied_reason",
    "created_at",
    "updated_at",
  ];
  const values = [
    fields.name,
    fields.jdeVendorNumber || null,
    fields.cwStatus || "unknown",
    fields.toyotaStatus || "unknown",
    fields.formsStatus || "unknown",
    fields.rawStatusText || "",
    fields.poEmail || "",
    fields.invoicedPreviously || "",
    fields.successfulInvoiceRecords == null ? null : Number(fields.successfulInvoiceRecords),
    fields.successfulSinceDate || null,
    fields.midwestSitesSeen || "",
    fields.services || "",
    fields.trackerWorkExamples || "",
    fields.coverageOutsideMidwest || "",
    fields.phone || "",
    fields.email || "",
    fields.onlineSourceUrl || "",
    fields.notes || "",
    fields.coiMeetsRequiredLimits ? 1 : 0,
    fields.coiMeetsLanguageRequirements ? 1 : 0,
    ...VENDOR_COI_FIELDS.map(([key]) => coiLimits[key] || ""),
    ...VENDOR_FORM_CHECK_FIELDS.map(([key]) => (formChecks[key] ? 1 : 0)),
    fields.w9InvoiceDate || null,
    // Adding a vendor here is, in practice, the start of onboarding it --
    // default to "in_progress" rather than "not_started" so it shows up on
    // the Onboarding tab immediately, without an extra step.
    ONBOARDING_STAGES.includes(fields.onboardingStage) ? fields.onboardingStage : "in_progress",
    fields.deniedReason || "",
    now,
    now,
  ];
  const result = db
    .prepare(`INSERT INTO vendors (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...values);
  return findVendor(result.lastInsertRowid);
}

function updateVendor(id, fields) {
  const existing = findVendor(id);
  if (!existing) return null;
  const coiLimits = fields.coiLimits || {};
  const formChecks = fields.formChecks || {};
  db.prepare(
    `UPDATE vendors SET
      name = ?, jde_vendor_number = ?, cw_status = ?, toyota_status = ?, forms_status = ?,
      raw_status_text = ?, po_email = ?, invoiced_previously = ?, successful_invoice_records = ?,
      successful_since_date = ?, midwest_sites_seen = ?, services = ?, tracker_work_examples = ?,
      coverage_outside_midwest = ?, phone = ?, email = ?, online_source_url = ?, notes = ?,
      coi_meets_required_limits = ?, coi_meets_language_requirements = ?,
      ${VENDOR_COI_FIELDS.map(([, col]) => `${col} = ?`).join(", ")},
      ${VENDOR_FORM_CHECK_FIELDS.map(([, col]) => `${col} = ?`).join(", ")},
      w9_invoice_date = ?,
      onboarding_stage = ?,
      denied_reason = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    fields.name,
    fields.jdeVendorNumber || null,
    fields.cwStatus || "unknown",
    fields.toyotaStatus || "unknown",
    fields.formsStatus || "unknown",
    fields.rawStatusText || "",
    fields.poEmail || "",
    fields.invoicedPreviously || "",
    fields.successfulInvoiceRecords == null ? null : Number(fields.successfulInvoiceRecords),
    fields.successfulSinceDate || null,
    fields.midwestSitesSeen || "",
    fields.services || "",
    fields.trackerWorkExamples || "",
    fields.coverageOutsideMidwest || "",
    fields.phone || "",
    fields.email || "",
    fields.onlineSourceUrl || "",
    fields.notes || "",
    fields.coiMeetsRequiredLimits ? 1 : 0,
    fields.coiMeetsLanguageRequirements ? 1 : 0,
    ...VENDOR_COI_FIELDS.map(([key]) => coiLimits[key] || ""),
    ...VENDOR_FORM_CHECK_FIELDS.map(([key]) => (formChecks[key] ? 1 : 0)),
    fields.w9InvoiceDate || null,
    ONBOARDING_STAGES.includes(fields.onboardingStage) ? fields.onboardingStage : existing.onboardingStage,
    fields.deniedReason != null ? fields.deniedReason : existing.deniedReason,
    new Date().toISOString(),
    Number(id)
  );
  return findVendor(id);
}

function deleteVendor(id) {
  const vendor = findVendor(id);
  if (!vendor) return null;
  db.prepare("DELETE FROM vendor_requests WHERE vendor_id = ?").run(Number(id));
  db.prepare("DELETE FROM vendors WHERE id = ?").run(Number(id));
  return vendor;
}

// A vendor onboarding/compliance case (e.g. a ServiceEdge COI Case, Toyota
// Onboarding Case, Payment Details Case) tracked with a reference/case
// number and a free-text status -- the real tracker uses varied statuses
// ("Approved", "Waiting", "Denied - No Response - Start over Case") that
// don't reduce cleanly to a fixed enum, so status is left as free text
// rather than force-fitting it. Four request_type values are treated as
// the canonical onboarding cases (matching ServiceEdge's own case types
// exactly, so entering one here means the same thing it does there); any
// other request_type is still logged and shown, it just isn't one of the
// cases that drives onboardingStage below.
const ONBOARDING_CASE_TYPES = [
  { type: "Onboarding - Request", key: "request", label: "Welcome Email / Request" },
  { type: "Onboarding - COI", key: "coi", label: "COI" },
  { type: "Onboarding - W8/W9", key: "w9", label: "W-9" },
  { type: "Onboarding - Payment Details", key: "payment", label: "Payment / ACH" },
];
const ONBOARDING_CASE_TYPE_BY_KEY = Object.fromEntries(ONBOARDING_CASE_TYPES.map((c) => [c.key, c.type]));

function listVendorRequests(vendorId) {
  return db
    .prepare(
      `SELECT id, request_type AS requestType, reference_number AS referenceNumber, status, note, as_of AS asOf,
              requested_at AS requestedAt, updated_at AS updatedAt
       FROM vendor_requests WHERE vendor_id = ? ORDER BY id DESC`
    )
    .all(vendorId);
}

// The vendor's overall onboarding stage is derived from the latest case of
// each of the three required types (COI, W-9, Payment) rather than stored
// by hand -- ServiceEdge itself works this way: re-submitting after a
// denial opens a brand new case rather than editing the old one, so
// "current status" always means the most recently touched case of that
// type. All three approved moves the vendor to onboarded; any one denied
// (as its latest case) moves the vendor to denied; any case activity at
// all short of that is in_progress; no case activity yet is not_started.
function latestRequestOfType(vendorId, requestType) {
  return db
    .prepare(
      `SELECT * FROM vendor_requests WHERE vendor_id = ? AND request_type = ? ORDER BY updated_at DESC, id DESC LIMIT 1`
    )
    .get(vendorId, requestType);
}

function deriveOnboardingStage(vendorId) {
  const request = latestRequestOfType(vendorId, ONBOARDING_CASE_TYPE_BY_KEY.request);
  const coi = latestRequestOfType(vendorId, ONBOARDING_CASE_TYPE_BY_KEY.coi);
  const w9 = latestRequestOfType(vendorId, ONBOARDING_CASE_TYPE_BY_KEY.w9);
  const payment = latestRequestOfType(vendorId, ONBOARDING_CASE_TYPE_BY_KEY.payment);
  const norm = (r) => (r ? String(r.status || "").trim().toLowerCase() : "");
  const required = [coi, w9, payment];
  if (required.some((r) => norm(r) === "denied")) return "denied";
  if (required.every((r) => r && norm(r) === "approved")) return "onboarded";
  if (request || coi || w9 || payment) return "in_progress";
  return "not_started";
}

function syncOnboardingStage(vendorId) {
  const stage = deriveOnboardingStage(vendorId);
  db.prepare("UPDATE vendors SET onboarding_stage = ? WHERE id = ?").run(stage, vendorId);
  return stage;
}

// One row per vendor that has any onboarding case activity at all, each
// showing the latest case of each of the four canonical types -- the bulk
// read behind the Onboarding board, so it can show every vendor's case
// status without an API round trip per vendor.
function listOnboardingCaseSummaries() {
  const rows = db
    .prepare(
      `SELECT vendor_id AS vendorId, request_type AS requestType, reference_number AS referenceNumber,
              status, note, as_of AS asOf, updated_at AS updatedAt
       FROM vendor_requests ORDER BY updated_at ASC, id ASC`
    )
    .all();
  const typeToKey = Object.fromEntries(ONBOARDING_CASE_TYPES.map((c) => [c.type, c.key]));
  const summaries = {};
  for (const r of rows) {
    const key = typeToKey[r.requestType];
    if (!key) continue;
    if (!summaries[r.vendorId]) summaries[r.vendorId] = {};
    summaries[r.vendorId][key] = { referenceNumber: r.referenceNumber, status: r.status, note: r.note, asOf: r.asOf, updatedAt: r.updatedAt };
  }
  return summaries;
}

function addVendorRequest(vendorId, requestType, referenceNumber, status, note, asOf) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO vendor_requests (vendor_id, request_type, reference_number, status, note, as_of, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(vendorId, requestType, referenceNumber || "", status || "", note || "", asOf || now.slice(0, 10), now, now);
  touchVendorActivity(vendorId);
  syncOnboardingStage(vendorId);
  return listVendorRequests(vendorId);
}

function updateVendorRequest(vendorId, requestId, { requestType, referenceNumber, status, note, asOf }) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE vendor_requests SET request_type = ?, reference_number = ?, status = ?, note = ?, as_of = ?, updated_at = ? WHERE id = ? AND vendor_id = ?"
  ).run(requestType, referenceNumber || "", status || "", note || "", asOf || now.slice(0, 10), now, requestId, vendorId);
  touchVendorActivity(vendorId);
  syncOnboardingStage(vendorId);
  return listVendorRequests(vendorId);
}

// A case-log touch is real onboarding activity even though it isn't a
// field on the vendor row itself -- bump the vendor's own updated_at too,
// since that's what staleness (see vendorOnboardingSummary) is read from.
function touchVendorActivity(vendorId) {
  db.prepare("UPDATE vendors SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), vendorId);
}

function deleteVendorRequest(vendorId, requestId) {
  db.prepare("DELETE FROM vendor_requests WHERE id = ? AND vendor_id = ?").run(requestId, vendorId);
  syncOnboardingStage(vendorId);
  return listVendorRequests(vendorId);
}

// ---- Allocation history ----

function getAllocationHistory(techId) {
  return db
    .prepare(
      `SELECT a.week_monday AS weekMonday, a.day, a.type, a.location_code AS locationCode, a.wom_code AS womCode, a.hours,
              w.status AS weekStatus
       FROM allocations a
       LEFT JOIN weeks w ON w.tech_id = a.tech_id AND w.week_monday = a.week_monday
       WHERE a.tech_id = ?
       ORDER BY a.week_monday DESC, a.id ASC`
    )
    .all(techId);
}

// ---- Locations ----

function listLocations() {
  return db.prepare("SELECT * FROM locations ORDER BY name").all();
}

function findLocation(code) {
  return db.prepare("SELECT * FROM locations WHERE code = ?").get(code);
}

function createLocation(code, name, efJobNumber, region, womJobNumber, territory) {
  db.prepare(
    "INSERT INTO locations (code, name, ef_job_number, region, wom_job_number, territory) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(code, name, efJobNumber || null, region || null, womJobNumber || null, territory || "Midwest");
  return findLocation(code);
}

function setLocationDetails(code, { name, efJobNumber, region, womJobNumber, territory } = {}) {
  if (!findLocation(code)) return null;
  db.prepare(
    "UPDATE locations SET name = ?, ef_job_number = ?, region = ?, wom_job_number = ?, territory = ? WHERE code = ?"
  ).run(name, efJobNumber || null, region || null, womJobNumber || null, territory || "Midwest", code);
  return findLocation(code);
}

// A location referenced anywhere -- a technician's home location, a WOM's
// own location, or a raw E&F allocation -- can't just be deleted out from
// under those records the way a never-used one can. Unlike WOM delete,
// there's no "force" option here: reassigning a whole location's worth of
// technicians/WOMs/history is too large a blast radius for a single
// confirm click, so the caller has to actually reassign those first.
function deleteLocation(code) {
  if (!findLocation(code)) return { error: "not_found" };
  const technicianCount = db.prepare("SELECT COUNT(*) AS n FROM technicians WHERE home_location_code = ?").get(code).n;
  const womCount = db.prepare("SELECT COUNT(*) AS n FROM woms WHERE location_code = ?").get(code).n;
  const allocationCount = db.prepare("SELECT COUNT(*) AS n FROM allocations WHERE location_code = ?").get(code).n;
  if (technicianCount > 0 || womCount > 0 || allocationCount > 0) {
    return { error: "in_use", technicianCount, womCount, allocationCount };
  }
  db.prepare("DELETE FROM locations WHERE code = ?").run(code);
  return { ok: true };
}

// ---- WOMs ----

function womWithRemaining(wom) {
  if (!wom) return wom;
  if (wom.budget_hours == null) return { ...wom, usedHours: null, remainingHours: null };
  const { total } = db.prepare("SELECT COALESCE(SUM(hours), 0) AS total FROM allocations WHERE wom_code = ?").get(wom.code);
  return { ...wom, usedHours: total, remainingHours: round2(wom.budget_hours - total) };
}

function listWoms() {
  return db.prepare("SELECT * FROM woms ORDER BY rowid").all().map(womWithRemaining);
}

function findWom(code) {
  return womWithRemaining(db.prepare("SELECT * FROM woms WHERE code = ?").get(code));
}

function createWom(code, description, locationCode, budgetHours, subsidiaryCode, maximoNumber) {
  db.prepare(
    "INSERT INTO woms (code, description, status, location_code, budget_hours, subsidiary_code, maximo_number) VALUES (?, ?, 'open', ?, ?, ?, ?)"
  ).run(
    code,
    description,
    locationCode || null,
    budgetHours == null ? null : Number(budgetHours),
    subsidiaryCode || null,
    maximoNumber || null
  );
  return findWom(code);
}

// budget_hours can be null (womWithRemaining then leaves usedHours null too),
// so this is the one place that always answers "does this WOM actually have
// any hours logged against it" regardless of whether a budget was ever set.
function countWomAllocatedHours(code) {
  const { total } = db.prepare("SELECT COALESCE(SUM(hours), 0) AS total FROM allocations WHERE wom_code = ?").get(code);
  return total;
}

// The per-technician breakdown behind "WOM Lookup" -- every technician who's
// ever logged time against this WOM, all-time (not scoped to a month), and
// how much. `type = 'wom'` matters here since wom_code doubles as the
// time-off type on timeoff rows -- excludes those even though no real WOM
// code should ever collide with one.
function womHoursByTechnician(code) {
  return db
    .prepare(
      `SELECT a.tech_id AS techId, t.name AS techName, SUM(a.hours) AS hours
       FROM allocations a JOIN technicians t ON t.id = a.tech_id
       WHERE a.wom_code = ? AND a.type = 'wom'
       GROUP BY a.tech_id
       ORDER BY hours DESC`
    )
    .all(code);
}

// A WOM created by mistake (a test entry, a typo) should just go away
// rather than sit around forever with a status. Deleting one that already
// has hours allocated against it would silently pull those hours out from
// under whatever technician week they're on, so that's blocked unless the
// caller explicitly passes force -- at which point those allocation rows
// are removed right along with it.
function deleteWom(code, { force = false } = {}) {
  if (!findWom(code)) return { error: "not_found" };
  const allocatedHours = countWomAllocatedHours(code);
  if (allocatedHours > 0 && !force) {
    return { error: "has_allocations", allocatedHours };
  }
  if (allocatedHours > 0) {
    db.prepare("DELETE FROM allocations WHERE wom_code = ?").run(code);
  }
  db.prepare("DELETE FROM woms WHERE code = ?").run(code);
  return { ok: true, allocatedHoursRemoved: allocatedHours };
}

// "pending" is a WOM request that's been added to the Smartsheet tracker but
// that RFM hasn't yet requested a Toyota PO for. "requested" is the next
// step -- RFM has asked Toyota to generate the WOM/PO (the tracker's own
// "Date Requested" column gets filled in when that happens), but there's
// still no real WOM # yet, so nothing can be billed to Toyota for it. A
// technician can't allocate hours against either "pending" or "requested"
// -- only a real WOM # (status "open") means the job exists and can
// actually be billed; until then the request just sits (see
// syncWomsFromSheetRows below, which sets these two apart automatically
// from the sheet's own columns, no manual step needed). "invoiced" and
// "closed" are both "done and billed" -- "closed" is just the later, fully
// closed-out point of the same billed job, so the two are grouped together
// everywhere they're displayed (see the WOM Projects tab). "cancelled" is
// the other way a job ends -- never billed, the work was declined or
// dropped -- and is tracked separately from both so a cancelled job never
// gets counted as billed revenue. Any status is settable by an admin at any
// time (see routes/woms.js), independent of a technician's own "mark
// complete" action, which only ever sets "closed" directly.
const WOM_STATUSES = ["pending", "requested", "open", "invoiced", "cancelled", "closed"];

function setWomStatus(code, status, { changedBy, source } = {}) {
  const existing = findWom(code);
  if (!existing) return null;
  db.prepare("UPDATE woms SET status = ? WHERE code = ?").run(status, code);
  // Closing it here doesn't close it on the external Smartsheet tracker --
  // clear any prior "reflected" mark so it shows up needing a manual update
  // again. Moving away from closed (reopened) also clears it, so a later
  // re-close starts fresh rather than staying marked from the last time.
  // Only on an actual transition, though -- a redundant re-close (e.g. a
  // double-submitted "mark complete") shouldn't wipe out a flag admin
  // already cleared.
  if (existing.status !== status) {
    db.prepare("UPDATE woms SET smartsheet_reflected_at = NULL WHERE code = ?").run(code);
    recordWomStatusChange(code, "status", existing.status, status, {
      changedAt: new Date().toISOString(),
      changedBy: changedBy || null,
      source: source || "status_change",
    });
  }
  return findWom(code);
}

// ---- WOM lifecycle checklist ----
//
// One persistent task per WOM (not recreated per stage the way an earlier
// version of this worked) that just fills in as real events happen: create
// WOM request -> send PSE to Toyota -> create WOM & PO -> schedule vendor
// -> work complete -> post applied cost -> review charges -> invoice. Each
// step either completes itself the moment its underlying data changes
// (checkWomLifecycleAutoSteps, called after every sync and every relevant
// admin edit) or is completed by a button click from whoever holds its
// role. The whole checklist -- who did what, and when -- sits permanently
// on the task once done, the same way a WOM's own file attachments already
// do, rather than being thrown away once the WOM moves on.
//
// Two roles split the manual steps: "reviewer" (RFM -- sends PSE to
// Toyota) and "financial" (any other active admin -- creates the WOM/PO,
// posts cost, invoices). "Review charges" has no single owner: either role
// can complete it, matching how that step is actually done in practice
// (whoever gets to it first).
function getPseReviewerId() {
  const row = db.prepare("SELECT id FROM technicians WHERE role = 'admin' AND is_pse_reviewer = 1").get();
  return row ? row.id : null;
}

// Exactly one admin at a time -- setting a new reviewer always clears
// whoever held it before, rather than requiring a separate "remove" step.
function setPseReviewer(adminId) {
  db.prepare("UPDATE technicians SET is_pse_reviewer = 0 WHERE role = 'admin'").run();
  if (adminId) db.prepare("UPDATE technicians SET is_pse_reviewer = 1 WHERE id = ? AND role = 'admin'").run(adminId);
}

// Nobody designated yet shouldn't lock reviewer-only steps out entirely --
// until that one-time setup happens, any admin can take either role.
function pseRoleFor(adminId) {
  const reviewer = getPseReviewerId();
  if (!reviewer) return null; // null = "any role allowed", checked below
  return adminId === reviewer ? "reviewer" : "financial";
}

const WOM_LIFECYCLE_STEPS = [
  { key: "sent_to_toyota", label: "Send PSE to Toyota", role: "reviewer", trigger: "manual" },
  { key: "wom_po_created", label: "Create WOM & PO", role: "financial", trigger: "auto" },
  { key: "vendor_scheduled", label: "Schedule vendor", role: "tech", trigger: "auto" },
  { key: "work_complete", label: "Work complete", role: "tech", trigger: "auto" },
  { key: "cost_applied", label: "Post applied cost", role: "financial", trigger: "auto" },
  { key: "charges_reviewed", label: "Review charges", role: null, trigger: "manual" },
  { key: "invoiced", label: "Invoice", role: "financial", trigger: "manual" },
];

function lifecycleTaskSourceKey(womCode) {
  return `WOM-${womCode}-LIFECYCLE`;
}

// Every step definition plus its completion state for one WOM -- a step
// with no row in wom_lifecycle_steps yet is simply incomplete.
function getWomLifecycleSteps(code) {
  const rows = db.prepare("SELECT * FROM wom_lifecycle_steps WHERE wom_code = ?").all(code);
  const byKey = Object.fromEntries(rows.map((r) => [r.step_key, r]));
  return WOM_LIFECYCLE_STEPS.map((step) => ({
    ...step,
    completedAt: byKey[step.key] ? byKey[step.key].completed_at : null,
    completedBy: byKey[step.key] ? byKey[step.key].completed_by : null,
  }));
}

// Which step is "next" for queue-routing purposes (assignedRole) -- not
// simply the first incomplete step in the fixed list order, since steps can
// complete out of order (see the comment on WOM_LIFECYCLE_STEPS). A WOM
// synced in from Smartsheet with a Maximo/PO # already on file has plainly
// already been through Toyota approval, even though nobody's clicked
// "Send PSE to Toyota" in this app to log it -- most of the existing
// backlog is in exactly this shape on day one of this feature. Picking the
// first incomplete step overall would leave every one of those stuck
// showing as the RFM's problem forever, even once a tech has genuinely
// moved it forward (e.g. scheduling the vendor). Instead, this finds the
// furthest-completed step and returns whichever step right after it is
// still open -- so real progress (a later step completing) moves the
// task's queue forward even if an earlier step's box was never checked.
// The checklist display itself is unaffected -- every step still shows its
// own true completion state regardless of this.
function nextLifecycleStep(steps) {
  let lastDoneIndex = -1;
  steps.forEach((s, i) => {
    if (s.completedAt) lastDoneIndex = i;
  });
  for (let i = lastDoneIndex + 1; i < steps.length; i++) {
    if (!steps[i].completedAt) return steps[i];
  }
  // Nothing open after the furthest point reached -- but an earlier step
  // can still be a lingering unfilled gap (e.g. "sent to Toyota" never
  // logged even though everything after it, including invoicing, is done).
  // Surface that rather than treating the checklist as if nothing were
  // left, so the task stays routed to whoever owns that gap.
  return steps.find((s) => !s.completedAt) || null;
}

// Idempotent and never re-stamps an already-complete step -- safe to call
// as often as needed without corrupting when a step actually completed.
function markWomLifecycleStepComplete(code, stepKey, completedBy) {
  const existing = db.prepare("SELECT 1 FROM wom_lifecycle_steps WHERE wom_code = ? AND step_key = ?").get(code, stepKey);
  if (existing) return;
  db.prepare("INSERT INTO wom_lifecycle_steps (wom_code, step_key, completed_at, completed_by) VALUES (?, ?, ?, ?)").run(
    code,
    stepKey,
    new Date().toISOString(),
    completedBy || null
  );
}

// Re-syncs the ONE persistent task for this WOM against its current
// checklist state -- assignedRole tracks whichever step is next (so it
// shows in the right person's queue), and the task only ever completes
// once, the moment every step is done. reopenIfClosed: false means a
// finished checklist stays finished even if this gets called again later.
function refreshWomLifecycleTask(code) {
  const wom = findWom(code);
  if (!wom) return;
  const steps = getWomLifecycleSteps(code);
  const nextStep = nextLifecycleStep(steps);
  const sentToToyotaPending = !steps.find((s) => s.key === "sent_to_toyota").completedAt;
  // A change order: the real applied cost is in (so it's not just an
  // in-progress estimate) and it came in higher than what Toyota approved
  // in the original PSE -- Toyota needs to sign off on the difference, so
  // this needs eyes on it same as an unsent PSE does. Purely derived from
  // the WOM's current numbers every time this runs, so it clears itself
  // automatically if a correction brings the applied price back in line.
  const costAppliedDone = Boolean(steps.find((s) => s.key === "cost_applied").completedAt);
  const changeOrder =
    costAppliedDone && wom.applied_price != null && wom.estimated_price != null && wom.applied_price > wom.estimated_price;
  // Money's already gone out (any cost applied at all, not just the
  // contracted-services portion -- a vendor-only job may never have an
  // itemized breakdown on file, only the aggregate), but there's still no
  // real Toyota PO on file -- a billing gap that needs closing before it
  // gets any older. Grouped with a change order under one umbrella since
  // both mean the same thing to RFM: something about this WOM's Toyota
  // paperwork needs attention before it can move on.
  const needsPoOnly = !changeOrder && !wom.maximo_number && (wom.applied_price != null || wom.applied_contracted != null);
  const needsChangeOrderOrPo = changeOrder || needsPoOnly;
  // Once the actual work is done, whatever's left (posting cost, review,
  // invoicing) is pure administrative closeout standing between finished
  // work and getting paid for it -- that's always worth flagging, not just
  // when something's additionally gone wrong.
  const workDone = Boolean(steps.find((s) => s.key === "work_complete").completedAt);
  upsertTaskBySourceKey(
    lifecycleTaskSourceKey(code),
    {
      // Two distinct titles for two distinct problems -- a change order (a
      // real cost overage Toyota needs to sign off on) reads as its own
      // thing, not lumped in with the far more common "just no PO on file
      // yet" gap. isChangeOrder (below) is what actually drives the red-vs-
      // orange badge split; the title just spells out which one this is.
      title: changeOrder
        ? `WOM lifecycle: ${code} -- Needs Toyota PO change order`
        : needsPoOnly
          ? `WOM lifecycle: ${code} -- Needs Toyota PO`
          : `WOM lifecycle: ${code}`,
      description: wom.description,
      category: "wom_workflow",
      // A Toyota paperwork gap is RFM's to chase down regardless of which
      // checklist step the rest of the job's progress would otherwise
      // route it to. "Review charges" has no role GATE (either RFM or
      // Admin can act on it -- see roleAllowed in tasks.js/adminReview.js,
      // which treats a step's own role: null as "anyone"), but that's a
      // permission check, not a queue -- defaulting it to "reviewer" here
      // means it still lands somewhere a person actually looks (RFM's My
      // Work/Team Work) instead of silently falling into the Unassigned
      // list, the one step where that could otherwise happen since every
      // other step has a real owner.
      assignedRole: needsChangeOrderOrPo ? "reviewer" : nextStep ? nextStep.role || "reviewer" : null,
      priority: needsChangeOrderOrPo || sentToToyotaPending || workDone ? "high" : "normal",
      isException: needsChangeOrderOrPo,
      isChangeOrder: changeOrder,
      relatedWomCode: code,
      relatedLocationCode: wom.location_code,
      source: "wom_workflow",
      sourceRecordId: code,
      workflowRule: "wom_lifecycle",
    },
    { reopenIfClosed: false }
  );
  // nextStep can be null while an earlier step is still open (it only looks
  // *after* the furthest-completed one) -- so completion still has to check
  // every step, not just "nothing left after the furthest point reached."
  if (steps.every((s) => s.completedAt)) completeTaskBySourceKey(lifecycleTaskSourceKey(code));
}

// Re-evaluates every auto-trigger step against the WOM's current data and
// marks any newly-satisfied one complete. Called after a sync touches this
// WOM, after an admin hand-edits its pricing/details, after the tech
// "mark complete" action, and lazily for every still-open lifecycle task
// on every task-list read (see refreshAllOpenWomLifecycles) -- so a step
// like "Schedule vendor" (driven by an allocation existing, not any single
// write path this app controls end-to-end) still catches up on its own.
function checkWomLifecycleAutoSteps(code) {
  const wom = findWom(code);
  if (!wom) return;
  const steps = getWomLifecycleSteps(code);
  const isDone = (key) => Boolean(steps.find((s) => s.key === key).completedAt);

  // A WOM that already has a request date on the tracker has plainly
  // already cleared Toyota approval -- most of the existing backlog looks
  // exactly like this, since nobody's going back to click "Send PSE to
  // Toyota" in this app for a job that was already sent before this
  // checklist existed. Fills in a best-effort sent-at date from the
  // tracker's own record; the email stays unset (Smartsheet doesn't
  // capture who it went to), so the "Sent to Toyota: X on Y" line just
  // doesn't show until/unless someone fills that in by hand.
  if (!isDone("sent_to_toyota") && wom.date_requested) {
    markWomLifecycleStepComplete(code, "sent_to_toyota", "sync");
    db.prepare("UPDATE woms SET pse_toyota_sent_at = COALESCE(pse_toyota_sent_at, ?) WHERE code = ?").run(wom.date_requested, code);
  }
  if (!isDone("wom_po_created") && wom.maximo_number) {
    markWomLifecycleStepComplete(code, "wom_po_created", "sync");
  }
  if (!isDone("vendor_scheduled")) {
    const hasAllocation = db.prepare("SELECT 1 FROM allocations WHERE wom_code = ? AND type = 'wom' AND hours > 0 LIMIT 1").get(code);
    if (hasAllocation) markWomLifecycleStepComplete(code, "vendor_scheduled", "sync");
  }
  if (!isDone("work_complete") && wom.status === "closed") {
    markWomLifecycleStepComplete(code, "work_complete", "sync");
  }
  if (!isDone("cost_applied") && wom.applied_price != null) {
    markWomLifecycleStepComplete(code, "cost_applied", "sync");
  }
  // A cost can't be applied for work that was never scheduled or finished
  // -- if it's on file, that alone is proof enough for a vendor-only job
  // with no internal technician hours ever logged against it in this app,
  // which never satisfies the allocation/status checks above on their own.
  if (wom.applied_price != null) {
    if (!isDone("vendor_scheduled")) markWomLifecycleStepComplete(code, "vendor_scheduled", "sync");
    if (!isDone("work_complete")) markWomLifecycleStepComplete(code, "work_complete", "sync");
  }
  refreshWomLifecycleTask(code);
}

// Called from the task-list route on every read (same lazy pattern as
// ensureRecurringTasks) -- catches a step like "Schedule vendor" up to
// date for every WOM whose checklist isn't finished yet, without needing a
// hook in every allocation-writing route.
function refreshAllOpenWomLifecycles() {
  const codes = db
    .prepare("SELECT DISTINCT related_wom_code FROM tasks WHERE workflow_rule = 'wom_lifecycle' AND status != 'completed'")
    .all()
    .map((r) => r.related_wom_code)
    .filter(Boolean);
  for (const code of codes) checkWomLifecycleAutoSteps(code);
}

// How many open WOM lifecycle tasks still haven't had "Send PSE to Toyota"
// logged -- the at-a-glance count behind the Priorities board's own tile,
// since "how many PSEs do I need to produce and send" is exactly the
// question a plain "High Priority: N" total doesn't answer on its own.
function countWomLifecyclePseNotSent() {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM tasks t
       WHERE t.workflow_rule = 'wom_lifecycle' AND t.status NOT IN ('completed', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM wom_lifecycle_steps s WHERE s.wom_code = t.related_wom_code AND s.step_key = 'sent_to_toyota'
       )`
    )
    .get();
  return row.n;
}

// One of the two manual steps (send to Toyota, review charges, invoice).
// `extra` carries whatever that specific step needs: toyotaEmail/sentAt
// for sent_to_toyota, batchNumber/invoiceNumber for invoiced -- ignored
// for charges_reviewed, which is a bare click.
function completeWomLifecycleStep(code, stepKey, admin, extra = {}) {
  const wom = findWom(code);
  if (!wom) return { error: "not_found" };
  const step = WOM_LIFECYCLE_STEPS.find((s) => s.key === stepKey);
  if (!step) return { error: "unknown_step" };
  if (step.trigger !== "manual") return { error: "not_manual" };
  const steps = getWomLifecycleSteps(code);
  if (steps.find((s) => s.key === stepKey).completedAt) return { error: "already_done" };

  const role = pseRoleFor(admin.id);
  if (role !== null && step.role !== null && role !== step.role) return { error: "wrong_role" };

  if (stepKey === "sent_to_toyota") {
    if (!extra.toyotaEmail) return { error: "email_required" };
    db.prepare("UPDATE woms SET pse_toyota_email = ?, pse_toyota_sent_at = ? WHERE code = ?").run(
      extra.toyotaEmail,
      extra.sentAt || new Date().toISOString(),
      code
    );
  }
  if (stepKey === "invoiced") {
    if (!extra.batchNumber || !extra.invoiceNumber) return { error: "batch_and_invoice_required" };
    db.prepare("UPDATE woms SET batch_number = ?, invoice_number = ? WHERE code = ?").run(extra.batchNumber, extra.invoiceNumber, code);
    setWomStatus(code, "invoiced", { changedBy: admin.id, source: "wom_lifecycle" });
  }

  markWomLifecycleStepComplete(code, stepKey, admin.id);
  refreshWomLifecycleTask(code);
  return { wom: findWom(code) };
}

// Financials-wide list, split by role the same way the old PSE task list
// was: reviewer sees WOMs whose next step is theirs, financial sees theirs,
// and (until a reviewer is designated) everyone sees everything so the
// feature isn't locked up before that one-time setup.
function listWomLifecycleTasks(admin) {
  const role = pseRoleFor(admin.id);
  const codes = db
    .prepare("SELECT related_wom_code FROM tasks WHERE workflow_rule = 'wom_lifecycle' AND status != 'completed'")
    .all()
    .map((r) => r.related_wom_code)
    .filter(Boolean);
  return codes
    .map((code) => womWithRemaining(findWom(code)))
    .filter(Boolean)
    .filter((w) => {
      const steps = getWomLifecycleSteps(w.code);
      const nextStep = nextLifecycleStep(steps);
      if (!nextStep || nextStep.role === null) return true;
      return role === null || nextStep.role === role;
    });
}

// Aggregate estimated-vs-applied figures across every non-cancelled WOM --
// the Financials-tab-wide view RFM needs (not just the ones currently
// sitting in the lifecycle checklist): total dollars quoted vs. actually
// applied, how many came in over-quoted on labor (estimate higher than
// what was actually applied -- money quoted that was never used), and how
// many have a charge applied but no Toyota PO/Maximo # on file yet, both
// real follow-up lists rather than just totals.
function getWomCostSummary() {
  const rows = db.prepare("SELECT * FROM woms WHERE status != 'cancelled'").all();
  let totalEstimated = 0;
  let totalApplied = 0;
  let totalToyotaPoValue = 0;
  let estimatedCount = 0;
  let appliedCount = 0;
  let toyotaPoValueCount = 0;
  const overquoted = [];
  const appliedNoPo = [];
  const laborOvercharged = [];
  const contractedIncreased = [];
  // Applied cost vs. the real Toyota-approved PO amount -- a different,
  // more authoritative check than overquoted/laborOvercharged/
  // contractedIncreased above, all of which only compare against this
  // app's own estimate (the PSE ask), not what Toyota actually signed off
  // on. A WOM can clear every one of those checks and still have gone over
  // its real PO ceiling if the estimate itself undersold what Toyota
  // approved, or vice versa.
  const appliedOverToyotaPo = [];
  // Materials, Other Direct, Tax, and Contingency are additional itemized
  // categories the tracker breaks out -- same "applied came in over what
  // was estimated" shape as Labor above, generic since none of them need
  // Contracted Services' extra vendor attribution.
  const SIMPLE_OVERCHARGE_CATEGORIES = [
    { key: "materials", estCol: "estimated_materials", appCol: "applied_materials", label: "Materials" },
    { key: "otherDirect", estCol: "estimated_other_direct", appCol: "applied_other_direct", label: "Other Direct Costs" },
    { key: "tax", estCol: "estimated_tax", appCol: "applied_tax", label: "Sales Tax" },
    { key: "contingency", estCol: "estimated_contingency", appCol: "applied_contingency", label: "Contingency" },
  ];
  const categoryOvercharges = Object.fromEntries(SIMPLE_OVERCHARGE_CATEGORIES.map((c) => [c.key, []]));
  // How much contracted-services $ has actually gone out to each vendor,
  // across every WOM on file (not just the overage ones) -- "who do we do
  // business with, and how much" independent of whether any single job ran
  // over its own estimate.
  const vendorSpendById = new Map();
  const vendorNameCache = new Map();
  const vendorName = (id) => {
    if (!vendorNameCache.has(id)) {
      const v = findVendor(id);
      vendorNameCache.set(id, v ? v.name : null);
    }
    return vendorNameCache.get(id);
  };

  for (const w of rows) {
    if (w.estimated_price != null) {
      totalEstimated += w.estimated_price;
      estimatedCount++;
    }
    if (w.applied_price != null) {
      totalApplied += w.applied_price;
      appliedCount++;
    }
    if (w.toyota_po_value != null) {
      totalToyotaPoValue += w.toyota_po_value;
      toyotaPoValueCount++;
    }
    if (w.applied_price != null && w.toyota_po_value != null && w.applied_price > w.toyota_po_value) {
      appliedOverToyotaPo.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        appliedPrice: w.applied_price,
        toyotaPoValue: w.toyota_po_value,
        overage: w.applied_price - w.toyota_po_value,
      });
    }
    // Estimated came in higher than applied on the project as a whole --
    // budget that was quoted but never used, not an overcharge. See
    // laborOvercharged/contractedIncreased below for the actual "we paid
    // more than quoted" cases, broken out by category.
    if (w.estimated_price != null && w.applied_price != null && w.estimated_price > w.applied_price) {
      overquoted.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        estimatedPrice: w.estimated_price,
        appliedPrice: w.applied_price,
        overage: w.estimated_price - w.applied_price,
      });
    }
    if (w.applied_price != null && !w.maximo_number) {
      appliedNoPo.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        appliedPrice: w.applied_price,
        status: w.status,
      });
    }
    if (w.estimated_labor != null && w.applied_labor != null && w.applied_labor > w.estimated_labor) {
      laborOvercharged.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        estimatedLabor: w.estimated_labor,
        appliedLabor: w.applied_labor,
        overage: w.applied_labor - w.estimated_labor,
      });
    }
    if (w.estimated_contracted != null && w.applied_contracted != null && w.applied_contracted > w.estimated_contracted) {
      contractedIncreased.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        vendorId: w.vendor_id,
        vendorName: w.vendor_id ? vendorName(w.vendor_id) : null,
        estimatedContracted: w.estimated_contracted,
        appliedContracted: w.applied_contracted,
        overage: w.applied_contracted - w.estimated_contracted,
      });
    }
    if (w.vendor_id && w.applied_contracted != null) {
      const cur = vendorSpendById.get(w.vendor_id) || {
        vendorId: w.vendor_id,
        vendorName: vendorName(w.vendor_id),
        totalAppliedContracted: 0,
        womCount: 0,
      };
      cur.totalAppliedContracted += w.applied_contracted;
      cur.womCount++;
      vendorSpendById.set(w.vendor_id, cur);
    }
    for (const cat of SIMPLE_OVERCHARGE_CATEGORIES) {
      const est = w[cat.estCol];
      const app = w[cat.appCol];
      if (est != null && app != null && app > est) {
        categoryOvercharges[cat.key].push({
          code: w.code,
          description: w.description,
          locationCode: w.location_code,
          estimated: est,
          applied: app,
          overage: app - est,
        });
      }
    }
  }

  overquoted.sort((a, b) => b.overage - a.overage);
  appliedNoPo.sort((a, b) => b.appliedPrice - a.appliedPrice);
  laborOvercharged.sort((a, b) => b.overage - a.overage);
  contractedIncreased.sort((a, b) => b.overage - a.overage);
  appliedOverToyotaPo.sort((a, b) => b.overage - a.overage);

  // Which vendors show up more than once in contractedIncreased -- the
  // "reoccuringly charging on top of their quotes" list, not just a single
  // one-off overage.
  const vendorOverageById = new Map();
  for (const c of contractedIncreased) {
    if (!c.vendorId) continue;
    const cur = vendorOverageById.get(c.vendorId) || { vendorId: c.vendorId, vendorName: c.vendorName, count: 0, totalOverage: 0 };
    cur.count++;
    cur.totalOverage += c.overage;
    vendorOverageById.set(c.vendorId, cur);
  }
  const vendorsOverchargingRepeatedly = [...vendorOverageById.values()]
    .filter((v) => v.count > 1)
    .sort((a, b) => b.count - a.count || b.totalOverage - a.totalOverage);
  const vendorContractedSpend = [...vendorSpendById.values()].sort((a, b) => b.totalAppliedContracted - a.totalAppliedContracted);

  const categoryOverages = SIMPLE_OVERCHARGE_CATEGORIES.map((cat) => {
    const items = categoryOvercharges[cat.key].sort((a, b) => b.overage - a.overage);
    return { key: cat.key, label: cat.label, count: items.length, total: items.reduce((sum, o) => sum + o.overage, 0), items };
  });

  return {
    totalWoms: rows.length,
    estimatedCount,
    appliedCount,
    totalEstimated,
    totalApplied,
    totalDelta: totalEstimated - totalApplied,
    toyotaPoValueCount,
    totalToyotaPoValue,
    appliedVsToyotaPoDelta: totalApplied - totalToyotaPoValue,
    appliedOverToyotaPoCount: appliedOverToyotaPo.length,
    appliedOverToyotaPoTotal: appliedOverToyotaPo.reduce((sum, o) => sum + o.overage, 0),
    appliedOverToyotaPo,
    overquotedCount: overquoted.length,
    overquotedTotal: overquoted.reduce((sum, o) => sum + o.overage, 0),
    overquoted,
    appliedNoPoCount: appliedNoPo.length,
    appliedNoPoTotal: appliedNoPo.reduce((sum, o) => sum + o.appliedPrice, 0),
    appliedNoPo,
    laborOverchargedCount: laborOvercharged.length,
    laborOverchargedTotal: laborOvercharged.reduce((sum, o) => sum + o.overage, 0),
    laborOvercharged,
    contractedIncreasedCount: contractedIncreased.length,
    contractedIncreasedTotal: contractedIncreased.reduce((sum, o) => sum + o.overage, 0),
    contractedIncreased,
    vendorsOverchargingRepeatedly,
    vendorContractedSpend,
    categoryOverages,
  };
}


// ---- Task / workflow engine ----
//
// "States create tasks, tasks create timestamps, timestamps create
// analytics." A task is always generated off a WOM stage change or a
// recurring schedule, or entered by hand -- this is the operational engine
// behind Priorities/My Work, not a bare to-do list bolted on the side.

const TASK_STATUSES = ["open", "in_progress", "waiting", "completed", "cancelled"];
const TASK_PRIORITIES = ["low", "normal", "high", "urgent", "emergency"];
const OPEN_TASK_STATUSES = ["open", "in_progress", "waiting"];

function findTask(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function findTaskBySourceKey(sourceKey) {
  return db.prepare("SELECT * FROM tasks WHERE source_key = ?").get(sourceKey);
}

function createTask(fields) {
  const now = new Date().toISOString();
  const assignedTo = fields.assignedTo || null;
  const result = db
    .prepare(
      `INSERT INTO tasks (source_key, title, description, assigned_to, assigned_role, category, priority, due_at,
       status, related_wom_code, related_vendor_id, related_location_code, related_tech_id, related_po,
       source, source_record_id, workflow_rule, is_exception, is_change_order, created_by, created_at, assigned_at, last_status_change_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.sourceKey || null,
      fields.title,
      fields.description || "",
      assignedTo,
      fields.assignedRole || null,
      fields.category || "manual",
      fields.priority || "normal",
      fields.dueAt || null,
      fields.relatedWomCode || null,
      fields.relatedVendorId || null,
      fields.relatedLocationCode || null,
      fields.relatedTechId || null,
      fields.relatedPo || null,
      fields.source || "manual",
      fields.sourceRecordId || null,
      fields.workflowRule || null,
      fields.isException ? 1 : 0,
      fields.isChangeOrder ? 1 : 0,
      fields.createdBy || null,
      now,
      assignedTo ? now : null,
      now
    );
  return findTask(Number(result.lastInsertRowid));
}

// The core "don't blindly recreate" mechanic behind every automated task --
// if one with this source key already exists, update it in place (and
// reopen it if it had been completed/cancelled, since the workflow rule
// firing again means the work is back) rather than inserting a duplicate.
// `reopenIfClosed` defaults to true (a workflow rule firing again on a
// completed/cancelled task means the work is genuinely back, e.g. a
// Status 95 rejection). Recurring tasks pass false instead -- the same
// source key gets re-upserted every time the page loads for the rest of
// that task's period, and completing it for the week/month shouldn't
// un-complete itself on the next page view; it should just stay done
// until the period rolls over to a new source key.
function upsertTaskBySourceKey(sourceKey, fields, { reopenIfClosed = true } = {}) {
  const existing = findTaskBySourceKey(sourceKey);
  if (!existing) return createTask({ ...fields, sourceKey });
  if (!reopenIfClosed && (existing.status === "completed" || existing.status === "cancelled")) return existing;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, assigned_role = ?, category = ?,
     priority = ?, due_at = ?, related_wom_code = ?, related_vendor_id = ?, related_location_code = ?,
     related_tech_id = ?, related_po = ?, workflow_rule = ?, is_exception = ?, is_change_order = ?,
     status = CASE WHEN status IN ('completed','cancelled') THEN 'open' ELSE status END,
     completed_at = CASE WHEN status IN ('completed','cancelled') THEN NULL ELSE completed_at END,
     last_status_change_at = ?
     WHERE id = ?`
  ).run(
    fields.title ?? existing.title,
    fields.description ?? existing.description,
    fields.assignedTo !== undefined ? fields.assignedTo || null : existing.assigned_to,
    fields.assignedRole !== undefined ? fields.assignedRole || null : existing.assigned_role,
    fields.category ?? existing.category,
    fields.priority ?? existing.priority,
    fields.dueAt !== undefined ? fields.dueAt || null : existing.due_at,
    fields.relatedWomCode !== undefined ? fields.relatedWomCode || null : existing.related_wom_code,
    fields.relatedVendorId !== undefined ? fields.relatedVendorId || null : existing.related_vendor_id,
    fields.relatedLocationCode !== undefined ? fields.relatedLocationCode || null : existing.related_location_code,
    fields.relatedTechId !== undefined ? fields.relatedTechId || null : existing.related_tech_id,
    fields.relatedPo !== undefined ? fields.relatedPo || null : existing.related_po,
    fields.workflowRule ?? existing.workflow_rule,
    fields.isException !== undefined ? (fields.isException ? 1 : 0) : existing.is_exception,
    fields.isChangeOrder !== undefined ? (fields.isChangeOrder ? 1 : 0) : existing.is_change_order,
    now,
    existing.id
  );
  return findTask(existing.id);
}

function completeTaskBySourceKey(sourceKey) {
  const existing = findTaskBySourceKey(sourceKey);
  if (!existing || existing.status === "completed") return existing || null;
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET status = 'completed', completed_at = ?, last_status_change_at = ? WHERE id = ?").run(now, now, existing.id);
  return findTask(existing.id);
}

// A human acting on a task directly from the UI (not a workflow rule) --
// start/complete/cancel/put-on-waiting.
function setTaskStatus(id, status) {
  const existing = findTask(id);
  if (!existing || !TASK_STATUSES.includes(status)) return null;
  const now = new Date().toISOString();
  const startedAt = status === "in_progress" && !existing.started_at ? now : existing.started_at;
  const completedAt = status === "completed" ? now : OPEN_TASK_STATUSES.includes(status) ? null : existing.completed_at;
  db.prepare("UPDATE tasks SET status = ?, started_at = ?, completed_at = ?, last_status_change_at = ? WHERE id = ?").run(
    status,
    startedAt,
    completedAt,
    now,
    id
  );
  return findTask(id);
}

// For permanently removing a task that should never have existed (a
// placeholder WOM's leftover follow-up, a mistaken manual entry) -- not
// exposed as a UI action, since "cancelled" already covers "this isn't
// happening" for everything else; this is a step further, for one-off
// cleanup. Takes its comments, reschedule notes, and any attached files
// with it rather than leaving them orphaned (no FK/cascade on any table).
function deleteTask(id) {
  db.prepare("DELETE FROM task_comments WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM task_reschedules WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM files WHERE related_type = 'task' AND related_id = ?").run(String(id));
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

// Snoozes a task forward with a required note explaining why -- e.g. "$100
// expenses posted, labor posted, vendor $ posted" this week, a different
// note next week if it's snoozed again. Kept as its own growing log
// (listTaskReschedules) rather than one overwritable field, so the full
// story of repeated snoozes is still there later. The task itself is
// otherwise untouched: its real priority/exception/role keep being
// computed exactly as they always are (for a WOM lifecycle task, on the
// next sync/action/lazy catch-up) -- snoozing only changes whether it
// shows up in the default views right now, never what it actually needs.
function rescheduleTask(id, { snoozedUntil, note, createdBy, createdByName }) {
  const existing = findTask(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET snoozed_until = ? WHERE id = ?").run(snoozedUntil, id);
  db.prepare(
    "INSERT INTO task_reschedules (task_id, note, snoozed_until, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, note, snoozedUntil, createdBy, createdByName, now);
  return findTask(id);
}

// Brings a snoozed task back to the default views right now, without
// waiting for its snooze date -- "pull it up if he needs to make changes."
// Doesn't touch the reschedule log; that history stays regardless.
function unsnoozeTask(id) {
  const existing = findTask(id);
  if (!existing) return null;
  db.prepare("UPDATE tasks SET snoozed_until = NULL WHERE id = ?").run(id);
  return findTask(id);
}

function listTaskReschedules(taskId) {
  // Oldest first, same chronological convention as the Activity feed --
  // this is a running history of status updates, read top to bottom.
  return db.prepare("SELECT * FROM task_reschedules WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
}

// A person editing what/why a hand-added task is about, after the fact --
// title, description, type, priority, due date, and what it's related to.
// Deliberately separate from assignTask (who) and setTaskStatus (state).
// Same partial-update shape as upsertTaskBySourceKey: a field left
// undefined keeps its current value, so the route only has to pass what
// the edit form actually changed.
function updateTask(id, fields) {
  const existing = findTask(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, category = ?, priority = ?, due_at = ?,
     related_wom_code = ?, related_vendor_id = ?, related_tech_id = ? WHERE id = ?`
  ).run(
    fields.title ?? existing.title,
    fields.description ?? existing.description,
    fields.category ?? existing.category,
    fields.priority ?? existing.priority,
    fields.dueAt !== undefined ? fields.dueAt : existing.due_at,
    fields.relatedWomCode !== undefined ? fields.relatedWomCode : existing.related_wom_code,
    fields.relatedVendorId !== undefined ? fields.relatedVendorId : existing.related_vendor_id,
    fields.relatedTechId !== undefined ? fields.relatedTechId : existing.related_tech_id,
    id
  );
  return findTask(id);
}

function assignTask(id, { assignedTo, assignedRole }) {
  if (!findTask(id)) return null;
  db.prepare("UPDATE tasks SET assigned_to = ?, assigned_role = ?, assigned_at = ? WHERE id = ?").run(
    assignedTo || null,
    assignedRole || null,
    new Date().toISOString(),
    id
  );
  return findTask(id);
}

function addTaskComment(taskId, authorId, authorName, body) {
  db.prepare("INSERT INTO task_comments (task_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    authorId,
    authorName,
    body,
    new Date().toISOString()
  );
  return listTaskComments(taskId);
}

function listTaskComments(taskId) {
  return db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id").all(taskId);
}

// The query engine behind every Priorities/My Work view -- a plain
// WHERE-clause builder, since the views are really just different
// combinations of the same handful of filters rather than needing one
// query each.
function listTasks(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.status) {
    clauses.push(`status IN (${filters.status.map(() => "?").join(",")})`);
    params.push(...filters.status);
  }
  if (filters.assignedTo) {
    clauses.push("assigned_to = ?");
    params.push(filters.assignedTo);
  }
  if (filters.assignedRole) {
    // A single role string, or an array (e.g. the task board's "Admin"
    // filter option covers both the "admin" and "financial" stored role
    // values, since day-to-day those read as the same bucket of office
    // work) -- same array-or-string flexibility filters.status already has.
    const roleList = Array.isArray(filters.assignedRole) ? filters.assignedRole : [filters.assignedRole];
    clauses.push(`assigned_role IN (${roleList.map(() => "?").join(",")})`);
    params.push(...roleList);
  }
  if (filters.category) {
    clauses.push("category = ?");
    params.push(filters.category);
  }
  if (filters.source) {
    clauses.push("source = ?");
    params.push(filters.source);
  }
  if (filters.relatedLocationCode) {
    clauses.push("related_location_code = ?");
    params.push(filters.relatedLocationCode);
  }
  if (filters.territory) {
    // A task inherits its territory from related_location_code rather than
    // carrying its own territory column, same reasoning as WOMs -- one
    // location tagged with a territory scopes every task already pointing
    // at it, with nothing to backfill or let drift out of sync.
    clauses.push("related_location_code IN (SELECT code FROM locations WHERE territory = ?)");
    params.push(filters.territory);
  }
  if (filters.relatedWomCode) {
    clauses.push("related_wom_code = ?");
    params.push(filters.relatedWomCode);
  }
  if (filters.relatedVendorId) {
    clauses.push("related_vendor_id = ?");
    params.push(filters.relatedVendorId);
  }
  if (filters.relatedTechId) {
    clauses.push("related_tech_id = ?");
    params.push(filters.relatedTechId);
  }
  if (filters.isException) {
    clauses.push("is_exception = 1");
  }
  if (filters.dueBefore) {
    clauses.push("due_at IS NOT NULL AND due_at <= ?");
    params.push(filters.dueBefore);
  }
  if (filters.unassignedOnly) {
    // "Unassigned" means nobody's queue includes this at all -- not even a
    // role's shared one. Checking assigned_to alone caught almost every
    // WOM lifecycle task ever made, since those are near-never claimed by
    // a specific named person -- they live in a role's queue instead
    // (Unclaimed -- RFM/Tech/Admin), which is a completely different,
    // already-covered state. Only a task with neither counts as genuinely
    // unassigned.
    clauses.push("assigned_to IS NULL AND assigned_role IS NULL");
  }
  if (filters.dueOn) {
    clauses.push("due_at LIKE ?");
    params.push(`${filters.dueOn}%`);
  }
  // My Work/Team Work/etc. all hide a snoozed task until its snooze date
  // arrives -- "then I don't see it on my list" -- while the Upcoming view
  // (filters.snoozedOnly) shows exactly the opposite: only tasks still
  // snoozed into the future. Comparing against a timestamp taken once here
  // rather than SQLite's own now() keeps a single call's view consistent.
  const nowIso = new Date().toISOString();
  if (filters.excludeSnoozed) {
    clauses.push("(snoozed_until IS NULL OR snoozed_until <= ?)");
    params.push(nowIso);
  }
  if (filters.snoozedOnly) {
    clauses.push("snoozed_until IS NOT NULL AND snoozed_until > ?");
    params.push(nowIso);
  }
  // "Assigned to me, or an unclaimed task matching one of my roles" -- the
  // shared shape behind both My Work (tech and admin) and the role-scoped
  // slice of Team Work.
  if (filters.forViewer) {
    const { id, roles } = filters.forViewer;
    const roleParts = (roles || []).map(() => "(assigned_to IS NULL AND assigned_role = ?)");
    clauses.push(`(assigned_to = ?${roleParts.length ? " OR " + roleParts.join(" OR ") : ""})`);
    params.push(id, ...(roles || []));
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Sorted by priority tier first (Emergency down to Low), then due date --
  // otherwise a High-priority task with no due date yet, or a later due
  // date than some Normal task, would sink below it, which defeats the
  // point of the tier existing at all.
  return db
    .prepare(
      `SELECT * FROM tasks ${where} ORDER BY
        CASE priority
          WHEN 'emergency' THEN 0
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        due_at IS NULL, due_at, id DESC`
    )
    .all(...params);
}

function recordWomStatusChange(womCode, field, previousValue, newValue, { changedAt, changedBy, source } = {}) {
  if (previousValue === newValue) return;
  db.prepare(
    "INSERT INTO wom_status_history (wom_code, field, previous_value, new_value, changed_at, detected_at, changed_by, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    womCode,
    field,
    previousValue == null ? null : String(previousValue),
    newValue == null ? null : String(newValue),
    changedAt || null,
    new Date().toISOString(),
    changedBy || null,
    source || "unknown"
  );
}

function listWomStatusHistory(womCode) {
  return db.prepare("SELECT * FROM wom_status_history WHERE wom_code = ? ORDER BY id").all(womCode);
}

// Recurring admin work that isn't tied to any one WOM. Not backed by a
// cron job (nothing in this app runs on a schedule) -- instead this is
// called lazily whenever the task list is loaded, and just upserts
// whichever period's task should currently exist by a source key derived
// from that period (e.g. the Monday of the current week), so it's a no-op
// once that period's task already exists and isn't recreated after being
// completed until the period itself rolls over.
function ensureRecurringTasks() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - day);
  const iso = (d) => d.toISOString().slice(0, 10);
  const mondayIso = iso(monday);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fridayIso = iso(friday);
  const monthKey = now.toISOString().slice(0, 7);

  // A stable, ever-increasing 2-week bucket so "biweekly" doesn't need to
  // track which specific weeks pair together across year boundaries.
  const EPOCH_MONDAY = Date.UTC(2024, 0, 1);
  const weeksSinceEpoch = Math.floor((Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()) - EPOCH_MONDAY) / (7 * 86400000));
  const biweekIndex = Math.floor(weeksSinceEpoch / 2);

  const specs = [
    {
      key: `RECURRING-WEEKLY-TIME-ALLOCATION-${mondayIso}`,
      title: "Technician time allocation (Thu/Fri)",
      description: "Make sure technicians have their hours allocated for the week.",
      dueAt: fridayIso,
      assignedRole: "admin",
    },
    {
      key: `RECURRING-WEEKLY-TIMECARD-REVIEW-${mondayIso}`,
      title: "Final timecard review",
      description: "Review last week's submitted timecards before payroll cutoff.",
      dueAt: mondayIso,
      assignedRole: "admin",
    },
    { key: `RECURRING-WEEKLY-AP-REVIEW-${mondayIso}`, title: "Review AP open items", dueAt: fridayIso, assignedRole: "financial" },
    {
      key: `RECURRING-BIWEEKLY-WOM-CHARGES-${biweekIndex}`,
      title: "Review completed WOMs and confirm charges are posted",
      dueAt: fridayIso,
      assignedRole: "financial",
    },
    { key: `RECURRING-MONTHLY-OPEN-POS-${monthKey}`, title: "Review open POs", dueAt: `${monthKey}-28`, assignedRole: "financial" },
    { key: `RECURRING-MONTHLY-VENDOR-COMPLIANCE-${monthKey}`, title: "Vendor compliance cleanup", dueAt: `${monthKey}-28`, assignedRole: "admin" },
  ];

  for (const spec of specs) {
    upsertTaskBySourceKey(
      spec.key,
      {
        title: spec.title,
        description: spec.description || "",
        assignedRole: spec.assignedRole,
        category: "recurring",
        priority: "normal",
        dueAt: spec.dueAt,
        source: "recurring",
        workflowRule: spec.key.replace(/[\d-]+$/, "").replace(/-$/, ""),
      },
      { reopenIfClosed: false }
    );
  }

  // User-defined recurring tasks (see recurring_task_templates above) --
  // today's occurrence exists once today's weekday is in the template's
  // days_of_week, keyed so re-running this on every page load never
  // duplicates it and never un-completes it before the day rolls over.
  const todayIso = iso(now);
  for (const template of listRecurringTaskTemplates({ activeOnly: true })) {
    const daysOfWeek = JSON.parse(template.daysOfWeek);
    if (!daysOfWeek.includes(now.getDay())) continue;
    upsertTaskBySourceKey(
      `RECURRING-USER-${template.id}-${todayIso}`,
      {
        title: template.title,
        description: template.description || "",
        assignedTo: template.assignedTo,
        assignedRole: template.assignedRole,
        category: "recurring",
        priority: template.priority,
        dueAt: template.dueTime ? `${todayIso}T${template.dueTime}` : todayIso,
        relatedWomCode: template.relatedWomCode,
        source: "recurring",
        workflowRule: `RECURRING-USER-${template.id}`,
      },
      { reopenIfClosed: false }
    );
  }
}

function createRecurringTaskTemplate(fields) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO recurring_task_templates
       (title, description, priority, assigned_to, assigned_role, related_wom_code, days_of_week, due_time, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      fields.title,
      fields.description || "",
      fields.priority || "normal",
      fields.assignedTo || null,
      fields.assignedRole || null,
      fields.relatedWomCode || null,
      JSON.stringify(fields.daysOfWeek),
      fields.dueTime || null,
      fields.createdBy || null,
      now
    );
  return findRecurringTaskTemplate(Number(result.lastInsertRowid));
}

function presentRecurringTaskTemplate(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    assignedTo: t.assigned_to,
    assignedRole: t.assigned_role,
    relatedWomCode: t.related_wom_code,
    daysOfWeek: t.days_of_week,
    dueTime: t.due_time,
    active: Boolean(t.active),
    createdBy: t.created_by,
    createdAt: t.created_at,
  };
}

function findRecurringTaskTemplate(id) {
  const row = db.prepare("SELECT * FROM recurring_task_templates WHERE id = ?").get(id);
  return row ? presentRecurringTaskTemplate(row) : null;
}

function listRecurringTaskTemplates({ activeOnly = false } = {}) {
  const rows = activeOnly
    ? db.prepare("SELECT * FROM recurring_task_templates WHERE active = 1").all()
    : db.prepare("SELECT * FROM recurring_task_templates ORDER BY id DESC").all();
  return rows.map(presentRecurringTaskTemplate);
}

function setRecurringTaskTemplateActive(id, active) {
  db.prepare("UPDATE recurring_task_templates SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  return findRecurringTaskTemplate(id);
}

// The "Last sync: ... / N tasks created / View Sync Details" panel needs
// this to survive a page reload, not just live in the response of the
// click that triggered it -- one row per sync, so it also doubles as a
// history of every sync ever run if that's ever useful later.
function recordSyncLog(fields) {
  db.prepare(
    `INSERT INTO wom_sync_log (synced_at, synced_by, woms_created, woms_promoted, woms_updated,
     tasks_created, tasks_completed, exceptions_flagged, total_rows, changed_woms_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    fields.syncedBy || null,
    fields.womsCreated || 0,
    fields.womsPromoted || 0,
    fields.womsUpdated || 0,
    fields.tasksCreated || 0,
    fields.tasksCompleted || 0,
    fields.exceptionsFlagged || 0,
    fields.totalRows || 0,
    JSON.stringify(fields.changedWoms || [])
  );
  return getLastSyncLog();
}

function getLastSyncLog() {
  const row = db.prepare("SELECT * FROM wom_sync_log ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  let changedWoms = [];
  try {
    changedWoms = row.changed_woms_json ? JSON.parse(row.changed_woms_json) : [];
  } catch {
    changedWoms = [];
  }
  return { ...row, changedWoms };
}

// Every sync run already keeps its own full changed_woms_json -- this just
// asks "which of those mention this one WOM," newest first, so "why does
// this keep showing as changed" can be answered by actually looking at the
// sync history for that WOM rather than only ever seeing the latest run.
function getWomSyncHistory(code) {
  const rows = db.prepare("SELECT synced_at, changed_woms_json FROM wom_sync_log ORDER BY id DESC").all();
  const history = [];
  for (const row of rows) {
    let changedWoms = [];
    try {
      changedWoms = row.changed_woms_json ? JSON.parse(row.changed_woms_json) : [];
    } catch {
      changedWoms = [];
    }
    const entry = changedWoms.find((c) => c.code === code);
    if (entry) history.push({ syncedAt: row.synced_at, fields: entry.fields });
  }
  return history;
}

function markWomSmartsheetReflected(code) {
  const wom = findWom(code);
  if (!wom || wom.status !== "closed") return null;
  db.prepare("UPDATE woms SET smartsheet_reflected_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  return findWom(code);
}

function setWomDetails(code, { description, locationCode, budgetHours, subsidiaryCode, maximoNumber } = {}) {
  if (!findWom(code)) return null;
  db.prepare(
    "UPDATE woms SET description = ?, location_code = ?, budget_hours = ?, subsidiary_code = ?, maximo_number = ? WHERE code = ?"
  ).run(
    description,
    locationCode || null,
    budgetHours == null ? null : Number(budgetHours),
    subsidiaryCode || null,
    maximoNumber || null,
    code
  );
  return findWom(code);
}

// A WOM without a Smartsheet match yet can still have pricing entered by
// hand; a later sync overwrites both fields once that WOM code is found
// there, since they're meant to mirror Smartsheet once a match exists.
function setWomPricing(code, { estimatedPrice, appliedPrice } = {}) {
  if (!findWom(code)) return null;
  db.prepare("UPDATE woms SET estimated_price = ?, applied_price = ? WHERE code = ?").run(
    estimatedPrice == null || estimatedPrice === "" ? null : Number(estimatedPrice),
    appliedPrice == null || appliedPrice === "" ? null : Number(appliedPrice),
    code
  );
  return findWom(code);
}

function parseDollarAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[$,]/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findWomBySmartsheetRowId(rowId) {
  return womWithRemaining(db.prepare("SELECT * FROM woms WHERE smartsheet_row_id = ?").get(String(rowId)));
}

// Applies a Smartsheet pull: rows already simplified to {ColumnTitle:
// value, __smartsheetRowId} by server/utils/smartsheet.js. Every row
// becomes (or updates) a WOM record here, tracked by its underlying
// Smartsheet row so the same row is recognized on every later sync even
// after its code or status changes:
//   - A row with a real WOM # assigned syncs as a normal 'open' WOM, coded
//     with that real number -- the job exists and can be billed.
//   - A row with no WOM # yet but with its "Date Requested" column filled
//     in (RFM has asked Toyota to generate the WOM/PO) syncs as 'requested'
//     instead, coded "PENDING-<row id>" since there's still no real number.
//   - A row with neither a WOM # nor a Date Requested yet syncs as
//     'pending' -- RFM hasn't asked Toyota for anything yet. Same
//     "PENDING-<row id>" code.
//   Technicians can't allocate hours against a 'pending' or 'requested'
//   WOM (only 'open' means the job actually exists and can be billed), so
//   both are purely visible/trackable for admin/RFM until a real WOM # shows
//   up.
//   - The first time a later sync finds a real WOM # for a row that's still
//     'pending' or 'requested' here, that record is "promoted": renamed to
//     the real code and moved to 'open'.
//   - A 'pending' row whose Date Requested column gets filled in on a later
//     sync (still no WOM # yet) is bumped to 'requested' in place -- same
//     code, just a status update.
//   Once a WOM reaches 'open', this never touches its status again -- an
//   admin's later invoiced/closed doesn't get overwritten by a sync.
// Matches a Smartsheet "Site Location" cell (a plain name like "NAPCK" or
// "TLS Georgetown") against this app's own locations by name, since the
// sheet has no notion of our internal location codes. Exact match first,
// then tolerant of a shortened form either direction (the sheet often
// drops a suffix, e.g. "NAPCK" for "NAPCK Georgetown"). Returns null (not a
// guess) if nothing lines up -- that location likely just doesn't exist
// here yet.
function matchLocationCodeByName(rawName) {
  const clean = rawName != null ? String(rawName).trim() : "";
  if (!clean || clean === "-") return null;
  const lower = clean.toLowerCase();
  const locations = listLocations();
  const exact = locations.find((l) => l.name.toLowerCase() === lower);
  if (exact) return exact.code;
  const partial = locations.find((l) => l.name.toLowerCase().includes(lower) || lower.includes(l.name.toLowerCase()));
  return partial ? partial.code : null;
}

// Same tolerant name-matching approach as matchLocationCodeByName, applied
// to the tracker's "Vendor(s) Name/#/Phone" column -- e.g. "Automated
// Solutions Group - 5883201". Only the name portion (before the first
// " - ") is matched; never guessed at if nothing lines up, so a WOM just
// goes without a vendor link rather than getting attached to the wrong one.
function matchVendorIdByName(rawVendorText) {
  const clean = rawVendorText != null ? String(rawVendorText).trim() : "";
  if (!clean || clean === "-") return null;
  const namePart = clean.split(/\s+-\s+/)[0].trim();
  if (!namePart) return null;
  const lower = namePart.toLowerCase();
  const vendors = listVendors();
  const exact = vendors.find((v) => v.name.toLowerCase() === lower);
  if (exact) return exact.id;
  const partial = vendors.find((v) => v.name.toLowerCase().includes(lower) || lower.includes(v.name.toLowerCase()));
  return partial ? partial.id : null;
}

// `columns` names each Smartsheet column to pull from, as found by
// findColumn in server/utils/smartsheet.js: { wom, estimate, applied,
// description, dateRequested, maximo, location, subsidiary }. Any of them
// can be null if that column wasn't found -- that field is just skipped,
// same as before this became an options object (this used to be a long
// positional-argument list; a plain object stopped that from growing
// unreadable every time another sheet column needed pulling in).
// Whether an already-stored value actually differs from what this sync
// would write -- so "N WOMs updated" (and the change list behind "View
// Sync Details") only counts a WOM whose data genuinely changed, not every
// already-open WOM the sheet still happens to mention.
function valuesDiffer(existingValue, nextValue) {
  if (existingValue == null && nextValue == null) return false;
  if (existingValue == null || nextValue == null) return true;
  return Number(existingValue) !== Number(nextValue) && String(existingValue) !== String(nextValue);
}

// Every itemized cost category Cost Analysis breaks estimate-vs-applied by
// (all six estimate-side figures sum to the WOM's project total; same for
// applied). `jsField` is this value's key both on `columns` (the resolved
// Smartsheet column title for it) and on a sync row's `breakdown` object
// (the parsed number); `dbColumn` is where it's stored. Centralized here --
// not hand-copied across 5 SQL statements and diffFields -- because that
// copy-paste is exactly the kind of bug class a silently-dropped/misordered
// param creates in financial data. Adding another category Toyota's tracker
// itemizes is one entry here instead of a hand-edit to 5 places.
const WOM_COST_BREAKDOWN_FIELDS = [
  { dbColumn: "estimated_labor", jsField: "estimatedLabor", diffLabel: "estimated labor" },
  { dbColumn: "estimated_materials", jsField: "estimatedMaterials", diffLabel: "estimated materials" },
  { dbColumn: "estimated_contracted", jsField: "estimatedContracted", diffLabel: "estimated contracted services" },
  { dbColumn: "estimated_other_direct", jsField: "estimatedOtherDirect", diffLabel: "estimated other direct costs" },
  { dbColumn: "estimated_tax", jsField: "estimatedTax", diffLabel: "estimated sales tax" },
  { dbColumn: "estimated_contingency", jsField: "estimatedContingency", diffLabel: "estimated contingency" },
  { dbColumn: "applied_labor", jsField: "appliedLabor", diffLabel: "applied labor" },
  { dbColumn: "applied_materials", jsField: "appliedMaterials", diffLabel: "applied materials" },
  { dbColumn: "applied_contracted", jsField: "appliedContracted", diffLabel: "applied contracted services" },
  { dbColumn: "applied_other_direct", jsField: "appliedOtherDirect", diffLabel: "applied other direct costs" },
  { dbColumn: "applied_tax", jsField: "appliedTax", diffLabel: "applied sales tax" },
  { dbColumn: "applied_contingency", jsField: "appliedContingency", diffLabel: "applied contingency" },
  { dbColumn: "toyota_po_value", jsField: "toyotaPoValue", diffLabel: "Toyota PO value" },
];

function diffFields(existing, next) {
  const fields = [];
  if (next.estimatedPrice != null && valuesDiffer(existing.estimated_price, next.estimatedPrice)) fields.push("estimate");
  if (next.appliedPrice != null && valuesDiffer(existing.applied_price, next.appliedPrice)) fields.push("applied");
  if (next.maximoNumber && valuesDiffer(existing.maximo_number, next.maximoNumber)) fields.push("Maximo #");
  if (next.subsidiaryCode && valuesDiffer(existing.subsidiary_code, next.subsidiaryCode)) fields.push("subsidiary code");
  if (next.matchedLocationCode && !existing.location_code) fields.push("location");
  for (const f of WOM_COST_BREAKDOWN_FIELDS) {
    if (next[f.jsField] != null && valuesDiffer(existing[f.dbColumn], next[f.jsField])) fields.push(f.diffLabel);
  }
  if (next.matchedVendorId && !existing.vendor_id) fields.push("vendor");
  return fields;
}

function syncWomsFromSheetRows(rows, columns) {
  const { wom: womColumn, estimate: estimateColumn, applied: appliedColumn, description: descriptionColumn } = columns;
  const { dateRequested: dateRequestedColumn, maximo: maximoColumn, location: locationColumn, subsidiary: subsidiaryColumn } = columns;
  const { vendor: vendorColumn } = columns;
  // The Smartsheet column title for each breakdown category, resolved once
  // up front -- looked up by row below, not re-resolved every row.
  const breakdownColumnTitles = WOM_COST_BREAKDOWN_FIELDS.map((f) => columns[f.jsField]);
  const breakdownSetSql = WOM_COST_BREAKDOWN_FIELDS.map((f) => `${f.dbColumn} = ?`).join(", ");
  const breakdownInsertColumnsSql = WOM_COST_BREAKDOWN_FIELDS.map((f) => f.dbColumn).join(", ");
  const breakdownInsertPlaceholders = WOM_COST_BREAKDOWN_FIELDS.map(() => "?").join(", ");
  let created = 0;
  let promoted = 0;
  let updated = 0;
  // What actually changed this sync, WOM by WOM -- the answer to "when I
  // sync, I have no idea what's been changed."
  const changedWoms = [];
  const stamp = new Date().toISOString();

  for (const row of rows) {
    const rowId = row.__smartsheetRowId;
    if (!rowId) continue;

    const rawCode = womColumn ? row[womColumn] : null;
    const trimmedCode = rawCode != null ? String(rawCode).trim() : "";
    // "0" and "-" are both placeholder/blank markers a spreadsheet cell
    // shows for "nothing entered yet," not an actual WOM #.
    const realCode = trimmedCode && trimmedCode !== "0" && trimmedCode !== "-" ? trimmedCode : null;
    const requested = Boolean(dateRequestedColumn && String(row[dateRequestedColumn] ?? "").trim());
    const dateRequestedValue = (dateRequestedColumn && row[dateRequestedColumn] && String(row[dateRequestedColumn]).trim()) || null;
    const rowNumber = row.__smartsheetRowNumber || null;
    const hasRealDescription = Boolean(descriptionColumn && row[descriptionColumn] && String(row[descriptionColumn]).trim());
    const description = hasRealDescription
      ? String(row[descriptionColumn]).trim()
      : rowNumber
        ? `Smartsheet request (Line ${rowNumber})`
        : `Smartsheet request (row ${rowId})`;
    const estimatedPrice = estimateColumn ? parseDollarAmount(row[estimateColumn]) : null;
    const appliedPrice = appliedColumn ? parseDollarAmount(row[appliedColumn]) : null;
    const maximoNumber = (maximoColumn && row[maximoColumn] && String(row[maximoColumn]).trim()) || null;
    const subsidiaryCode = (subsidiaryColumn && row[subsidiaryColumn] && String(row[subsidiaryColumn]).trim()) || null;
    const matchedLocationCode = locationColumn ? matchLocationCodeByName(row[locationColumn]) : null;
    const matchedVendorId = vendorColumn ? matchVendorIdByName(row[vendorColumn]) : null;
    const rawData = JSON.stringify(row);
    const breakdown = { matchedVendorId };
    const breakdownParams = [];
    WOM_COST_BREAKDOWN_FIELDS.forEach((f, i) => {
      const colTitle = breakdownColumnTitles[i];
      const value = colTitle ? parseDollarAmount(row[colTitle]) : null;
      breakdown[f.jsField] = value;
      breakdownParams.push(value);
    });

    const existing = findWomBySmartsheetRowId(rowId);

    // A row with neither a real WOM # nor a real project name isn't a work
    // request -- it's a header/legend/key row some sheets keep near the
    // top ("CODE", "Check Box < F/U Already", "Work Done < Needs", etc.),
    // or a blank filler row. Never manufacture a "PENDING-<rowId>" WOM
    // nobody can identify for one; clean up one a sync created before this
    // check existed (safe to hard-delete -- a row like this could never
    // have real hours allocated against it).
    if (!realCode && !hasRealDescription) {
      if (existing) {
        db.prepare(
          "UPDATE tasks SET status = 'cancelled', last_status_change_at = ? WHERE related_wom_code = ? AND status NOT IN ('completed','cancelled')"
        ).run(stamp, existing.code);
        db.prepare("DELETE FROM wom_status_history WHERE wom_code = ?").run(existing.code);
        deleteWom(existing.code, { force: true });
      }
      continue;
    }

    if (!existing) {
      const code = realCode || `PENDING-${rowId}`;
      // A real WOM # this app already has a record for, created some other
      // way (by hand, or an older sync before row-tracking existed) --
      // adopt it rather than erroring on a duplicate code.
      const collision = findWom(code);
      if (collision) {
        const fields = diffFields(collision, { estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, ...breakdown });
        db.prepare(
          `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
           location_code = COALESCE(location_code, ?), ${breakdownSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
           smartsheet_raw_data = ?, smartsheet_synced_at = ?,
           smartsheet_row_number = ?, smartsheet_row_id = COALESCE(smartsheet_row_id, ?) WHERE code = ?`
        ).run(
          estimatedPrice,
          appliedPrice,
          maximoNumber,
          subsidiaryCode,
          matchedLocationCode,
          ...breakdownParams,
          matchedVendorId,
          dateRequestedValue,
          rawData,
          stamp,
          rowNumber,
          rowId,
          code
        );
        if (fields.length > 0) {
          updated++;
          changedWoms.push({ code, description: collision.description, fields });
        }
        checkWomLifecycleAutoSteps(code);
        continue;
      }
      const status = realCode ? "open" : requested ? "requested" : "pending";
      db.prepare(
        `INSERT INTO woms (code, description, status, estimated_price, applied_price, maximo_number, subsidiary_code,
         location_code, ${breakdownInsertColumnsSql}, vendor_id, date_requested,
         smartsheet_raw_data, smartsheet_row_id, smartsheet_row_number, smartsheet_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${breakdownInsertPlaceholders}, ?, ?, ?, ?, ?, ?)`
      ).run(
        code,
        description,
        status,
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        String(rowId),
        rowNumber,
        stamp
      );
      created++;
      checkWomLifecycleAutoSteps(code);
      continue;
    }

    if ((existing.status === "pending" || existing.status === "requested") && realCode) {
      db.prepare(
        `UPDATE woms SET code = ?, status = 'open', estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), ${breakdownSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        realCode,
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      promoted++;
      changedWoms.push({ code: realCode, description: existing.description, fields: ["status: now open (real WOM # arrived)"] });
      recordWomStatusChange(realCode, "status", existing.status, "open", { source: "smartsheet_sync" });
      checkWomLifecycleAutoSteps(realCode);
      continue;
    }

    if (existing.status === "pending" && requested) {
      db.prepare(
        `UPDATE woms SET status = 'requested', estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), ${breakdownSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      updated++;
      changedWoms.push({ code: existing.code, description: existing.description, fields: ["status: now requested"] });
      recordWomStatusChange(existing.code, "status", "pending", "requested", { source: "smartsheet_sync" });
      checkWomLifecycleAutoSteps(existing.code);
      continue;
    }

    {
      const fields = diffFields(existing, { estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, ...breakdown });
      db.prepare(
        `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
         location_code = COALESCE(location_code, ?), ${breakdownSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      if (fields.length > 0) {
        updated++;
        changedWoms.push({ code: existing.code, description: existing.description, fields });
      }
      checkWomLifecycleAutoSteps(existing.code);
    }
  }

  return { created, promoted, updated, total: rows.length, changedWoms };
}

// ---- UKG hours (per-day source of truth) ----

function getUkgHoursByDay(techId, weekMonday) {
  const rows = db.prepare("SELECT day, hours FROM ukg_hours WHERE tech_id = ? AND week_monday = ?").all(techId, weekMonday);
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.hours]));
  return byDay;
}

function setUkgHours(techId, weekMonday, hoursByDay) {
  const upsert = db.prepare(`
    INSERT INTO ukg_hours (tech_id, week_monday, day, hours) VALUES (?, ?, ?, ?)
    ON CONFLICT (tech_id, week_monday, day) DO UPDATE SET hours = excluded.hours
  `);
  for (const [day, hours] of Object.entries(hoursByDay)) {
    upsert.run(techId, weekMonday, day, Number(hours));
  }
  return getUkgHoursByDay(techId, weekMonday);
}

function getPendingPunchByDay(techId, weekMonday) {
  const rows = db
    .prepare("SELECT day, pending_punch FROM ukg_hours WHERE tech_id = ? AND week_monday = ?")
    .all(techId, weekMonday);
  return Object.fromEntries(rows.map((r) => [r.day, Boolean(r.pending_punch)]));
}

// Only the flagged days -- note/reportedBy so the UI can tell "a technician
// reported this" (surface it, maybe with their note) from "admin flagged it
// themselves" (they already know).
function getPendingPunchDetailByDay(techId, weekMonday) {
  const rows = db
    .prepare(
      "SELECT day, pending_punch_note, pending_punch_reported_by FROM ukg_hours WHERE tech_id = ? AND week_monday = ? AND pending_punch = 1"
    )
    .all(techId, weekMonday);
  return Object.fromEntries(rows.map((r) => [r.day, { note: r.pending_punch_note, reportedBy: r.pending_punch_reported_by }]));
}

function setPendingPunch(techId, weekMonday, day, flagged, note, reportedBy) {
  db.prepare(
    `INSERT INTO ukg_hours (tech_id, week_monday, day, hours, pending_punch, pending_punch_note, pending_punch_reported_by)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (tech_id, week_monday, day) DO UPDATE SET
       pending_punch = excluded.pending_punch,
       pending_punch_note = excluded.pending_punch_note,
       pending_punch_reported_by = excluded.pending_punch_reported_by`
  ).run(techId, weekMonday, day, flagged ? 1 : 0, flagged ? note || null : null, flagged ? reportedBy || null : null);
  return getPendingPunchByDay(techId, weekMonday);
}

// Every day, across every technician, that's flagged pending AND was
// reported by the technician themselves (not admin, who already knows
// since they set the flag) -- surfaced in Priorities so a new report never
// just sits unnoticed on a week admin isn't currently looking at.
function listPendingPunchReports() {
  return db
    .prepare(
      `SELECT u.tech_id AS techId, t.name AS techName, u.week_monday AS weekMonday, u.day AS day, u.pending_punch_note AS note
       FROM ukg_hours u
       JOIN technicians t ON t.id = u.tech_id
       WHERE u.pending_punch = 1 AND u.pending_punch_reported_by = 'tech'
       ORDER BY u.week_monday ASC, u.day ASC`
    )
    .all();
}

// ---- Weekly allocation records ----

function getWeek(techId, weekMonday) {
  const row = db
    .prepare(
      `SELECT status, submitted_at, reviewed_at, reviewed_by, note, ukg_confirmed_at, ukg_confirmed_by,
              weekend_addendum_at, purelyhr_verified_at
       FROM weeks WHERE tech_id = ? AND week_monday = ?`
    )
    .get(techId, weekMonday);
  const allocations = db
    .prepare(
      `SELECT day, type, location_code AS locationCode, wom_code AS womCode, hours
       FROM allocations WHERE tech_id = ? AND week_monday = ? ORDER BY id`
    )
    .all(techId, weekMonday);

  if (!row) {
    return {
      status: "draft",
      allocations,
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      note: "",
      ukgConfirmedAt: null,
      ukgConfirmedBy: null,
      weekendAddendumAt: null,
      purelyhrVerifiedAt: null,
    };
  }
  return {
    status: row.status,
    allocations,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    note: row.note || "",
    ukgConfirmedAt: row.ukg_confirmed_at,
    ukgConfirmedBy: row.ukg_confirmed_by,
    weekendAddendumAt: row.weekend_addendum_at,
    purelyhrVerifiedAt: row.purelyhr_verified_at,
  };
}

// Shared by saveWeekendAllocations and saveDayAllocations below -- replaces
// just the allocation rows for the given days, regardless of the week's
// lock status, since both callers are deliberate lock bypasses for a
// specific, narrow correction rather than a general edit.
function replaceAllocationsForDays(techId, weekMonday, days, allocations) {
  ensureWeekRow(techId, weekMonday);
  const placeholders = days.map(() => "?").join(",");
  db.prepare(`DELETE FROM allocations WHERE tech_id = ? AND week_monday = ? AND day IN (${placeholders})`).run(
    techId,
    weekMonday,
    ...days
  );
  const insert = db.prepare(
    "INSERT INTO allocations (tech_id, week_monday, day, type, location_code, wom_code, hours) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const a of allocations) {
    insert.run(techId, weekMonday, a.day, a.type, a.locationCode || null, a.womCode || null, a.hours);
  }
}

// Replaces just a technician's Saturday/Sunday allocation rows -- used when
// they were called in over the weekend after the rest of the week was
// already submitted/approved, so the already-locked Mon-Fri record is never
// touched. Always stamps weekend_addendum_at so admin has a clear "this
// changed after the fact" signal to review, regardless of the week's
// current status.
function saveWeekendAllocations(techId, weekMonday, allocations) {
  replaceAllocationsForDays(techId, weekMonday, ["Sat", "Sun"], allocations);
  db.prepare("UPDATE weeks SET weekend_addendum_at = ?, purelyhr_verified_at = NULL WHERE tech_id = ? AND week_monday = ?").run(
    new Date().toISOString(),
    techId,
    weekMonday
  );
  return getWeek(techId, weekMonday);
}

// Replaces a single day's allocation rows -- used to fix a weekday whose
// real UKG punch came out different after the week was already
// submitted/approved (a missed clock-out, etc.), without unlocking (and
// thereby resetting to draft) the rest of an otherwise-fine week. Callers
// are expected to have already checked that day is actually flagged
// pending -- see the resolve-punch-issue route.
function saveDayAllocations(techId, weekMonday, day, allocations) {
  replaceAllocationsForDays(techId, weekMonday, [day], allocations);
  db.prepare("UPDATE weeks SET purelyhr_verified_at = NULL WHERE tech_id = ? AND week_monday = ?").run(techId, weekMonday);
  return getWeek(techId, weekMonday);
}

function acknowledgeWeekendAddendum(techId, weekMonday) {
  ensureWeekRow(techId, weekMonday);
  db.prepare("UPDATE weeks SET weekend_addendum_at = NULL WHERE tech_id = ? AND week_monday = ?").run(techId, weekMonday);
  return getWeek(techId, weekMonday);
}

// Only a submitted/approved week with actual time off on it can be marked
// verified -- a draft, or a week with none, has nothing to check against
// PurelyHR. Symmetric set/unset (like setUkgConfirmed) rather than a
// one-way "mark" so the same call handles both the button and its Undo.
function setPurelyHrVerified(techId, weekMonday, verified) {
  const week = getWeek(techId, weekMonday);
  if (verified) {
    if (!["submitted", "approved"].includes(week.status)) return null;
    if (!week.allocations.some((a) => a.type === "timeoff")) return null;
    db.prepare("UPDATE weeks SET purelyhr_verified_at = ? WHERE tech_id = ? AND week_monday = ?").run(
      new Date().toISOString(),
      techId,
      weekMonday
    );
  } else {
    db.prepare("UPDATE weeks SET purelyhr_verified_at = NULL WHERE tech_id = ? AND week_monday = ?").run(techId, weekMonday);
  }
  return getWeek(techId, weekMonday);
}

// Every submitted/approved week, across all technicians, that has time off
// on it and hasn't been checked against PurelyHR yet -- not just the
// currently-open week, so a past week doesn't quietly get missed. Each
// entry includes the actual time-off rows so admin doesn't have to open
// the week just to see what to look up.
function listWeeksNeedingPurelyHrVerification() {
  const weeks = db
    .prepare(
      `SELECT DISTINCT w.tech_id AS techId, t.name AS techName, w.week_monday AS weekMonday
       FROM weeks w
       JOIN technicians t ON t.id = w.tech_id
       WHERE w.purelyhr_verified_at IS NULL
         AND w.status IN ('submitted', 'approved')
         AND EXISTS (
           SELECT 1 FROM allocations a
           WHERE a.tech_id = w.tech_id AND a.week_monday = w.week_monday AND a.type = 'timeoff'
         )
       ORDER BY w.week_monday DESC`
    )
    .all();

  const timeOffStmt = db.prepare(
    "SELECT day, wom_code AS timeOffType, hours FROM allocations WHERE tech_id = ? AND week_monday = ? AND type = 'timeoff' ORDER BY id"
  );
  return weeks.map((w) => ({ ...w, timeOff: timeOffStmt.all(w.techId, w.weekMonday) }));
}

function setUkgConfirmed(techId, weekMonday, adminId, confirmed) {
  ensureWeekRow(techId, weekMonday);
  if (confirmed) {
    db.prepare("UPDATE weeks SET ukg_confirmed_at = ?, ukg_confirmed_by = ? WHERE tech_id = ? AND week_monday = ?").run(
      new Date().toISOString(),
      adminId,
      techId,
      weekMonday
    );
  } else {
    db.prepare("UPDATE weeks SET ukg_confirmed_at = NULL, ukg_confirmed_by = NULL WHERE tech_id = ? AND week_monday = ?").run(
      techId,
      weekMonday
    );
  }
  return getWeek(techId, weekMonday);
}

function saveAllocations(techId, weekMonday, allocations) {
  ensureWeekRow(techId, weekMonday);
  db.prepare("DELETE FROM allocations WHERE tech_id = ? AND week_monday = ?").run(techId, weekMonday);
  const insert = db.prepare(
    "INSERT INTO allocations (tech_id, week_monday, day, type, location_code, wom_code, hours) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const a of allocations) {
    insert.run(techId, weekMonday, a.day, a.type, a.locationCode || null, a.womCode || null, a.hours);
  }
  // An edit could add, remove, or change the time off that was already
  // verified against PurelyHR -- clear the mark so it gets a fresh look.
  db.prepare("UPDATE weeks SET purelyhr_verified_at = NULL WHERE tech_id = ? AND week_monday = ?").run(techId, weekMonday);
  return getWeek(techId, weekMonday);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function submitWeek(techId, weekMonday) {
  ensureWeekRow(techId, weekMonday);
  db.prepare("UPDATE weeks SET status = 'submitted', submitted_at = ?, note = '' WHERE tech_id = ? AND week_monday = ?").run(
    new Date().toISOString(),
    techId,
    weekMonday
  );
  return getWeek(techId, weekMonday);
}

function approveWeek(techId, weekMonday, adminId) {
  ensureWeekRow(techId, weekMonday);
  db.prepare("UPDATE weeks SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE tech_id = ? AND week_monday = ?").run(
    new Date().toISOString(),
    adminId,
    techId,
    weekMonday
  );
  return getWeek(techId, weekMonday);
}

function rejectWeek(techId, weekMonday, adminId, note) {
  ensureWeekRow(techId, weekMonday);
  db.prepare(
    "UPDATE weeks SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, note = ? WHERE tech_id = ? AND week_monday = ?"
  ).run(new Date().toISOString(), adminId, note || "", techId, weekMonday);
  return getWeek(techId, weekMonday);
}

function unlockWeek(techId, weekMonday, adminId) {
  ensureWeekRow(techId, weekMonday);
  db.prepare("UPDATE weeks SET status = 'draft', reviewed_at = ?, reviewed_by = ? WHERE tech_id = ? AND week_monday = ?").run(
    new Date().toISOString(),
    adminId,
    techId,
    weekMonday
  );
  return getWeek(techId, weekMonday);
}

// ---- Sessions ----

function createSession(techId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("INSERT INTO sessions (token, tech_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    techId,
    now.toISOString(),
    expiresAt.toISOString()
  );
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return findTechnician(session.tech_id);
}

function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ---- Audit log ----

function addAudit(actor, action, details) {
  const result = db
    .prepare("INSERT INTO audit_log (timestamp, actor, action, details) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), actor, action, details);
  return db.prepare("SELECT * FROM audit_log WHERE id = ?").get(Number(result.lastInsertRowid));
}

function listAudit() {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC").all();
}

// ---- Files ----

function insertFile(file) {
  db.prepare(`
    INSERT INTO files (id, related_type, related_id, category, original_name, stored_name, mime_type, size, uploaded_by, uploaded_at, form_type, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    file.id,
    file.relatedType,
    file.relatedId,
    file.category,
    file.originalName,
    file.storedName,
    file.mimeType,
    file.size,
    file.uploadedBy,
    file.uploadedAt,
    file.formType || null,
    file.expiresAt || null
  );
  return getFile(file.id);
}

function listFiles(relatedType, relatedId) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              form_type AS formType, expires_at AS expiresAt
       FROM files WHERE related_type = ? AND related_id = ? ORDER BY uploaded_at DESC`
    )
    .all(relatedType, relatedId);
}

function getFile(id) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              form_type AS formType, expires_at AS expiresAt
       FROM files WHERE id = ?`
    )
    .get(id);
}

function deleteFile(id) {
  const file = getFile(id);
  if (!file) return null;
  db.prepare("DELETE FROM files WHERE id = ?").run(id);
  return file;
}

// A document parked on a task (e.g. a COI that arrived before it was clear
// which vendor it belongs to -- see server/routes/files.js's "task"
// relatedType) never becomes filed to a vendor by itself; someone has to
// look at it and assign it once the vendor is known. This is the admin-
// wide "everything still sitting on a task" list that makes that possible
// without already knowing which task to look at.
function listTaskDocuments() {
  return db
    .prepare(
      `SELECT f.id, f.related_type AS relatedType, f.related_id AS relatedId, f.category, f.original_name AS originalName,
              f.stored_name AS storedName, f.mime_type AS mimeType, f.size, f.uploaded_by AS uploadedBy, f.uploaded_at AS uploadedAt,
              f.form_type AS formType, f.expires_at AS expiresAt, t.title AS taskTitle
       FROM files f LEFT JOIN tasks t ON t.id = CAST(f.related_id AS INTEGER)
       WHERE f.related_type = 'task'
       ORDER BY f.uploaded_at DESC`
    )
    .all();
}

// Re-files an existing upload onto a different record -- the bytes on disk
// never move, only which record they're attached to -- e.g. assigning a
// COI parked on a task (relatedType "task") onto the vendor it turned out
// to belong to (relatedType "vendor").
function relocateFile(id, { relatedType, relatedId, category }) {
  db.prepare("UPDATE files SET related_type = ?, related_id = ?, category = ? WHERE id = ?").run(relatedType, String(relatedId), category, id);
  return getFile(id);
}

// Forms (tech_form uploads) with an expiration date that's already passed or
// is coming up within `daysAhead` -- surfaced to admin/RFM on the Overview
// tab so an expired certification/license doesn't just sit unnoticed.
function listExpiringForms(daysAhead = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT f.id, f.related_id AS techId, t.name AS techName, f.form_type AS formType,
              f.original_name AS originalName, f.expires_at AS expiresAt
       FROM files f
       JOIN technicians t ON t.id = f.related_id
       WHERE f.category = 'tech_form' AND f.expires_at IS NOT NULL AND f.expires_at <= ?
       ORDER BY f.expires_at ASC`
    )
    .all(cutoffStr);
}

// Every week across every technician that's still flagged for admin's
// attention after a weekend-hours addendum (see saveWeekendAllocations) --
// not scoped to the week currently open in Overview, since a weekend
// callout on a prior week can sit unreviewed while admin's browsing a
// different one.
// Trailing completed calendar months (not counting the current one, which
// is still in progress) with zero saved reports of ANY kind (WOM/Labor/
// Financial/GL) -- for flagging a month that got skipped entirely, not for
// evaluating the current month before it's even over.
function listReportGapMonths(monthsBack = 3) {
  const now = new Date();
  const months = [];
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const existing = new Set(
    db
      .prepare("SELECT DISTINCT related_id AS relatedId FROM files WHERE related_type = 'labor_report'")
      .all()
      .map((r) => r.relatedId)
  );
  return months.filter((m) => !existing.has(m));
}

function listWeekendAddenda() {
  return db
    .prepare(
      `SELECT w.tech_id AS techId, t.name AS techName, w.week_monday AS weekMonday, w.weekend_addendum_at AS weekendAddendumAt
       FROM weeks w
       JOIN technicians t ON t.id = w.tech_id
       WHERE w.weekend_addendum_at IS NOT NULL
       ORDER BY w.weekend_addendum_at ASC`
    )
    .all();
}

module.exports = {
  UPLOADS_DIR,
  findTechnician,
  listTechnicians,
  verifyLogin,
  setHomeLocation,
  EMPLOYMENT_STATUSES,
  setEmploymentStatus,
  createTechnician,
  setTechnicianPin,
  listAdmins,
  createAdmin,
  renameAdmin,
  setAdminBasicInfo,
  setTechnicianBasicInfo,
  NOTIFICATION_PREFS,
  setNotificationPref,
  CW_STATUSES,
  TOYOTA_STATUSES,
  FORMS_STATUSES,
  ONBOARDING_STAGES,
  listVendors,
  findVendor,
  createVendor,
  updateVendor,
  deleteVendor,
  VENDOR_COI_FIELDS,
  listVendorRequests,
  addVendorRequest,
  updateVendorRequest,
  deleteVendorRequest,
  ONBOARDING_CASE_TYPES,
  listOnboardingCaseSummaries,
  ONBOARDING_TASKS,
  getOnboardingProgress,
  setOnboardingTask,
  DEVICE_TYPES,
  listDevices,
  addDevice,
  removeDevice,
  findDevice,
  addDeviceRequest,
  setDeviceRequestCompleted,
  setDeviceRequestDetails,
  getAllocationHistory,
  listLocations,
  findLocation,
  createLocation,
  deleteLocation,
  deleteTechnician,
  setLocationDetails,
  TERRITORIES,
  listWoms,
  findWom,
  createWom,
  countWomAllocatedHours,
  womHoursByTechnician,
  deleteWom,
  WOM_STATUSES,
  setWomStatus,
  getPseReviewerId,
  setPseReviewer,
  WOM_LIFECYCLE_STEPS,
  getWomLifecycleSteps,
  checkWomLifecycleAutoSteps,
  refreshAllOpenWomLifecycles,
  countWomLifecyclePseNotSent,
  cleanupLegacyPseWorkflowTasks,
  completeWomLifecycleStep,
  listWomLifecycleTasks,
  getWomCostSummary,
  TASK_STATUSES,
  TASK_PRIORITIES,
  OPEN_TASK_STATUSES,
  createTask,
  findTask,
  findTaskBySourceKey,
  upsertTaskBySourceKey,
  completeTaskBySourceKey,
  setTaskStatus,
  updateTask,
  deleteTask,
  rescheduleTask,
  unsnoozeTask,
  listTaskReschedules,
  assignTask,
  addTaskComment,
  listTaskComments,
  listTasks,
  recordWomStatusChange,
  listWomStatusHistory,
  ensureRecurringTasks,
  createRecurringTaskTemplate,
  listRecurringTaskTemplates,
  findRecurringTaskTemplate,
  setRecurringTaskTemplateActive,
  recordSyncLog,
  getLastSyncLog,
  getWomSyncHistory,
  markWomSmartsheetReflected,
  setWomDetails,
  setWomPricing,
  syncWomsFromSheetRows,
  getUkgHoursByDay,
  setUkgHours,
  getPendingPunchByDay,
  getPendingPunchDetailByDay,
  setPendingPunch,
  listPendingPunchReports,
  getWeek,
  saveAllocations,
  saveWeekendAllocations,
  saveDayAllocations,
  acknowledgeWeekendAddendum,
  setPurelyHrVerified,
  listWeeksNeedingPurelyHrVerification,
  setUkgConfirmed,
  submitWeek,
  approveWeek,
  rejectWeek,
  unlockWeek,
  createSession,
  getSessionUser,
  deleteSession,
  addAudit,
  listAudit,
  insertFile,
  listFiles,
  getFile,
  deleteFile,
  listTaskDocuments,
  relocateFile,
  listExpiringForms,
  listWeekendAddenda,
  listReportGapMonths,
};
