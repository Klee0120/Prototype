const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { seed } = require("./seed");
const { hashPin, verifyPin } = require("../utils/password");
// A deliberate, narrow exception to "db.js stays pure, routes own side
// effects": task creation/assignment happens from many places (manual
// creation, automated workflow rules deep in this file, recurring
// regeneration), so centralizing the notify-the-assignee check here is far
// less error-prone than duplicating it at every call site.
const mailer = require("../utils/mailer");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Overridable so tests can point at a throwaway file instead of the real
// mock database.
const DB_PATH = process.env.LABOR_DB_PATH || path.join(__dirname, "store.sqlite");
const UPLOADS_DIR = process.env.LABOR_UPLOADS_DIR || path.join(__dirname, "uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
// Default pragmas (DELETE journal mode, synchronous=FULL) fsync on every
// single INSERT/UPDATE that isn't wrapped in an explicit transaction -- a
// sequence of several individually-committed writes (e.g.
// ensureRecurringTasks' half-dozen upserts, run on nearly every task-list
// load) pays that fsync cost once per statement. WAL defers the full fsync
// to periodic checkpoints instead of every commit, and synchronous=NORMAL
// (safe specifically paired with WAL -- SQLite's own documented combo) only
// fsyncs at those checkpoints rather than every transaction.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

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

  -- Free-text remarks an RFM/admin writes about a technician (performance
  -- notes, a conversation to remember, etc.) -- not a file, just a dated log
  -- entry, since that's what this tab is actually for.
  CREATE TABLE IF NOT EXISTS tech_remarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tech_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
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

  -- A running, dated log of free-form remarks about a vendor -- distinct
  -- from vendors.notes (one overwritable field) so several people adding
  -- notes over time never erase each other's; same pattern as task_comments.
  CREATE TABLE IF NOT EXISTS vendor_remarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- A GL reclass submission -- modeled directly on Krista's real "RECLASS"
  -- tracking sheet (JOURNAL ENTRY FORM - RECLASS), not a generic placeholder.
  -- One batch per submission (region/revision/reason, matching the sheet's
  -- own metric block), many line items each. Submitting a reclass in this
  -- app never changes any posted-actuals figure -- see financial_entries
  -- below once it exists; a reclass only ever reflects as "pending" until a
  -- later GL import confirms the same correction landed.
  CREATE TABLE IF NOT EXISTS reclass_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT,
    reason_for_change TEXT,
    revision_no INTEGER,
    revision_date TEXT,
    original_date_published TEXT,
    produced_by TEXT,
    total_gl_line_items INTEGER,
    reported_total_amount REAL,
    source_file_name TEXT,
    imported_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Each line keeps the full FROM/TO coding (job#/object/subsidiary/WOM/
  -- amount on both sides), exactly like the real sheet -- never collapsed
  -- into a single "corrected to" field, since knowing what it WAS coded as
  -- is what makes the recurring-error pattern analysis possible later.
  -- source distinguishes how this app came to have the row: 'imported' (a
  -- historical submission file), 'manual' (an admin logged a finding by
  -- hand), or 'auto_flagged' (created from a GL-vs-WOM/PO coding mismatch
  -- the app itself caught -- not wired up yet, but the schema's ready for
  -- it rather than needing a migration later).
  CREATE TABLE IF NOT EXISTS reclass_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER,
    line_number INTEGER,
    from_job_number TEXT,
    from_object_code TEXT,
    from_subsidiary TEXT,
    from_wom_number TEXT,
    from_amount REAL,
    to_job_number TEXT,
    to_object_code TEXT,
    to_subsidiary TEXT,
    to_wom_number TEXT,
    to_amount REAL,
    vendor TEXT,
    comments TEXT,
    region TEXT,
    cost_center_adjusted INTEGER NOT NULL DEFAULT 0,
    subledger_adjusted INTEGER NOT NULL DEFAULT 0,
    object_code_adjusted INTEGER NOT NULL DEFAULT 0,
    wom_adjusted INTEGER NOT NULL DEFAULT 0,
    impacts_final_invoice TEXT,
    caused_by TEXT,
    root_cause TEXT,
    path_forward TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'flagged',
    confirmed_gl_reference TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- One row per WOM whose contracted-services cost has ever been flagged
  -- above its own quote in Financials -- an admin's record of why, not a
  -- recomputation of the flag itself (that's always live off woms.estimated_
  -- contracted/applied_contracted). review_reason is one of: scope_change,
  -- entry_error, coding_issue, unexplained -- set when review_status moves
  -- to 'reviewed'; left null while still 'needs_review'. Keyed by WOM code
  -- rather than WOM+vendor since a WOM only ever has one vendor_id today.
  CREATE TABLE IF NOT EXISTS wom_cost_reviews (
    wom_code TEXT PRIMARY KEY,
    review_status TEXT NOT NULL DEFAULT 'needs_review',
    review_reason TEXT,
    note TEXT DEFAULT '',
    reviewed_by TEXT,
    reviewed_at TEXT,
    updated_at TEXT NOT NULL
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

  -- Budget PO Tracker: one row per request/PO from the Operations PO
  -- tracker Excel export -- a separate, manually-uploaded tracker (not a
  -- live Smartsheet sync like WOMs), for non-Toyota operating-budget
  -- purchases. Two identities, both computed by computePoMatchKeys:
  -- composite_key (requestor/date/description) is always set and never
  -- changes once a row exists; po_number_key (the real PO Number) starts
  -- NULL and gets filled in the moment one appears, found from then on by
  -- either key -- never by renaming/replacing composite_key, which would
  -- orphan a still-PO-less duplicate row elsewhere in the same tracker that
  -- needs to keep finding this same record by its composite key. vendor_id
  -- and region are "sticky" -- an import only ever sets them when they're
  -- still NULL, never overwrites a value this app (auto-match, or the
  -- admin's own confirm/assign action) already put there, so a re-import
  -- can never undo manual organization work. lifecycle_status flips from
  -- needs_organization to active the moment a record has a real PO Number, a
  -- matched location, AND a matched vendor (see isPoFullyResolved/
  -- maybeAutoActivatePo) -- at that point there's nothing left to organize,
  -- so holding it back would just be friction, not a safeguard. A record
  -- missing any one of those three still needs Krista's own explicit Move
  -- to Active action; this never un-activates a record either way.
  -- line_number (the sheet's own row position) is tried
  -- FIRST on re-import, ahead of either key -- Krista's workflow edits a
  -- row's vendor/description text in place after correcting a vendor
  -- number, which can change what composite_key that row would compute to;
  -- matching by line_number first means that edit still lands on the same
  -- record instead of registering as a new one. It's a sticky-ish fallback
  -- rather than the sole identity, though: a row that's genuinely moved
  -- (sheet re-sorted, rows inserted above it) falls through to po_number_key
  -- / composite_key like before, and line_number is then updated to match.
  CREATE TABLE IF NOT EXISTS pos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    composite_key TEXT NOT NULL UNIQUE,
    po_number_key TEXT UNIQUE,
    line_number INTEGER,
    po_number TEXT,
    date_requested TEXT,
    requestor TEXT,
    description TEXT,
    ef_job_number_raw TEXT,
    ef_job_number TEXT,
    location_code TEXT,
    region TEXT,
    region_confirmed INTEGER NOT NULL DEFAULT 0,
    po_amount REAL,
    change_order TEXT,
    status TEXT,
    vendor_name TEXT,
    vendor_number TEXT,
    vendor_id INTEGER,
    vendor_link_confirmed INTEGER NOT NULL DEFAULT 0,
    pps_job_number TEXT,
    e1_wom_job_number TEXT,
    wom_number TEXT,
    asset_number TEXT,
    maximo_wo TEXT,
    object_code TEXT,
    subsidiary TEXT,
    admin_name TEXT,
    urgent INTEGER NOT NULL DEFAULT 0,
    urgent_notes TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'needs_organization',
    missing_from_import INTEGER NOT NULL DEFAULT 0,
    first_imported_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- One row per completed import run -- the "last import" timestamp/summary
  -- the POs page shows, and the audit log of what each one did.
  CREATE TABLE IF NOT EXISTS po_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_by TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    invalid_count INTEGER NOT NULL DEFAULT 0
  );

  -- GL import: Krista's monthly "GL Report" extract, matched against the
  -- Budget PO Tracker by PO number -- real $ actually paid (per the GL),
  -- compared against what the PO was approved for, plus whether the GL
  -- posting's own object/subsidiary code matches what's on the PO itself
  -- (a real coding-mismatch check, not a guess, since the PO Tracker already
  -- stores its own object_code/subsidiary per PO). One import replaces
  -- whatever was previously imported for that exact period/fiscal year --
  -- a closed GL period's extract is the authoritative full pull for that
  -- period, not something that gets merged row by row.
  CREATE TABLE IF NOT EXISTS gl_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_number INTEGER,
    fiscal_year INTEGER,
    row_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    unmatched_count INTEGER NOT NULL DEFAULT 0,
    source_file_name TEXT,
    imported_by TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gl_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER,
    period_number INTEGER,
    fiscal_year INTEGER,
    gl_date TEXT,
    document_type TEXT,
    document_number TEXT,
    journal_entry_line_number INTEGER,
    business_unit TEXT,
    object_account TEXT,
    object_account_code TEXT,
    subsidiary TEXT,
    amount REAL,
    batch_number TEXT,
    supplier_invoice_number TEXT,
    invoice_date TEXT,
    location_code TEXT,
    remark TEXT,
    purchase_order TEXT,
    matched_po_id INTEGER,
    created_at TEXT NOT NULL
  );

  -- Without these, every GL Reconciliation page load and reclass GL-link
  -- lookup does a full table scan of gl_entries -- fine at one month's
  -- ~8,000 rows, not fine once several months have accumulated (each
  -- import only replaces its own period, so this table only ever grows).
  CREATE INDEX IF NOT EXISTS idx_gl_entries_matched_po_id ON gl_entries(matched_po_id);
  CREATE INDEX IF NOT EXISTS idx_gl_entries_purchase_order ON gl_entries(purchase_order);
  CREATE INDEX IF NOT EXISTS idx_gl_entries_business_unit ON gl_entries(business_unit);
  CREATE INDEX IF NOT EXISTS idx_gl_entries_period ON gl_entries(period_number, fiscal_year);
  CREATE INDEX IF NOT EXISTS idx_pos_wom_number ON pos(wom_number);
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
// The tech's primary iPad # on Basic Info -- same role `phone` already
// plays, except there was never anywhere to put it. Saving it here also
// auto-registers (or updates) a matching ipad-type device on the Devices
// tab -- see syncIpadDevice -- instead of leaving that as a second, manual
// step for a number already on file.
if (!hasColumn("technicians", "ipad")) {
  db.exec("ALTER TABLE technicians ADD COLUMN ipad TEXT");
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
// Per-reason email opt-ins for tasks, independent of notification_pref above
// (which is specifically the "hours are ready" email) -- a person (tech or
// admin) turns each of these on for themselves; none fire until they do.
// Checked in createTask (see TASK_NOTIFICATION_REASONS) whenever a task
// lands on someone with a real assignee.
const TASK_NOTIFICATION_COLUMNS = ["notify_task_assigned", "notify_task_urgent", "notify_task_wom", "notify_task_po_discrepancy"];
for (const col of TASK_NOTIFICATION_COLUMNS) {
  if (!hasColumn("technicians", col)) {
    db.exec(`ALTER TABLE technicians ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
  }
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
// A technician's own attestation, at submit time, that their allocations
// reflect the work they actually performed -- distinct from ukg_confirmed_at
// above (an admin's own internal checklist step) and from submitted_at
// (set on every submission, including one an admin drives on a tech's
// behalf). Only ever set when the technician submits their own week; an
// admin submitting on a tech's behalf leaves it null, since the admin isn't
// the one attesting to work they didn't personally perform.
if (!hasColumn("weeks", "tech_confirmed_at")) {
  db.exec("ALTER TABLE weeks ADD COLUMN tech_confirmed_at TEXT");
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
// When this device is next eligible for an upgrade (e.g. a phone's carrier
// upgrade date) -- a plain date, not auto-computed, since that's set by the
// carrier/contract, not anything this app tracks.
if (!hasColumn("tech_devices", "upgrade_date")) {
  db.exec("ALTER TABLE tech_devices ADD COLUMN upgrade_date TEXT");
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
// "General Mgt & Admin" is Toyota's own Chart of Accounts section for
// corporate/overhead job numbers that aren't a real field site in any
// geographic territory -- its own bucket rather than guessing a geography
// for them (see parseCoaWorkbook's SECTION_TERRITORY_PATTERNS).
const TERRITORIES = ["Midwest", "HQ Plano", "East", "West", "North", "TdPR REGION", "General Mgt & Admin"];
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
// A location's PPS Contract Job Number -- the third of the three job
// numbers the Chart of Accounts tracks per site (alongside E&F Contract Job
// Number and E1 WOM Job Number). Not consumed by any matching logic yet,
// kept for reference the same way the other two are.
if (!hasColumn("locations", "pps_job_number")) {
  db.exec("ALTER TABLE locations ADD COLUMN pps_job_number TEXT");
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
// Verbatim Status/Work Completed/Billing/Requested-By values from the
// Smartsheet tracker -- kept separate from `status` (which only an admin
// ever sets, see tests/smartsheetSync.test.js) so the sheet's own account of
// completion/invoicing is visible instead of silently landing only inside
// the opaque smartsheet_raw_data blob. Never written into `status` itself;
// see computeWomStatusConflict in routes/woms.js for how a disagreement
// between the two is surfaced without ever auto-overwriting the admin's
// manually-set status.
if (!hasColumn("woms", "source_status_raw")) {
  db.exec("ALTER TABLE woms ADD COLUMN source_status_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_work_completed_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_work_completed INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_billing_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_requested_by TEXT");
}
// The tracker's own billing checklist (Vendor INV Attached, Invoice
// Attached, Journal Edit, Ariba Confirm, Sent to Jason) -- the real,
// granular evidence of billing progress, kept fully separate from Work
// Completed. Work Completed says the job itself is done; these say where it
// actually stands in getting invoiced. Never used to set `status` by
// themselves (see sourceImpliesInvoiced/WOM_BILLING_CHECKLIST_FIELDS below,
// which also folds in a real invoice_number -- the only other accepted
// evidence of invoicing).
if (!hasColumn("woms", "source_vendor_inv_attached")) {
  db.exec("ALTER TABLE woms ADD COLUMN source_vendor_inv_attached_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_vendor_inv_attached INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_invoice_attached_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_invoice_attached INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_journal_edit_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_journal_edit INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_ariba_confirm_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_ariba_confirm INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_sent_to_jason_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_sent_to_jason INTEGER");
}
// Two more real tracker columns, added recently on the sheet so older
// closed/invoiced WOMs legitimately predate them and will just show these
// blank -- not a sync bug, nothing to backfill. "Billing Ref #" is a
// verbatim reference number (e.g. a RITM#) kept for display only, same as
// the other source_* raw fields. The "Billing" checkbox -- "have you
// confirmed the batch was posted" -- is real billing-checklist evidence,
// so it's a 6th entry in WOM_BILLING_CHECKLIST_FIELDS alongside the other 5.
if (!hasColumn("woms", "source_billing_ref_number")) {
  db.exec("ALTER TABLE woms ADD COLUMN source_billing_ref_number TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_batch_posted_confirmed_raw TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_batch_posted_confirmed INTEGER");
}
// "Work Completed Date" and "Batch Date" -- verbatim sheet dates shown
// alongside the Billing progress card so an admin can see when work
// actually wrapped and when a batch posted, not just whether it did.
// Display-only, same as the other source_* raw fields.
if (!hasColumn("woms", "source_work_completed_date")) {
  db.exec("ALTER TABLE woms ADD COLUMN source_work_completed_date TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN source_batch_date TEXT");
}
// The tracker's own per-WOM reclass note -- "Reclass Amount Requested"
// lines up with this app's own "Applied over Toyota PO" overage figures,
// so this is the remediation record for that list. "Reclass to" is loose
// free text on the real sheet (mostly "GMP" -- Krista's shorthand for
// "sent to the location's default E&F coding, not kept on this WOM" -- or
// a bare WOM #), so it's kept verbatim and classified for display rather
// than forced into a strict enum; see reclassToSummary below.
if (!hasColumn("woms", "source_reclass_amount_requested")) {
  db.exec("ALTER TABLE woms ADD COLUMN source_reclass_amount_requested REAL");
  db.exec("ALTER TABLE woms ADD COLUMN source_reclass_submitted INTEGER");
  db.exec("ALTER TABLE woms ADD COLUMN source_reclass_to_raw TEXT");
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
// RFM's escape hatch on a change-order task: hand it to finance to see if
// trimming labor can bring the applied cost back in line and avoid the
// Toyota paperwork, instead of requesting the change order. A timestamp
// (not just a role flip) so refreshWomLifecycleTask -- which otherwise
// always forces a Toyota-paperwork-gap task back into RFM's queue
// regardless of the real lifecycle step, see its own comment -- knows to
// leave this one with finance instead, until either the overage clears on
// its own or someone actually requests the Toyota PO (see
// referWomChangeOrderToAdmin/requestWomChangeOrderPo below).
if (!hasColumn("tasks", "referred_to_admin_at")) {
  db.exec("ALTER TABLE tasks ADD COLUMN referred_to_admin_at TEXT");
}
// A task can be created against a Budget PO Tracker record while it's still
// sitting in Needs Organization (e.g. "figure out who this vendor is") --
// related_po_id is how it's linked. Distinct from the older free-text
// related_po column, which is just a PO-number note, not a real relation.
// See listTasks' own join: a task pointing at a still-needs_organization PO
// is excluded from every list/summary/notification until that PO is moved
// to Active.
if (!hasColumn("tasks", "related_po_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN related_po_id INTEGER");
}
// Which step a "po_request" task (a tech asked for a C&W PO, see
// POST /tasks/request-po) is at -- "requested" (admin hasn't generated the
// real PO yet) -> "pending_invoice" (PO generated, vendor asked for their
// invoice, due_at holds the follow-up deadline) -> "review_close" (that
// deadline passed with no invoice -- admin snoozes via the existing
// Reschedule feature or closes it as aged out). A separate column rather
// than encoding it in category, same reasoning as is_exception/
// is_change_order above: category drives the Type-grouping/color, this
// drives which action the admin actually sees.
if (!hasColumn("tasks", "po_stage")) {
  db.exec("ALTER TABLE tasks ADD COLUMN po_stage TEXT");
}
// When the admin actually marked the real PO generated (uploaded the
// document) -- created_at to po_generated_at is the "how long did it take
// to generate this PO" KPI figure.
if (!hasColumn("tasks", "po_generated_at")) {
  db.exec("ALTER TABLE tasks ADD COLUMN po_generated_at TEXT");
}
// Separate from related_po_id above on purpose: related_po_id's own
// listTasks join hides a task until the PO it points at is moved to
// Active, which is the right behavior for a task *about* an existing PO
// record, but wrong for a po_request task -- it should stay visible the
// whole time regardless of that PO's own organization state. Set
// automatically once the real PO shows up in a tracker import (see
// linkPoRequestTaskFromImport) by matching the "PO Request Task #<id>"
// reference the tech was told to paste into the Smartsheet form's
// Description field -- the only thread connecting the two records.
if (!hasColumn("tasks", "matched_po_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN matched_po_id INTEGER");
}
// Which situation created this po_request task -- "tech_requested" (the
// normal flow: a tech asked for a PO, see POST /tasks/request-po) vs.
// "ap_invoice_backfill" (AP already received a vendor invoice with no PO
// on file at all -- an admin generates the missing PO after the fact,
// with no tech ever having asked for one). These measure two genuinely
// different things: the first is "how long did it take to fulfill a
// request," the second is "how long did it take to notice and fix a gap"
// -- averaging them together would misrepresent both. NULL (every row
// before this column existed) is treated as "tech_requested" everywhere
// this is read, since that was the only flow before this one existed.
if (!hasColumn("tasks", "po_origin")) {
  db.exec("ALTER TABLE tasks ADD COLUMN po_origin TEXT");
}
// Who actually did the generating -- not assumed from assigned_to, which
// can drift after the fact (reassigned, claimed by someone else) in a way
// that would misattribute the Performance tab's PO-turnaround KPI to the
// wrong person. Set once, in markTaskPoGenerated, off the acting user at
// that moment.
if (!hasColumn("tasks", "po_generated_by")) {
  db.exec("ALTER TABLE tasks ADD COLUMN po_generated_by TEXT");
}
// Who resolved/updated a vendor compliance case -- the Performance tab's
// "vendor docs completed" KPI counts these, same reasoning as
// po_generated_by above (don't infer from whoever's currently viewing the
// vendor's profile).
if (!hasColumn("vendor_requests", "updated_by")) {
  db.exec("ALTER TABLE vendor_requests ADD COLUMN updated_by TEXT");
}
// Set the moment a reclass item's status actually transitions into
// "submitted" (see updateReclassItem) -- created_at to submitted_at is the
// Performance tab's reclass-turnaround KPI. Never backdated/recomputed on
// a later edit once set, same spirit as po_generated_at.
if (!hasColumn("reclass_items", "submitted_at")) {
  db.exec("ALTER TABLE reclass_items ADD COLUMN submitted_at TEXT");
  db.exec("ALTER TABLE reclass_items ADD COLUMN submitted_by TEXT");
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
// Restricted files (e.g. a vendor's banking/ACH details) are admin-only to
// view or download, regardless of relatedType's usual read rules -- a non-
// admin never sees them listed at all. Defaults to 'standard' so every
// already-uploaded file stays visible exactly as it was before this column
// existed.
if (!hasColumn("files", "access_level")) {
  db.exec("ALTER TABLE files ADD COLUMN access_level TEXT NOT NULL DEFAULT 'standard'");
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
// A structured reason category for an explicit, admin-driven denial --
// distinct from a case being denied (COI/W-9/Payment, see
// deriveOnboardingStage), since a vendor can also be denied for reasons no
// case captures at all (poor work quality, cost). Non-empty here marks the
// denial as a manual, sticky decision: deriveOnboardingStage short-circuits
// to "denied" while this is set, so a later case touch (e.g. logging an
// unrelated COI renewal) can never silently flip the vendor back to
// onboarded/in_progress out from under that decision -- it only clears via
// an explicit reinstate (see reinstateVendor).
if (!hasColumn("vendors", "denied_reason_category")) {
  db.exec("ALTER TABLE vendors ADD COLUMN denied_reason_category TEXT DEFAULT ''");
}
// Krista's own "this is who we go to first" flag for a vendor -- distinct
// from C&W/Toyota approval status (which is about whether they're allowed
// to work at all, not whether they're who she'd pick first).
if (!hasColumn("vendors", "preferred")) {
  db.exec("ALTER TABLE vendors ADD COLUMN preferred INTEGER NOT NULL DEFAULT 0");
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

// Payroll, journal entries, accruals, etc. legitimately have no PO at all --
// tracked separately from unmatched_count (a PO # that IS present but isn't
// in the Budget PO Tracker), which is the only one that's actually a thing
// to go investigate.
if (!hasColumn("gl_imports", "no_po_reference_count")) {
  db.exec("ALTER TABLE gl_imports ADD COLUMN no_po_reference_count INTEGER NOT NULL DEFAULT 0");
}

// "Name - Alpha Explanation" -- confirmed against Krista's real July GL
// export to be where a reclass posting actually identifies itself (e.g.
// "AER Reclass", "AER Reclass July 2026"), as a batch of offsetting debit/
// credit lines across the old and new coding. Not captured before this --
// a period imported before this column existed needs re-importing to
// backfill it.
if (!hasColumn("gl_entries", "name_alpha")) {
  db.exec("ALTER TABLE gl_entries ADD COLUMN name_alpha TEXT");
}
// Links a reclass item back to the specific Budget PO Tracker record it was
// one-click-flagged from (see flagPosForReclass) -- lets the PO Tracker show
// "already flagged this month" without guessing at a job-number match.
if (!hasColumn("reclass_items", "related_po_id")) {
  db.exec("ALTER TABLE reclass_items ADD COLUMN related_po_id INTEGER");
}
// Who to loop in for this potential reclass -- the Budget PO Tracker's own
// Admin column for whichever PO this item traces back to (see
// resolveAdminNameForReclassFields), auto-filled the same way regardless of
// which of the three flag entry points (PO Tracker, WOM detail, Reclasses
// tab search) created the item.
if (!hasColumn("reclass_items", "admin_name")) {
  db.exec("ALTER TABLE reclass_items ADD COLUMN admin_name TEXT");
}
// Which fiscal period this finding was flagged/imported in (see
// resolveFiscalPeriod) -- lets the Reclasses tab filter by month/year the
// same way the rest of the app's GL screens do, instead of a plain calendar
// month that doesn't actually match how periods are bounded. Backfills both
// this and region (see resolveRegionForReclassFields) for every row that
// predates this column -- a manually-flagged item never got a region before
// this fix existed (only imported ones, straight from the submission
// sheet's own Region column, already had one).
if (!hasColumn("reclass_items", "fiscal_period_number")) {
  db.exec("ALTER TABLE reclass_items ADD COLUMN fiscal_period_number INTEGER");
  db.exec("ALTER TABLE reclass_items ADD COLUMN fiscal_year INTEGER");
  const rowsToBackfill = db
    .prepare("SELECT id, created_at, related_po_id, from_wom_number, to_wom_number, region FROM reclass_items")
    .all();
  const backfillReclassStmt = db.prepare(
    "UPDATE reclass_items SET fiscal_period_number = ?, fiscal_year = ?, region = COALESCE(region, ?) WHERE id = ?"
  );
  for (const row of rowsToBackfill) {
    const period = resolveFiscalPeriod(String(row.created_at || "").slice(0, 10));
    const resolvedRegion = resolveRegionForReclassFields({
      relatedPoId: row.related_po_id,
      fromWomNumber: row.from_wom_number,
      toWomNumber: row.to_wom_number,
    });
    backfillReclassStmt.run(period ? period.periodNumber : null, period ? period.fiscalYear : null, resolvedRegion, row.id);
  }
}
// Precomputed at import time (see importGlEntries) instead of recomputed on
// every GL Reconciliation page load -- comparing the GL's own
// subsidiary/object code against the matched PO's requires string-parsing
// the PO's "code + description" fields (parseObjectAccountCode), which
// isn't expressible as a plain SQL filter. Computing it once per line at
// import time, instead of for every matched PO on every read, is what
// makes server-side paginating/filtering the reconciled list possible.
if (!hasColumn("gl_entries", "subsidiary_mismatch")) {
  db.exec("ALTER TABLE gl_entries ADD COLUMN subsidiary_mismatch INTEGER");
  db.exec("ALTER TABLE gl_entries ADD COLUMN object_code_mismatch INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gl_entries_mismatch ON gl_entries(matched_po_id, subsidiary_mismatch, object_code_mismatch)");
  // One-time backfill for every already-matched line, run in JS with the
  // exact same parseObjectAccountCode logic the live import path uses below
  // -- a SQL-side CAST(x AS INTEGER) shortcut was tried first and rejected
  // after testing showed it silently strips a leading zero ('0100' -> 100),
  // which would diverge from parseObjectAccountCode's string-preserving
  // regex on any real code that has one.
  const linesToBackfill = db
    .prepare(
      `SELECT g.id, g.subsidiary AS glSubsidiary, g.object_account_code AS glObjectCode,
              p.subsidiary AS poSubsidiary, p.object_code AS poObjectCode
       FROM gl_entries g JOIN pos p ON p.id = g.matched_po_id`
    )
    .all();
  const backfillStmt = db.prepare("UPDATE gl_entries SET subsidiary_mismatch = ?, object_code_mismatch = ? WHERE id = ?");
  for (const line of linesToBackfill) {
    const poSubsidiaryCode = parseObjectAccountCode(line.poSubsidiary);
    const poObjectCode = parseObjectAccountCode(line.poObjectCode);
    const subsidiaryMismatch = poSubsidiaryCode && line.glSubsidiary && String(line.glSubsidiary) !== poSubsidiaryCode ? 1 : 0;
    const objectCodeMismatch = poObjectCode && line.glObjectCode && String(line.glObjectCode) !== poObjectCode ? 1 : 0;
    backfillStmt.run(subsidiaryMismatch, objectCodeMismatch, line.id);
  }
}
// A GL line resolves to a location two ways: precisely, via its own
// "Business Unit" -- the same 12-digit JDE job number the COA import already
// backfilled onto locations.ef_job_number/pps_job_number/wom_job_number
// (see findLocationByJobNumber) -- or, when a business unit isn't on file
// under any of those three (a site the COA import hasn't captured, or a
// non-Toyota contract), by tolerantly matching the raw "Location Code"
// column's own facility name against a real location's name (see
// matchLocationCodeByName). Backs the Spend Breakdown view's per-territory
// split (see getGlSpendBreakdown): a line that resolves neither way just
// reads "Unassigned" there rather than being guessed at.
if (!hasColumn("gl_entries", "matched_location_code")) {
  db.exec("ALTER TABLE gl_entries ADD COLUMN matched_location_code TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gl_entries_matched_location_code ON gl_entries(matched_location_code)");
}
// Business-Unit-based matching shipped after the name-only version above had
// already backfilled (and mismatched or left blank) real imported data --
// gated on its own marker column so it runs its full, more-precise re-match
// over every existing GL line exactly once, the same one-shot shape as the
// migration above, rather than only taking effect on the next re-import.
if (!hasColumn("gl_entries", "matched_location_source")) {
  db.exec("ALTER TABLE gl_entries ADD COLUMN matched_location_source TEXT");
  const jobNumberCache = new Map();
  const resolveByJobNumber = (businessUnit) => {
    if (!businessUnit) return null;
    if (!jobNumberCache.has(businessUnit)) {
      const location = findLocationByJobNumber(businessUnit);
      jobNumberCache.set(businessUnit, location ? location.code : null);
    }
    return jobNumberCache.get(businessUnit);
  };
  const locationNameCache = new Map();
  const resolveByName = (raw) => {
    if (!raw) return null;
    if (!locationNameCache.has(raw)) locationNameCache.set(raw, matchLocationCodeByName(extractGlLocationName(raw)));
    return locationNameCache.get(raw);
  };
  const glRows = db.prepare("SELECT id, business_unit, location_code FROM gl_entries").all();
  const backfillLocStmt = db.prepare("UPDATE gl_entries SET matched_location_code = ?, matched_location_source = ? WHERE id = ?");
  for (const row of glRows) {
    const byJobNumber = resolveByJobNumber(row.business_unit);
    const matched = byJobNumber || resolveByName(row.location_code);
    const source = byJobNumber ? "business_unit" : matched ? "name" : null;
    if (matched) backfillLocStmt.run(matched, source, row.id);
  }
}

// A GL line's own "Subledger - G/L" is its WOM Number when "Subledger Type"
// is "W" (confirmed 1:1 on real data: that field is set exactly when
// Subledger Type = "W", never for any other type) -- a labor/time line can
// be coded straight to a WOM project this way with no Purchase Order at
// all, which is a different reason for having no PO than payroll burden or
// an accrual. Lets Spend Breakdown offer a WOM-reference toggle alongside
// its PO-reference one.
if (!hasColumn("gl_entries", "subledger_gl")) {
  db.exec("ALTER TABLE gl_entries ADD COLUMN subledger_gl TEXT");
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

function createAdmin({ id, name, pin, homeLocationCode }) {
  db.prepare(
    `INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code)
     VALUES (?, ?, ?, 'admin', 1, 'active', ?)`
  ).run(id, name, hashPin(pin), homeLocationCode || null);
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

// An admin's own record-keeping details (home location, UKG ID, hire date,
// email, phone, iPad #) -- real columns a technician row already has, but
// an admin account never had a way to set them, since none of this feeds
// any admin-side logic the way it does for a technician's own
// allocations/scheduling. Only touches a field when it's actually passed
// (unlike setTechnicianBasicInfo, which overwrites every basic-info field
// at once) since an admin account has never set most of these and this
// shouldn't be the thing that silently blanks one out if that ever
// changes. No device auto-sync for the iPad # here the way
// syncIpadDevice does for a technician -- admin accounts have no Devices
// tab for that device to actually show up on.
function setAdminBasicInfo(id, { ukgId, hireDate, homeLocationCode, email, phone, ipad } = {}) {
  const existing = findTechnician(id);
  if (!existing) return null;
  db.prepare(
    "UPDATE technicians SET ukg_id = ?, hire_date = ?, home_location_code = ?, email = ?, phone = ?, ipad = ? WHERE id = ? AND role = 'admin'"
  ).run(
    ukgId !== undefined ? ukgId || null : existing.ukg_id,
    hireDate !== undefined ? hireDate || null : existing.hire_date,
    homeLocationCode !== undefined ? homeLocationCode || null : existing.home_location_code,
    email !== undefined ? email || null : existing.email,
    phone !== undefined ? phone || null : existing.phone,
    ipad !== undefined ? ipad || null : existing.ipad,
    id
  );
  return findTechnician(id);
}

function setTechnicianBasicInfo(techId, { email, phone, ipad, ukgId, position, hireDate, terminationDate, standardDailyHours }) {
  db.prepare(
    `UPDATE technicians
     SET email = ?, phone = ?, ipad = ?, ukg_id = ?, position = ?, hire_date = ?, termination_date = ?, standard_daily_hours = ?
     WHERE id = ?`
  ).run(
    email || null,
    phone || null,
    ipad || null,
    ukgId || null,
    position || null,
    hireDate || null,
    terminationDate || null,
    standardDailyHours === "" || standardDailyHours == null ? null : Number(standardDailyHours),
    techId
  );
  syncIpadDevice(techId, ipad);
  return findTechnician(techId);
}

// Keeps this tech's primary ipad-type device (Devices tab) in sync with
// whatever iPad # is on file in Basic Info, so it shows up there -- ready
// for an IT request (upgrade, replacement, whatever) -- without a second,
// separate "Assign device" step for a number the company already owns and
// has on record. There's meant to be just the one primary line here, same
// role as `phone`; the oldest existing ipad-type device is treated as that
// primary one. A genuinely second iPad for someone still gets added by
// hand via the regular Devices tab form. Clearing the Basic Info field
// never deletes the device or its request history -- only a value actually
// being set does anything here.
function syncIpadDevice(techId, ipad) {
  if (!ipad) return;
  const existing = db.prepare("SELECT id FROM tech_devices WHERE tech_id = ? AND device_type = 'ipad' ORDER BY id ASC LIMIT 1").get(techId);
  if (existing) {
    db.prepare("UPDATE tech_devices SET device_name = ? WHERE id = ?").run(ipad, existing.id);
  } else {
    db.prepare("INSERT INTO tech_devices (tech_id, device_type, device_name, notes, plan, assigned_at) VALUES (?, 'ipad', ?, '', '', ?)").run(
      techId,
      ipad,
      new Date().toISOString()
    );
  }
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

function getTaskNotificationPrefs(techId) {
  const person = findTechnician(techId);
  if (!person) return null;
  const prefs = {};
  for (const r of TASK_NOTIFICATION_REASONS) prefs[r.key] = Boolean(person[r.key]);
  return { email: person.email || "", prefs };
}

function setTaskNotificationPrefs(techId, prefs) {
  const person = findTechnician(techId);
  if (!person) return null;
  const merged = {};
  for (const r of TASK_NOTIFICATION_REASONS) {
    merged[r.key] = prefs[r.key] !== undefined ? Boolean(prefs[r.key]) : Boolean(person[r.key]);
  }
  db.prepare(
    `UPDATE technicians SET ${TASK_NOTIFICATION_REASONS.map((r) => `${r.key} = ?`).join(", ")} WHERE id = ?`
  ).run(...TASK_NOTIFICATION_REASONS.map((r) => (merged[r.key] ? 1 : 0)), techId);
  return getTaskNotificationPrefs(techId);
}

// A fixed checklist for now rather than an admin-editable template — the
// simplest version that's still a real, working checklist per technician.
// Two sections, matching how onboarding actually breaks down: real setup
// work (accounts, access, equipment) vs. forms/compliance items that need
// to be collected and on file. Each item is just a checkbox here (done or
// not, by whoever's working the checklist) -- the actual document itself,
// once collected, gets uploaded on the Forms on File/Documents tabs; this
// list exists to make sure nothing gets missed along the way, not to store
// the files themselves.
const ONBOARDING_TASKS = [
  // -- Setup & Access --
  { key: "ukg_account", section: "Setup & Access", label: "UKG account created" },
  { key: "email_account", section: "Setup & Access", label: "Email account created" },
  { key: "workday_access", section: "Setup & Access", label: "Workday access set up" },
  { key: "purelyhr_access", section: "Setup & Access", label: "PurelyHR access set up" },
  { key: "microsoft_authenticator", section: "Setup & Access", label: "Microsoft Authenticator set up" },
  { key: "maximo_promethius_access", section: "Setup & Access", label: "Maximo & Promethius access" },
  { key: "concur_access", section: "Setup & Access", label: "Concur access (travel & expense)" },
  { key: "vector_access", section: "Setup & Access", label: "Vector access" },
  { key: "pcard_travel_card", section: "Setup & Access", label: "PCard & Travel Card issued" },
  { key: "direct_deposit", section: "Setup & Access", label: "Direct deposit set up" },
  { key: "badge_issued", section: "Setup & Access", label: "Badge issued" },
  { key: "toyota_laptop", section: "Setup & Access", label: "Toyota laptop issued" },
  { key: "uniform_issued", section: "Setup & Access", label: "Uniform issued" },
  { key: "vehicle_assigned", section: "Setup & Access", label: "Vehicle assigned" },
  { key: "vehicle_inspection", section: "Setup & Access", label: "Company vehicle inspection completed" },
  // -- Forms on File --
  { key: "offer_letter", section: "Forms on File", label: "Offer letter / rate on file" },
  { key: "background_check", section: "Forms on File", label: "Background check completed" },
  { key: "i9_completed", section: "Forms on File", label: "I-9 completed" },
  { key: "w4_form", section: "Forms on File", label: "W-4 form on file" },
  { key: "rfm_docs", section: "Forms on File", label: "RFM docs collected" },
  { key: "emergency_contact_form", section: "Forms on File", label: "Emergency contact form on file" },
  { key: "cardinal_safety_pledge", section: "Forms on File", label: "Cardinal Safety Pledge signed" },
  { key: "cardinal_safety_rules", section: "Forms on File", label: "Cardinal Safety Rules acknowledged" },
  { key: "hep_b_consent", section: "Forms on File", label: "Hep B consent or waiver on file" },
  { key: "safety_training", section: "Forms on File", label: "Safety training completed" },
  { key: "osha_training", section: "Forms on File", label: "OSHA training completed" },
  { key: "active_shooter_training", section: "Forms on File", label: "Active shooter training completed" },
  { key: "employee_responsibilities", section: "Forms on File", label: "Employee responsibilities form signed" },
  { key: "cell_phone_policy", section: "Forms on File", label: "Cell phone policy signed" },
  { key: "employee_handbook", section: "Forms on File", label: "Employee handbook acknowledged" },
  { key: "pto_sick_policy", section: "Forms on File", label: "PTO/Sick time policy reviewed (Toyota workers)" },
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
      "SELECT id, device_type AS deviceType, device_name AS deviceName, notes, plan, upgrade_date AS upgradeDate, assigned_at AS assignedAt FROM tech_devices WHERE tech_id = ? ORDER BY id DESC"
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

function setDeviceUpgradeDate(techId, id, upgradeDate) {
  db.prepare("UPDATE tech_devices SET upgrade_date = ? WHERE id = ? AND tech_id = ?").run(upgradeDate || null, id, techId);
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

// ---- Technician remarks (RFM/manager notes) ----

function listTechRemarks(techId) {
  return db
    .prepare(
      `SELECT id, author_id AS authorId, author_name AS authorName, body, created_at AS createdAt
       FROM tech_remarks WHERE tech_id = ? ORDER BY id DESC`
    )
    .all(techId);
}

function addTechRemark(techId, authorId, authorName, body) {
  db.prepare(
    "INSERT INTO tech_remarks (tech_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(techId, authorId, authorName, body, new Date().toISOString());
  return listTechRemarks(techId);
}

function deleteTechRemark(techId, id) {
  db.prepare("DELETE FROM tech_remarks WHERE id = ? AND tech_id = ?").run(id, techId);
  return listTechRemarks(techId);
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

// Every open (not completed/cancelled) task tied to this vendor, regardless
// of category or who it's assigned to -- the Vendor Directory's at-a-glance
// "N open tasks" count.
function countOpenVendorTasks(vendorId) {
  const { total } = db
    .prepare(
      `SELECT COUNT(*) as total FROM tasks WHERE related_vendor_id = ? AND status IN ('open', 'in_progress', 'waiting')`
    )
    .get(vendorId);
  return total;
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
    deniedReasonCategory: v.denied_reason_category || "",
    preferred: Boolean(v.preferred),
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    openTaskCount: countOpenVendorTasks(v.id),
    expiredComplianceCategories: listExpiredVendorComplianceCategories(v.id),
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

// Real territories this vendor has actually been used in, derived from its
// own PO/WOM history rather than a manual note -- a PO's own `region` is
// already resolved from its E&F Contract Job # at import time, and a WOM's
// territory comes from its location's own `territory` field. Distinct from
// the existing "Coverage outside Midwest"/"Midwest sites seen" fields,
// which are free-text notes entered at onboarding, not computed from data.
// A vendor's own two numbers side by side on their profile: how much is
// still open against them on the Budget PO Tracker (every Active PO's
// amount minus whatever's already matched to it in the GL -- same
// never-double-count remaining calculation Spend Analysis's own "current
// estimated PO" checkbox uses, see getPoRemainingAmounts) vs. how much has
// actually posted to the GL against their POs so far. GL-applied counts
// every PO ever matched to this vendor regardless of lifecycle_status --
// a real historical posting doesn't stop being real just because the PO
// record itself was never fully organized -- while PO-open only makes
// sense for an Active PO with a real dollar amount on file, the same scope
// getPoRemainingAmounts already uses.
function getVendorPoGlRollup(vendorId) {
  const rows = db
    .prepare(
      `SELECT p.po_amount, p.lifecycle_status,
         COALESCE((SELECT SUM(g.amount) FROM gl_entries g WHERE g.matched_po_id = p.id), 0) AS matchedTotal
       FROM pos p WHERE p.vendor_id = ?`
    )
    .all(vendorId);

  let poOpenTotal = 0;
  let poOpenCount = 0;
  let glAppliedTotal = 0;
  let glAppliedPoCount = 0;
  for (const r of rows) {
    if (r.matchedTotal > 0) {
      glAppliedTotal += r.matchedTotal;
      glAppliedPoCount++;
    }
    if (r.lifecycle_status === "active" && r.po_amount != null) {
      const remaining = r.po_amount - r.matchedTotal;
      if (remaining > 0) {
        poOpenTotal += remaining;
        poOpenCount++;
      }
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  return { poOpenTotal: round(poOpenTotal), poOpenCount, glAppliedTotal: round(glAppliedTotal), glAppliedPoCount };
}

function getVendorTerritories(vendorId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT region AS territory FROM pos WHERE vendor_id = ? AND region IS NOT NULL AND region != ''
       UNION
       SELECT DISTINCT l.territory AS territory FROM woms w JOIN locations l ON l.code = w.location_code
         WHERE w.vendor_id = ? AND l.territory IS NOT NULL AND l.territory != ''`
    )
    .all(vendorId, vendorId);
  return rows.map((r) => r.territory).filter(Boolean).sort();
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
  const newVendorId = Number(result.lastInsertRowid);

  // A new vendor profile with a JDE # that already shows up, unmatched, on
  // some PO record (the exact "flagged in Vendors" case -- see
  // listUnregisteredPoVendors) should link up immediately, not wait for a
  // future PO re-import -- same "Vendor Number column match only" rule as
  // import-time matching, just triggered from the other direction. Reuses
  // confirmPoVendor so this also benefits from its own auto-activate check.
  if (fields.jdeVendorNumber) {
    const trimmed = String(fields.jdeVendorNumber).trim();
    if (trimmed) {
      const unmatchedPos = db.prepare("SELECT id FROM pos WHERE vendor_id IS NULL AND vendor_number = ?").all(trimmed);
      for (const po of unmatchedPos) confirmPoVendor(po.id, newVendorId);
    }
  }

  return findVendor(newVendorId);
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

// Blocked if a WOM or PO record actually points at this vendor -- that's
// real work/money history, same reasoning as deleteLocation, and silently
// deleting the vendor out from under it would leave a dangling vendor_id
// with no profile behind it (a vendor name/cost showing up with nothing to
// click into). A vendor's own case log, tasks, and uploaded documents don't
// mean anything once the vendor itself is gone, so those cascade with it
// (see deleteTask for the same "takes its own files/comments with it"
// reasoning, applied one level up here).
function deleteVendor(id) {
  const vendor = findVendor(id);
  if (!vendor) return { error: "not_found" };
  const womCount = db.prepare("SELECT COUNT(*) AS n FROM woms WHERE vendor_id = ?").get(Number(id)).n;
  const poCount = db.prepare("SELECT COUNT(*) AS n FROM pos WHERE vendor_id = ?").get(Number(id)).n;
  if (womCount > 0 || poCount > 0) {
    return { error: "in_use", womCount, poCount };
  }
  const taskIds = db.prepare("SELECT id FROM tasks WHERE related_vendor_id = ?").all(Number(id)).map((r) => r.id);
  for (const taskId of taskIds) deleteTask(taskId);
  db.prepare("DELETE FROM vendor_requests WHERE vendor_id = ?").run(Number(id));
  db.prepare("DELETE FROM vendor_remarks WHERE vendor_id = ?").run(Number(id));
  db.prepare("DELETE FROM files WHERE related_type = 'vendor' AND related_id = ?").run(String(id));
  db.prepare("DELETE FROM vendors WHERE id = ?").run(Number(id));
  return { ok: true, vendor };
}

function setVendorPreferred(id, preferred) {
  db.prepare("UPDATE vendors SET preferred = ?, updated_at = ? WHERE id = ?").run(
    preferred ? 1 : 0,
    new Date().toISOString(),
    Number(id)
  );
  return findVendor(id);
}

function addVendorRemark(vendorId, authorId, authorName, body) {
  db.prepare("INSERT INTO vendor_remarks (vendor_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    Number(vendorId),
    authorId,
    authorName,
    body,
    new Date().toISOString()
  );
  return listVendorRemarks(vendorId);
}

function listVendorRemarks(vendorId) {
  return db.prepare("SELECT * FROM vendor_remarks WHERE vendor_id = ? ORDER BY id DESC").all(Number(vendorId));
}

// ---- Financials: contracted-services cost review (Repeated Costs Above
// Quote) ----
// An admin's recorded reason for a WOM whose applied contracted-services
// cost came in above its own quote -- never changes the quote/applied
// figures themselves, just tracks whether someone's looked at the
// difference and why.
const WOM_COST_REVIEW_STATUSES = ["needs_review", "reviewed"];
const WOM_COST_REVIEW_REASONS = ["scope_change", "entry_error", "coding_issue", "unexplained"];

function presentWomCostReview(row) {
  if (!row) return { reviewStatus: "needs_review", reviewReason: null, note: "", reviewedBy: null, reviewedAt: null };
  return {
    reviewStatus: row.review_status,
    reviewReason: row.review_reason,
    note: row.note || "",
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  };
}

// Bulk map for building the cost summary -- one query instead of one per WOM.
function getWomCostReviewMap() {
  const rows = db.prepare("SELECT * FROM wom_cost_reviews").all();
  return new Map(rows.map((r) => [r.wom_code, r]));
}

function setWomCostReview(code, { reviewStatus, reviewReason, note }, actorId) {
  if (!findWom(code)) return null;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO wom_cost_reviews (wom_code, review_status, review_reason, note, reviewed_by, reviewed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wom_code) DO UPDATE SET
       review_status = excluded.review_status,
       review_reason = excluded.review_reason,
       note = excluded.note,
       reviewed_by = excluded.reviewed_by,
       reviewed_at = excluded.reviewed_at,
       updated_at = excluded.updated_at`
  ).run(code, reviewStatus, reviewReason || null, note || "", actorId, now, now);
  return presentWomCostReview(db.prepare("SELECT * FROM wom_cost_reviews WHERE wom_code = ?").get(code));
}

// ---- GL Reclasses ----

// "dismissed" is the unflag: a reclass someone looked at and decided
// doesn't actually need one, after all. Keeps the row (and its audit trail)
// rather than deleting it -- see attachOpenReclassFlags/flagPosForReclass,
// both of which already treat it the same as confirmed_posted for "is this
// still an open flag" purposes.
const RECLASS_STATUSES = ["flagged", "reviewed", "draft", "submitted", "confirmed_posted", "dismissed"];
const RECLASS_STATUS_LABELS = {
  flagged: "Flagged",
  reviewed: "Reviewed",
  draft: "Draft",
  submitted: "Submitted",
  confirmed_posted: "Confirmed Posted",
  dismissed: "Dismissed (not needed)",
};
// Matches the real sheet's own category vocabulary exactly (see
// parseReclassWorkbook in routes/reclasses.js) rather than inventing a
// different one.
const RECLASS_CAUSED_BY_OPTIONS = ["PSG", "UGL West", "UGL East", "SBU", "SSG", "Other", "Customer"];
const RECLASS_ROOT_CAUSE_OPTIONS = ["Process Failure", "Manual Mistake", "System Mistake", "Management Change", "Customer Change"];

function presentReclassItem(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    lineNumber: r.line_number,
    fromJobNumber: r.from_job_number,
    fromObjectCode: r.from_object_code,
    fromSubsidiary: r.from_subsidiary,
    fromWomNumber: r.from_wom_number,
    fromAmount: r.from_amount,
    toJobNumber: r.to_job_number,
    toObjectCode: r.to_object_code,
    toSubsidiary: r.to_subsidiary,
    toWomNumber: r.to_wom_number,
    toAmount: r.to_amount,
    vendor: r.vendor,
    comments: r.comments,
    region: r.region,
    costCenterAdjusted: Boolean(r.cost_center_adjusted),
    subledgerAdjusted: Boolean(r.subledger_adjusted),
    objectCodeAdjusted: Boolean(r.object_code_adjusted),
    womAdjusted: Boolean(r.wom_adjusted),
    impactsFinalInvoice: r.impacts_final_invoice,
    causedBy: r.caused_by,
    rootCause: r.root_cause,
    pathForward: r.path_forward,
    source: r.source,
    status: r.status,
    confirmedGlReference: r.confirmed_gl_reference,
    relatedPoId: r.related_po_id,
    adminName: r.admin_name,
    fiscalPeriodNumber: r.fiscal_period_number,
    fiscalYear: r.fiscal_year,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
  };
}

function presentReclassBatch(b) {
  return {
    id: b.id,
    region: b.region,
    reasonForChange: b.reason_for_change,
    revisionNo: b.revision_no,
    revisionDate: b.revision_date,
    originalDatePublished: b.original_date_published,
    producedBy: b.produced_by,
    totalGlLineItems: b.total_gl_line_items,
    reportedTotalAmount: b.reported_total_amount,
    sourceFileName: b.source_file_name,
    importedBy: b.imported_by,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

// Imports a parsed reclass submission -- rows already extracted by
// parseReclassWorkbook in routes/reclasses.js, this function just owns the
// DB side. Items land as source='imported', status='submitted' (the file
// itself IS a real historical submission, not a new finding being flagged),
// so the only thing left for Krista to do is mark one 'confirmed_posted'
// once a later GL import shows the correction actually landed.
function importReclassBatch(metadata, items, importedBy, sourceFileName) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO reclass_batches (
        region, reason_for_change, revision_no, revision_date, original_date_published,
        produced_by, total_gl_line_items, reported_total_amount, source_file_name, imported_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      metadata.region || null,
      metadata.reasonForChange || null,
      metadata.revisionNo || null,
      metadata.revisionDate || null,
      metadata.originalDatePublished || null,
      metadata.producedBy || null,
      metadata.totalGlLineItems || null,
      metadata.totalAmount || null,
      sourceFileName || null,
      importedBy || null,
      now,
      now
    );
  const batchId = Number(result.lastInsertRowid);
  // Same fiscal period for every line in this one import -- the sheet
  // itself was submitted/published as a single batch, not line by line.
  const fiscalPeriod = resolveFiscalPeriod(now.slice(0, 10));

  const insertItem = db.prepare(
    `INSERT INTO reclass_items (
      batch_id, line_number, from_job_number, from_object_code, from_subsidiary, from_wom_number, from_amount,
      to_job_number, to_object_code, to_subsidiary, to_wom_number, to_amount,
      vendor, comments, region, cost_center_adjusted, subledger_adjusted, object_code_adjusted, wom_adjusted,
      impacts_final_invoice, caused_by, root_cause, path_forward, source, status, fiscal_period_number, fiscal_year,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', 'submitted', ?, ?, ?, ?, ?)`
  );
  for (const item of items) {
    insertItem.run(
      batchId,
      item.lineNumber || null,
      item.fromJobNumber || null,
      item.fromObjectCode || null,
      item.fromSubsidiary || null,
      item.fromWomNumber || null,
      item.fromAmount == null ? null : item.fromAmount,
      item.toJobNumber || null,
      item.toObjectCode || null,
      item.toSubsidiary || null,
      item.toWomNumber || null,
      item.toAmount == null ? null : item.toAmount,
      item.vendor || null,
      item.comments || null,
      item.region || null,
      item.costCenterAdjusted ? 1 : 0,
      item.subledgerAdjusted ? 1 : 0,
      item.objectCodeAdjusted ? 1 : 0,
      item.womAdjusted ? 1 : 0,
      item.impactsFinalInvoice || null,
      item.causedBy || null,
      item.rootCause || null,
      item.pathForward || null,
      fiscalPeriod ? fiscalPeriod.periodNumber : null,
      fiscalPeriod ? fiscalPeriod.fiscalYear : null,
      importedBy || null,
      now,
      now
    );
  }

  return findReclassBatch(batchId);
}

function listReclassBatches() {
  const batches = db.prepare("SELECT * FROM reclass_batches ORDER BY id DESC").all();
  return batches.map((b) => {
    const counts = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ABS(from_amount)), 0) AS total FROM reclass_items WHERE batch_id = ?")
      .get(b.id);
    return { ...presentReclassBatch(b), itemCount: counts.n, itemTotal: counts.total };
  });
}

function findReclassBatch(id) {
  const batch = db.prepare("SELECT * FROM reclass_batches WHERE id = ?").get(Number(id));
  if (!batch) return null;
  const items = db.prepare("SELECT * FROM reclass_items WHERE batch_id = ? ORDER BY line_number, id").all(Number(id));
  return { ...presentReclassBatch(batch), items: items.map(presentReclassItem) };
}

// Every reclass item regardless of batch -- the main Reclasses tab's own
// list, filterable by status/source/region so a repeated-error pattern (a
// region or coding combo that keeps needing a reclass) is easy to spot.
// Shared by listReclassItems and getReclassSummary -- the summary needs to
// total up exactly the same slice the list is showing (e.g. "Midwest, Period
// 2/FY26"), not a separately-filtered figure that could drift from what's
// actually on screen.
function buildReclassItemFilterClauses(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.source) {
    clauses.push("source = ?");
    params.push(filters.source);
  }
  if (filters.region) {
    clauses.push("region = ?");
    params.push(filters.region);
  }
  // Fiscal period this finding was flagged/imported in -- not a GL
  // transaction date (a reclass item has none of its own), and not a plain
  // calendar month either, since fiscal periods don't line up with calendar
  // month boundaries (see resolveFiscalPeriod). Both parts required: a bare
  // period number alone is ambiguous across fiscal years.
  if (filters.fiscalPeriodNumber != null && filters.fiscalYear != null) {
    clauses.push("fiscal_period_number = ? AND fiscal_year = ?");
    params.push(Number(filters.fiscalPeriodNumber), Number(filters.fiscalYear));
  }
  // Matches either side of the reclass -- a WOM can be the one losing the
  // cost or the one picking it up, and the WOM Projects detail view needs
  // to surface a reclass either way.
  if (filters.womNumber) {
    clauses.push("(from_wom_number = ? OR to_wom_number = ?)");
    params.push(filters.womNumber, filters.womNumber);
  }
  // Reclasses tab search box: look up by WOM # directly, or by a real PO #
  // (resolved to that PO's own WOM # via the Budget PO Tracker) -- lets an
  // admin search "did PO 10049941's reclass go through" without first
  // having to know which WOM that PO is tied to.
  if (filters.search) {
    const term = String(filters.search).trim();
    if (term) {
      const womCandidates = new Set([term]);
      const poRow = db.prepare("SELECT wom_number FROM pos WHERE po_number = ?").get(term);
      if (poRow && poRow.wom_number) womCandidates.add(poRow.wom_number);
      const orClauses = [];
      for (const w of womCandidates) {
        orClauses.push("(from_wom_number = ? OR to_wom_number = ?)");
        params.push(w, w);
      }
      clauses.push(`(${orClauses.join(" OR ")})`);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function listReclassItems(filters = {}) {
  const { where, params } = buildReclassItemFilterClauses(filters);
  return db
    .prepare(`SELECT * FROM reclass_items ${where} ORDER BY id DESC`)
    .all(...params)
    .map(presentReclassItem);
}

// Total reclassed $ and item count for whatever slice of the list is
// currently showing (e.g. Midwest, a given fiscal period) -- the amount
// summed is each item's own from_amount (the dollar figure moving off the
// miscoded line), same convention listReclassBatches already uses for a
// batch's own itemTotal.
function getReclassSummary(filters = {}) {
  const { where, params } = buildReclassItemFilterClauses(filters);
  const row = db.prepare(`SELECT COUNT(*) AS itemCount, COALESCE(SUM(ABS(from_amount)), 0) AS totalAmount FROM reclass_items ${where}`).get(...params);
  return { itemCount: row.itemCount, totalAmount: row.totalAmount };
}

function findReclassItem(id) {
  const row = db.prepare("SELECT * FROM reclass_items WHERE id = ?").get(Number(id));
  return row ? presentReclassItem(row) : null;
}

// Who to loop in for a reclass finding -- the Budget PO Tracker's own Admin
// column for whichever PO this item traces back to, resolved the same way
// regardless of which of the three flag entry points created the item (PO
// Tracker directly via relatedPoId, or a WOM # on either side matched
// against the tracker's own wom_number field). An explicit fields.adminName
// (none of the current call sites pass one, but kept for completeness)
// always wins over this lookup.
function resolveAdminNameForReclassFields(fields) {
  if (fields.relatedPoId) {
    const po = db.prepare("SELECT admin_name FROM pos WHERE id = ?").get(fields.relatedPoId);
    if (po && po.admin_name) return po.admin_name;
  }
  const womCode = fields.toWomNumber || fields.fromWomNumber;
  if (womCode) {
    const po = db.prepare("SELECT admin_name FROM pos WHERE wom_number = ? LIMIT 1").get(womCode);
    if (po && po.admin_name) return po.admin_name;
  }
  return null;
}

// Same resolution approach as resolveAdminNameForReclassFields, for region
// instead -- lets the Reclasses tab's location filter (and the Midwest
// total) actually include a manually-flagged item, not just ones imported
// from the real submission sheet's own Region column (which already carries
// its own region verbatim and never needs this). pos.region is already the
// real territory resolved at PO-import time from the E&F Contract Job #; a
// WOM with no matching PO on file still has its own location_code to fall
// back to.
function resolveRegionForReclassFields(fields) {
  if (fields.relatedPoId) {
    const po = db.prepare("SELECT region FROM pos WHERE id = ?").get(fields.relatedPoId);
    if (po && po.region) return po.region;
  }
  const womCode = fields.toWomNumber || fields.fromWomNumber;
  if (womCode) {
    const po = db
      .prepare("SELECT region FROM pos WHERE wom_number = ? AND region IS NOT NULL AND region != '' LIMIT 1")
      .get(womCode);
    if (po && po.region) return po.region;
    const wom = db
      .prepare(
        `SELECT l.territory AS territory FROM woms w JOIN locations l ON l.code = w.location_code
         WHERE w.code = ? AND l.territory IS NOT NULL AND l.territory != ''`
      )
      .get(womCode);
    if (wom && wom.territory) return wom.territory;
  }
  return null;
}

// A finding an admin spots during manual GL/labor review, logged by hand --
// source='manual', starts 'flagged' (nothing's been reviewed/submitted yet).
function addReclassItem(fields, createdBy) {
  const now = new Date().toISOString();
  const adminName = fields.adminName || resolveAdminNameForReclassFields(fields);
  const region = fields.region || resolveRegionForReclassFields(fields);
  // The fiscal period this finding belongs to is when it was actually
  // flagged/noticed, not any date tied to the miscoded GL line itself (a
  // reclass item isn't a GL posting, it's a note that one needs fixing) --
  // matches Krista's own "store it on this list until I print out the
  // reclass report, which is all of them for the month" workflow.
  const fiscalPeriod = resolveFiscalPeriod(now.slice(0, 10));
  const result = db
    .prepare(
      `INSERT INTO reclass_items (
        batch_id, line_number, from_job_number, from_object_code, from_subsidiary, from_wom_number, from_amount,
        to_job_number, to_object_code, to_subsidiary, to_wom_number, to_amount,
        vendor, comments, region, cost_center_adjusted, subledger_adjusted, object_code_adjusted, wom_adjusted,
        impacts_final_invoice, caused_by, root_cause, path_forward, source, status, related_po_id, admin_name,
        fiscal_period_number, fiscal_year, created_by, created_at, updated_at
      ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'flagged', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.fromJobNumber || null,
      fields.fromObjectCode || null,
      fields.fromSubsidiary || null,
      fields.fromWomNumber || null,
      fields.fromAmount == null || fields.fromAmount === "" ? null : Number(fields.fromAmount),
      fields.toJobNumber || null,
      fields.toObjectCode || null,
      fields.toSubsidiary || null,
      fields.toWomNumber || null,
      fields.toAmount == null || fields.toAmount === "" ? null : Number(fields.toAmount),
      fields.vendor || null,
      fields.comments || null,
      region,
      fields.costCenterAdjusted ? 1 : 0,
      fields.subledgerAdjusted ? 1 : 0,
      fields.objectCodeAdjusted ? 1 : 0,
      fields.womAdjusted ? 1 : 0,
      fields.impactsFinalInvoice || null,
      fields.causedBy || null,
      fields.rootCause || null,
      fields.pathForward || null,
      fields.relatedPoId || null,
      adminName,
      fiscalPeriod ? fiscalPeriod.periodNumber : null,
      fiscalPeriod ? fiscalPeriod.fiscalYear : null,
      createdBy || null,
      now,
      now
    );
  return findReclassItem(Number(result.lastInsertRowid));
}

// One-click "I noticed this needs a reclass" from the Budget PO Tracker --
// deliberately lighter than the Flag a Finding form: it logs the PO's own
// known coding as a starting point and leaves the "To" side blank for
// Krista to fill in whenever she actually works her monthly submission.
// These build up as a running list she can pull from (filter the Reclasses
// tab by status "Flagged") rather than something she has to detail right
// away. Flagging the same PO again while an open flag already exists is a
// no-op, so repeat clicks (or flagging the same PO from two different
// filtered views) don't pile up duplicate rows.
function flagPosForReclass(poIds, createdBy) {
  let flaggedCount = 0;
  let skippedCount = 0;
  const items = [];
  for (const poId of poIds) {
    const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(Number(poId));
    if (!po) {
      skippedCount++;
      continue;
    }
    const alreadyFlagged = db
      .prepare("SELECT 1 FROM reclass_items WHERE related_po_id = ? AND status NOT IN ('confirmed_posted', 'dismissed') LIMIT 1")
      .get(po.id);
    if (alreadyFlagged) {
      skippedCount++;
      continue;
    }
    const item = addReclassItem(
      {
        fromJobNumber: po.e1_wom_job_number || po.ef_job_number || null,
        fromObjectCode: po.object_code,
        fromSubsidiary: po.subsidiary,
        fromWomNumber: po.wom_number,
        fromAmount: po.po_amount,
        vendor: po.vendor_name,
        comments: `Flagged for reclass review from PO ${po.po_number || po.id}${po.description ? ` (${po.description})` : ""}.`,
        relatedPoId: po.id,
      },
      createdBy
    );
    items.push(item);
    flaggedCount++;
  }
  return { flaggedCount, skippedCount, items };
}

// The symmetric undo for flagPosForReclass above -- the PO Tracker's own
// "I noticed this needs a reclass" flag and the "Dismissed" status on the
// Reclasses tab are really the same one-click lightweight flag, so
// unflagging from either side has to mean the same thing: dismiss it, not
// delete it, so the attempt (and whoever flagged it, and when) stays in the
// record rather than vanishing.
function unflagPosForReclass(poIds, actorId) {
  let unflaggedCount = 0;
  let skippedCount = 0;
  for (const poId of poIds) {
    const item = db
      .prepare("SELECT * FROM reclass_items WHERE related_po_id = ? AND status NOT IN ('confirmed_posted', 'dismissed') LIMIT 1")
      .get(Number(poId));
    if (!item) {
      skippedCount++;
      continue;
    }
    updateReclassItem(item.id, { status: "dismissed" });
    unflaggedCount++;
  }
  return { unflaggedCount, skippedCount };
}

function updateReclassItem(id, fields) {
  const existing = findReclassItem(id);
  if (!existing) return null;
  if (fields.status && !RECLASS_STATUSES.includes(fields.status)) {
    throw new Error(`status must be one of: ${RECLASS_STATUSES.join(", ")}`);
  }
  const now = new Date().toISOString();
  // Set once, the moment status actually transitions into "submitted" --
  // never touched again on a later edit while it stays submitted (or moves
  // on to confirmed_posted), same spirit as po_generated_at not resetting
  // on a later refresh. This is the Performance tab's reclass-turnaround
  // KPI (created_at to submitted_at).
  const enteringSubmitted = fields.status === "submitted" && existing.status !== "submitted";
  db.prepare(
    `UPDATE reclass_items SET
      comments = ?, path_forward = ?, caused_by = ?, root_cause = ?, impacts_final_invoice = ?,
      status = ?, confirmed_gl_reference = ?, updated_at = ?, submitted_at = ?, submitted_by = ?
     WHERE id = ?`
  ).run(
    fields.comments !== undefined ? fields.comments : existing.comments,
    fields.pathForward !== undefined ? fields.pathForward : existing.pathForward,
    fields.causedBy !== undefined ? fields.causedBy : existing.causedBy,
    fields.rootCause !== undefined ? fields.rootCause : existing.rootCause,
    fields.impactsFinalInvoice !== undefined ? fields.impactsFinalInvoice : existing.impactsFinalInvoice,
    fields.status || existing.status,
    fields.confirmedGlReference !== undefined ? fields.confirmedGlReference : existing.confirmedGlReference,
    now,
    enteringSubmitted ? now : existing.submittedAt,
    enteringSubmitted ? fields.updatedBy || null : existing.submittedBy,
    Number(id)
  );
  const updated = findReclassItem(id);
  // The moment a reclass is actually confirmed posted (someone verified it
  // landed in the GL), whatever got corrected also needs to be reflected in
  // Smartsheet -- that's a separate, manual step this app can't do or
  // verify on its own, so it tasks the PO's own assigned admin (from the
  // Budget PO Tracker's Admin column) to go make that update. Only fires on
  // the transition into confirmed_posted, not on every subsequent edit
  // while it stays there.
  if (fields.status === "confirmed_posted" && existing.status !== "confirmed_posted") {
    createReclassSmartsheetUpdateTask(updated);
  }
  return updated;
}

// Matches the PO Tracker's free-text Admin column against a real admin
// account by name -- exact, case-insensitive, trimmed. Never a fuzzy guess:
// an unmatched name still gets a task, just unassigned with that raw name
// kept in the description so a human routes it instead of this silently
// assigning the wrong person.
function matchAdminByName(name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  return listAdmins().find((a) => String(a.name || "").trim().toLowerCase() === target) || null;
}

// Same name match, but only counts a *currently active* admin account -- a
// terminated admin's old home location isn't authoritative for where a PO
// sits today (they might have moved territories before leaving, or the
// location itself could have been reassigned since). Used by both
// poTerritory and presentPoRow's adminMatched flag, so "does this PO's
// admin name resolve to someone real" means the same thing everywhere.
function activeAdminMatch(name) {
  const admin = matchAdminByName(name);
  return admin && admin.employment_status === "active" ? admin : null;
}

// A PO's territory -- the Budget PO Tracker's own Admin column is a more
// reliable signal than the PO's own location match: every row carries an
// admin name, while the location match can be missing or wrong, and each
// admin's home location is deliberately set to the territory they actually
// serve. Falls back to the PO's own matched location whenever the admin
// name doesn't match a real, active account (or that admin has no home
// location with a territory on file); never guessed when neither resolves
// one.
function poTerritory(p) {
  const admin = activeAdminMatch(p.admin_name);
  if (admin && admin.home_location_code) {
    const loc = findLocation(admin.home_location_code);
    if (loc && loc.territory) return loc.territory;
  }
  if (p.location_code) {
    const loc = findLocation(p.location_code);
    if (loc && loc.territory) return loc.territory;
  }
  return null;
}

// The PO this reclass item traces back to, whichever way it's known: a
// direct link (flagged from the PO Tracker -- see flagPosForReclass), or
// failing that, a WOM # match against the Budget PO Tracker's own
// wom_number field (same linkage getPoGlLinksByWom uses), since most
// reclass items come from an imported submission with a WOM # but no
// direct PO link at all.
function resolvePoForReclassItem(item) {
  if (item.relatedPoId) {
    const byId = db.prepare("SELECT * FROM pos WHERE id = ?").get(item.relatedPoId);
    if (byId) return byId;
  }
  const womCode = item.toWomNumber || item.fromWomNumber;
  if (!womCode) return null;
  return db.prepare("SELECT * FROM pos WHERE wom_number = ? LIMIT 1").get(womCode);
}

function createReclassSmartsheetUpdateTask(item) {
  const po = resolvePoForReclassItem(item);
  const matchedAdmin = po ? matchAdminByName(po.admin_name) : null;
  const subject = po ? `PO ${po.po_number || po.id}` : item.toWomNumber || item.fromWomNumber ? `WOM ${item.toWomNumber || item.fromWomNumber}` : `reclass #${item.id}`;
  const description =
    `This reclass (${item.comments || "no comment"}) was just marked Confirmed Posted -- update Smartsheet to reflect the correction.` +
    (po && po.admin_name && !matchedAdmin
      ? ` The Budget PO Tracker lists "${po.admin_name}" as this PO's admin, but that name doesn't match any admin account -- route this manually.`
      : "");
  upsertTaskBySourceKey(
    `RECLASS-${item.id}-SMARTSHEET-UPDATE`,
    {
      title: `Update Smartsheet for ${subject}'s reclass`,
      description,
      category: "reclass_smartsheet",
      assignedTo: matchedAdmin ? matchedAdmin.id : null,
      assignedRole: matchedAdmin ? "admin" : null,
      relatedPoId: po ? po.id : null,
      priority: "normal",
      source: "reclass_smartsheet",
      sourceRecordId: String(item.id),
      workflowRule: "reclass_smartsheet",
    },
    { reopenIfClosed: false }
  );
}

// Reasons an admin can deny a vendor outright, independent of any one
// document case -- "unacceptable_service" and "cost" in particular reflect
// a business decision ServiceEdge's own case types don't capture at all.
const VENDOR_DENIAL_REASONS = [
  { key: "insurance", label: "Insurance" },
  { key: "document_chasing", label: "Document chasing" },
  { key: "unacceptable_service", label: "Unacceptable work or service" },
  { key: "cost", label: "Cost" },
  { key: "other", label: "Other" },
];
const VENDOR_DENIAL_REASON_KEYS = VENDOR_DENIAL_REASONS.map((r) => r.key);

// Explicit, admin-driven denial -- sticks (see deriveOnboardingStage) until
// reinstateVendor clears it. Reason/category are shown on the Onboarding
// board's Denied list next to the vendor's case history.
function denyVendor(vendorId, { category, reason } = {}) {
  const cat = VENDOR_DENIAL_REASON_KEYS.includes(category) ? category : "other";
  db.prepare(
    "UPDATE vendors SET onboarding_stage = 'denied', denied_reason_category = ?, denied_reason = ?, updated_at = ? WHERE id = ?"
  ).run(cat, (reason || "").trim(), new Date().toISOString(), Number(vendorId));
  return findVendor(vendorId);
}

// Clears a manual denial and lets onboarding stage resume being derived
// from actual case history (see deriveOnboardingStage) -- may land back on
// in_progress, onboarded, or even denied again if a case is itself denied.
function reinstateVendor(vendorId) {
  db.prepare(
    "UPDATE vendors SET denied_reason_category = '', denied_reason = '', updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), Number(vendorId));
  syncOnboardingStage(vendorId);
  return findVendor(vendorId);
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
  // An explicit manual denial (see denyVendor) always wins -- it's a
  // standing business decision, not a document-case outcome, so no amount
  // of case activity below should silently clear it.
  const manualDenial = db.prepare("SELECT denied_reason_category FROM vendors WHERE id = ?").get(vendorId);
  if (manualDenial && manualDenial.denied_reason_category) return "denied";
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

function updateVendorRequest(vendorId, requestId, { requestType, referenceNumber, status, note, asOf, updatedBy }) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE vendor_requests SET request_type = ?, reference_number = ?, status = ?, note = ?, as_of = ?, updated_at = ?, updated_by = ? WHERE id = ? AND vendor_id = ?"
  ).run(requestType, referenceNumber || "", status || "", note || "", asOf || now.slice(0, 10), now, updatedBy || null, requestId, vendorId);
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

// An admin's own "territory," for gating Financials -- there's no
// dedicated column for it; it's whatever territory their own home
// location (already shown in the Admin Accounts table's "Territory"
// column, see technicianProfile.js) is tagged with. null means no home
// location is set (or it's not registered), which callers should treat as
// "don't know, allow" rather than a hard block -- otherwise every admin
// locks themselves out the moment this check ships, before anyone's had a
// chance to actually assign home locations.
function getAdminTerritory(admin) {
  if (!admin || !admin.home_location_code) return null;
  const loc = findLocation(admin.home_location_code);
  return loc ? loc.territory : null;
}

// territory has no safe default -- silently falling back to "Midwest" here
// is exactly what mistagged a corporate/overhead code (no real territory of
// its own) as Midwest in the past. Every caller must say which territory a
// new location actually belongs to.
function createLocation(code, name, efJobNumber, region, womJobNumber, territory, ppsJobNumber) {
  if (!territory) throw new Error("Territory is required to create a location");
  db.prepare(
    "INSERT INTO locations (code, name, ef_job_number, region, wom_job_number, territory, pps_job_number) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(code, name, efJobNumber || null, region || null, womJobNumber || null, territory, ppsJobNumber || null);
  return findLocation(code);
}

function matchLocationByName(name) {
  const target = String(name == null ? "" : name).trim().toLowerCase();
  if (!target) return null;
  return db.prepare("SELECT * FROM locations WHERE LOWER(TRIM(name)) = ?").get(target) || null;
}

function slugifyLocationCode(name) {
  const slug = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "LOCATION";
}

// Backfills a location's E&F Contract Job Number, WOM Job Number, PPS
// Contract Job Number, and region from Toyota's own Chart of Accounts (the
// "Job Numbers" sheet) -- matched by name against this app's existing
// locations. Most rows on that sheet are category headers with no job
// numbers at all (e.g. "GENERAL MGT & ADMIN"); those are filtered out
// before this ever runs (see parseCoaWorkbook). A real site with no
// matching location on file is only CREATED when createUnmatched is set --
// otherwise it's just listed, the same "nothing here is guessed" posture as
// the PO Tracker import. The COA is the single most authoritative source
// for these fields, so a commit overwrites whatever's on file today; dryRun
// (the default call shape) only ever previews the diff.
function runLocationCoaImport(rows, { commit, createUnmatched } = {}) {
  const results = [];
  let matchedCount = 0;
  let changedCount = 0;
  let unmatchedCount = 0;
  let createdCount = 0;
  // Codes already handed out during this run (committed or just previewed)
  // so two same-named unmatched rows in one file don't collide on the same
  // suggested code before either has actually been written.
  const reservedCodes = new Set();
  function uniqueLocationCode(base) {
    let code = base;
    let n = 2;
    while (findLocation(code) || reservedCodes.has(code)) {
      code = `${base}-${n}`;
      n++;
    }
    reservedCodes.add(code);
    return code;
  }

  for (const row of rows) {
    const location = matchLocationByName(row.description);
    if (!location) {
      unmatchedCount++;
      if (createUnmatched) {
        const suggestedCode = uniqueLocationCode(slugifyLocationCode(row.description));
        if (commit) {
          createLocation(suggestedCode, row.description, row.efJobNumber, row.region, row.womJobNumber, row.territory || "Midwest", row.ppsJobNumber);
        }
        createdCount++;
        results.push({ description: row.description, matched: false, willCreate: true, locationCode: suggestedCode, territory: row.territory || "Midwest" });
      } else {
        results.push({ description: row.description, matched: false, willCreate: false });
      }
      continue;
    }
    matchedCount++;
    const nextEf = row.efJobNumber || location.ef_job_number;
    const nextWom = row.womJobNumber || location.wom_job_number;
    const nextPps = row.ppsJobNumber || location.pps_job_number;
    const nextRegion = row.region || location.region;
    // row.territory only comes from a section header the sheet parser
    // recognized (see parseCoaWorkbook) -- a row with none leaves whatever
    // territory the location already has alone, same "don't guess" rule as
    // the unmatched-row create path.
    const nextTerritory = row.territory || location.territory;
    const changed =
      nextEf !== location.ef_job_number ||
      nextWom !== location.wom_job_number ||
      nextPps !== location.pps_job_number ||
      nextRegion !== location.region ||
      nextTerritory !== location.territory;
    if (changed) {
      changedCount++;
      if (commit) {
        db.prepare("UPDATE locations SET ef_job_number = ?, wom_job_number = ?, pps_job_number = ?, region = ?, territory = ? WHERE code = ?").run(
          nextEf || null,
          nextWom || null,
          nextPps || null,
          nextRegion || null,
          nextTerritory || "Midwest",
          location.code
        );
      }
    }
    results.push({
      description: row.description,
      matched: true,
      locationCode: location.code,
      locationName: location.name,
      changed,
      efJobNumber: { before: location.ef_job_number, after: nextEf },
      womJobNumber: { before: location.wom_job_number, after: nextWom },
      ppsJobNumber: { before: location.pps_job_number, after: nextPps },
      region: { before: location.region, after: nextRegion },
      territory: { before: location.territory, after: nextTerritory },
    });
  }

  return { results, totalRows: rows.length, matchedCount, changedCount, unmatchedCount, createdCount };
}

function setLocationDetails(code, { name, efJobNumber, region, womJobNumber, territory, ppsJobNumber } = {}) {
  if (!findLocation(code)) return null;
  db.prepare(
    "UPDATE locations SET name = ?, ef_job_number = ?, region = ?, wom_job_number = ?, territory = ?, pps_job_number = ? WHERE code = ?"
  ).run(name, efJobNumber || null, region || null, womJobNumber || null, territory || "Midwest", ppsJobNumber || null, code);
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

// Whether an actual invoice file is attached here -- the one requirement
// sync alone can never satisfy, since it only ever reads Smartsheet
// data, never files. See server/routes/files.js's "invoice" category.
function hasWomInvoiceDocument(code) {
  return Boolean(db.prepare("SELECT 1 FROM files WHERE related_type = 'wom' AND related_id = ? AND category = 'invoice' LIMIT 1").get(code));
}

// WOMs whose work is done (per Smartsheet) but aren't fully invoiced yet in
// this app's own bookkeeping -- a real invoice #, a real batch #, AND the
// actual invoice document attached (not just the reference numbers).
// Invoice #/batch # arrive on their own via sync (see
// applyWomSourceEvidence); the document never does, which is the one gap
// this queue exists to surface. Never includes a cancelled or already-
// closed WOM -- a closed WOM's invoicing is done by definition, and
// applying this (new) document requirement retroactively to historical
// closed WOMs would flood the queue with nothing actionable.
function listWomsNeedingInvoicing() {
  return db
    .prepare(
      `SELECT w.* FROM woms w
       WHERE w.source_work_completed = 1
       AND w.status NOT IN ('cancelled', 'closed')
       AND NOT (
         w.invoice_number IS NOT NULL AND w.invoice_number != ''
         AND w.batch_number IS NOT NULL AND w.batch_number != ''
         AND EXISTS (SELECT 1 FROM files f WHERE f.related_type = 'wom' AND f.related_id = w.code AND f.category = 'invoice')
       )
       ORDER BY w.code`
    )
    .all()
    .map(womWithRemaining);
}

function womInvoicingTaskSourceKey(code) {
  return `WOM-${code}-INVOICING`;
}

// A WOM that's ready to invoice (see listWomsNeedingInvoicing just above)
// gets a task with a 24h SLA due date the moment it first qualifies --
// due_at is preserved on every later lazy refresh (same
// preserveDueAtOnUpdate convention as the PO-discrepancy tasks), so it
// reads as overdue once that window passes rather than resetting every
// time anyone loads the task list.
//
// Closes once status is already "invoiced" -- a real-world "this is done"
// signal that arrives automatically the moment an invoice # shows up via
// sync (see applyWomSourceEvidence), independent of the stricter 3-part
// check (invoice #, batch #, AND the uploaded document) the Invoicing
// queue itself still uses for its own documentation-completeness purpose.
// Confirmed directly: a real backlog of WOMs already marked invoiced but
// missing just the batch # or the document was flooding the task list with
// "done" work -- the queue tab is the right place to keep tracking that
// paperwork gap; the task shouldn't nag about something already closed out.
//
// That grandfathering only covers the existing backlog, though -- a WOM
// *requested* on/after WOM_INVOICING_STRICT_CUTOFF keeps its task open
// until the full checklist (invoice #, batch #, document) is actually
// complete, even past the point status flips to "invoiced," since the
// backlog's missing paperwork has no process behind it to chase but new
// requests do. A WOM with no Date Requested on file at all is treated the
// same as "before the cutoff."
const WOM_INVOICING_SLA_MS = 24 * 60 * 60 * 1000;
const WOM_INVOICING_STRICT_CUTOFF = new Date("2026-10-05");

function refreshAllWomInvoicingTasks() {
  const woms = listWomsNeedingInvoicing().filter((w) => {
    if (w.status !== "invoiced") return true;
    const requested = w.date_requested ? new Date(w.date_requested) : null;
    return Boolean(requested) && !isNaN(requested) && requested >= WOM_INVOICING_STRICT_CUTOFF;
  });
  const stillOpen = new Set(woms.map((w) => w.code));

  for (const w of woms) {
    const missing = [];
    if (!w.invoice_number) missing.push("Invoice #");
    if (!w.batch_number) missing.push("Batch #");
    if (!hasWomInvoiceDocument(w.code)) missing.push("Invoice document");
    upsertTaskBySourceKey(
      womInvoicingTaskSourceKey(w.code),
      {
        title: `Invoice WOM ${w.code}`,
        description: `Work is complete but this WOM isn't fully invoiced yet -- missing ${missing.join(", ")}.`,
        category: "wom_invoicing",
        assignedRole: "financial",
        relatedWomCode: w.code,
        relatedLocationCode: w.location_code,
        priority: "high",
        source: "wom_invoicing",
        sourceRecordId: w.code,
        workflowRule: "wom_invoicing",
        dueAt: new Date(Date.now() + WOM_INVOICING_SLA_MS).toISOString(),
      },
      { preserveDueAtOnUpdate: true }
    );
  }

  // A WOM that was in the queue last time this ran but isn't anymore (got
  // fully invoiced, or got cancelled/closed) -- clear its task rather than
  // leaving it open forever.
  const openTasks = db
    .prepare("SELECT source_key FROM tasks WHERE category = 'wom_invoicing' AND status NOT IN ('completed', 'cancelled')")
    .all();
  for (const row of openTasks) {
    const code = row.source_key.replace(/^WOM-/, "").replace(/-INVOICING$/, "");
    if (!stillOpen.has(code)) completeTaskBySourceKey(row.source_key);
  }
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
  // Whether RFM has already handed this change order to finance to try
  // trimming labor instead of requesting the Toyota paperwork (see
  // referWomChangeOrderToAdmin) -- only still "active" while there's still
  // a real change order to hand off; if the overage already cleared on its
  // own, there's nothing left to refer and the flag gets wiped below so a
  // *future* change order on this same WOM doesn't inherit a stale referral.
  const existingTask = findTaskBySourceKey(lifecycleTaskSourceKey(code));
  const referredToAdminActive = changeOrder && Boolean(existingTask && existingTask.referred_to_admin_at);
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
      // other step has a real owner. Once RFM has referred a change order
      // to finance instead, this leaves it routed there (see
      // referredToAdminActive above) rather than snapping it straight back
      // to RFM's queue the next time anyone loads the task list.
      assignedRole: referredToAdminActive ? "financial" : needsChangeOrderOrPo ? "reviewer" : nextStep ? nextStep.role || "reviewer" : null,
      priority: needsChangeOrderOrPo || sentToToyotaPending || workDone ? "high" : "normal",
      isException: needsChangeOrderOrPo,
      isChangeOrder: changeOrder,
      // Cleared the moment there's no longer a live change order to refer
      // (left untouched, i.e. preserved, while one still exists -- see the
      // undefined-means-preserve convention in upsertTaskBySourceKey).
      referredToAdminAt: changeOrder ? undefined : null,
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

// RFM's first option on a change order: hand it to finance instead of
// taking it to Toyota, to see if trimming labor can bring the applied cost
// back under what Toyota already approved and skip the paperwork entirely.
// Only makes sense for a real cost overage (not a plain missing-PO gap --
// there's no cost to trim there), so the caller is expected to have already
// checked is_change_order. Sets referred_to_admin_at (read back by
// refreshWomLifecycleTask the next time it runs) and reassigns the task to
// finance's own queue, unclaimed, so anyone there can pick it up.
function referWomChangeOrderToAdmin(code, { note, userId, userName }) {
  const task = findTaskBySourceKey(lifecycleTaskSourceKey(code));
  if (!task) return null;
  db.prepare("UPDATE tasks SET referred_to_admin_at = ? WHERE id = ?").run(new Date().toISOString(), task.id);
  assignTask(task.id, { assignedTo: null, assignedRole: "financial" });
  addTaskComment(task.id, userId, userName, `Referred to admin to try reducing labor and avoid the change order: ${note}`);
  return findTask(task.id);
}

// The other branch of that same decision -- proceeding with Toyota's own
// paperwork, whether that's a change order's sign-off or just a plain
// missing PO. Clears any pending referral above: once the PO is actually
// being requested, there's nothing left to hand back to RFM.
function requestWomChangeOrderPo(code, { toyotaEmail, sentAt, userId, userName }) {
  const task = findTaskBySourceKey(lifecycleTaskSourceKey(code));
  if (!task) return null;
  db.prepare("UPDATE tasks SET referred_to_admin_at = NULL WHERE id = ?").run(task.id);
  setTaskStatus(task.id, "waiting");
  addTaskComment(
    task.id,
    userId,
    userName,
    `Requested Toyota PO${task.is_change_order ? " change order" : ""} approval -- sent to ${toyotaEmail} on ${new Date(sentAt).toLocaleDateString()}.`
  );
  return findTask(task.id);
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
  if (!isDone("work_complete") && (wom.status === "closed" || wom.status === "invoiced")) {
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
  // Smartsheet's Work Completed checkbox is evidence the work itself is
  // done -- nothing more. It used to also blanket-complete every remaining
  // checklist step (including "Invoice"), which is exactly how a WOM still
  // mid-billing got wrongly marked Invoiced off of unrelated Status text.
  // Work Completed now only ever touches this one step.
  if (!isDone("work_complete") && wom.source_work_completed === 1) {
    markWomLifecycleStepComplete(code, "work_complete", "sync");
  }
  // A real invoice number on file (or the full billing checklist completed)
  // is the only evidence this app accepts that a WOM has actually been
  // invoiced -- never Status/Billing free text alone. `status` itself is
  // promoted to "invoiced" by syncWomsFromSheetRows the moment that
  // evidence appears (see applyWomSourceEvidence); this just catches the
  // checklist step up to match.
  if (!isDone("invoiced") && sourceImpliesInvoiced(wom)) {
    markWomLifecycleStepComplete(code, "invoiced", "sync");
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

function vendorComplianceTaskSourceKey(vendorId) {
  return `VENDOR-${vendorId}-COMPLIANCE`;
}

// A vendor's COI/W-9/ACH upload itself (not the case-status tracking above
// it) has passed its own expiration date -- a fact the vendor record
// doesn't carry on its own, since expiration lives per-document on the
// files table, not on the vendor row.
function vendorHasExpiredComplianceDoc(vendorId) {
  return listExpiredVendorComplianceCategories(vendorId).length > 0;
}

// Which of a vendor's COI/W-9/ACH categories currently have an expired
// upload on file -- the detail behind vendorHasExpiredComplianceDoc's
// boolean, needed to tell the vendor specifically what to resend rather
// than just that something is wrong.
function listExpiredVendorComplianceCategories(vendorId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT category FROM files WHERE related_type = 'vendor' AND related_id = ? AND category IN ('coi', 'w9', 'ach')
       AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .all(String(vendorId), new Date().toISOString().slice(0, 10));
  return rows.map((r) => r.category);
}

// Why a vendor currently needs a compliance follow-up -- shown on the task
// itself so acting on it doesn't require a trip back to the vendor record
// first to remember what was actually wrong.
function vendorComplianceReasons(v, vendorId) {
  const reasons = [];
  if (!v.formChecksComplete) reasons.push("one or more document checks (COI/W-9/ACH) aren't confirmed yet");
  if (v.formsStatus === "outdated") reasons.push("forms status is outdated");
  if (v.w9InvoiceStale) reasons.push("the blank invoice on file is over 2 years old");
  if (vendorHasExpiredComplianceDoc(vendorId)) reasons.push("a COI/W-9/ACH document on file has expired");
  return reasons;
}

// Mirrors refreshWomLifecycleTask's own pattern: a task that tracks a live
// condition rather than a one-off to-do. It reopens (default
// reopenIfClosed) if someone marks it complete while the vendor is still
// actually out of compliance -- deliberately, since "done" has to mean the
// underlying gap is actually closed (a box checked, a current document
// re-uploaded, forms status corrected), not just that someone said so. It
// auto-completes the moment every one of those is true, same as a WOM
// lifecycle task clearing itself once its own checklist is done. Snoozing
// (generic to every task) is exactly how to say "I followed up, waiting on
// the vendor" without it reading as abandoned or as falsely resolved.
function refreshVendorComplianceTask(vendorId) {
  const v = findVendor(vendorId);
  if (!v) return;
  const reasons = vendorComplianceReasons(v, vendorId);
  const sourceKey = vendorComplianceTaskSourceKey(vendorId);
  if (reasons.length > 0) {
    upsertTaskBySourceKey(sourceKey, {
      title: `Follow up with ${v.name} on compliance`,
      description: `Needs attention: ${reasons.join("; ")}.`,
      category: "vendor_compliance",
      assignedRole: "financial",
      priority: "normal",
      relatedVendorId: vendorId,
      source: "vendor_compliance",
      sourceRecordId: String(vendorId),
      workflowRule: "vendor_compliance",
    });
  } else {
    completeTaskBySourceKey(sourceKey);
  }
}

function refreshAllVendorComplianceTasks() {
  for (const v of listVendors()) refreshVendorComplianceTask(v.id);
}

// Every compliance follow-up task ever generated for this vendor (open and
// completed alike), newest first, each with its own comment log -- so
// whatever got noted while following up (a call placed, a promised
// re-send, why it was eventually marked resolved) lives right in the
// vendor's own Onboarding & Compliance view instead of only being visible
// by separately going to find the task on the board.
function listVendorComplianceTasks(vendorId) {
  const rows = db
    .prepare("SELECT * FROM tasks WHERE category = 'vendor_compliance' AND related_vendor_id = ? ORDER BY id DESC")
    .all(vendorId);
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    snoozedUntil: t.snoozed_until,
    createdAt: t.created_at,
    completedAt: t.completed_at,
    comments: listTaskComments(t.id).map((c) => ({ id: c.id, authorName: c.author_name, body: c.body, createdAt: c.created_at })),
  }));
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
  // One entry per WOM with BOTH a recorded quote (estimated_contracted) and
  // a reported applied cost -- "comparable" in the sense Krista asked for:
  // a WOM missing either figure is left out entirely rather than treated as
  // a 0, since a missing value and an actual zero mean different things.
  // vendorId/vendorName are null when the WOM's vendor hasn't been matched
  // to a confirmed vendor record -- those are kept here (for the flat
  // "Contracted services increased" review list) but excluded from any
  // vendor-grouped rollup below, so an unresolved vendor never silently
  // inherits a cost that isn't confirmed to be theirs.
  const contractedComparisons = [];
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
  // across every WOM on file (not just the overage ones, and not limited to
  // WOMs with a recorded quote) -- "who do we do business with, and how
  // much" independent of whether any single job ran over its own estimate.
  // Per-WOM detail (vendorSpendDetail) is kept alongside the vendor-grouped
  // rollup (vendorSpendById) so the Financials UI can re-filter/re-group by
  // region, location, subsidiary, or status without a round trip.
  const vendorSpendById = new Map();
  const vendorSpendDetail = [];
  let unallocatedContractedTotal = 0;
  let unallocatedContractedCount = 0;
  const vendorNameCache = new Map();
  const vendorName = (id) => {
    if (!vendorNameCache.has(id)) {
      const v = findVendor(id);
      vendorNameCache.set(id, v ? v.name : null);
    }
    return vendorNameCache.get(id);
  };
  const womCostReviewMap = getWomCostReviewMap();

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
    // Sales tax is its own itemized category (see SIMPLE_OVERCHARGE_CATEGORIES
    // below) and isn't something Toyota's PO ceiling is meant to absorb, so a
    // WOM that only clears toyota_po_value because of its tax line isn't a
    // real overage -- net applied_tax out before comparing/reporting here.
    if (w.applied_price != null && w.toyota_po_value != null) {
      const appliedNetOfTax = w.applied_price - (w.applied_tax || 0);
      const overage = appliedNetOfTax - w.toyota_po_value;
      if (overage > 0) {
        appliedOverToyotaPo.push({
          code: w.code,
          description: w.description,
          locationCode: w.location_code,
          appliedPrice: w.applied_price,
          toyotaPoValue: w.toyota_po_value,
          overage,
        });
      }
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
        toyotaPoValue: w.toyota_po_value,
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
    if (w.estimated_contracted != null && w.applied_contracted != null) {
      const diff = w.applied_contracted - w.estimated_contracted;
      // "N/A" rather than a number when the quote itself is 0 -- any applied
      // amount against a $0 quote is an infinite percentage, which isn't a
      // meaningful figure to show or sort by.
      const pctAboveQuote = w.estimated_contracted !== 0 ? (diff / w.estimated_contracted) * 100 : null;
      const review = presentWomCostReview(womCostReviewMap.get(w.code));
      contractedComparisons.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        subsidiaryCode: w.subsidiary_code,
        status: w.status,
        vendorId: w.vendor_id || null,
        vendorName: w.vendor_id ? vendorName(w.vendor_id) : null,
        quote: w.estimated_contracted,
        applied: w.applied_contracted,
        diff,
        aboveQuote: diff > 0,
        pctAboveQuote,
        ...review,
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
      vendorSpendDetail.push({
        code: w.code,
        description: w.description,
        locationCode: w.location_code,
        subsidiaryCode: w.subsidiary_code,
        status: w.status,
        vendorId: w.vendor_id,
        vendorName: vendorName(w.vendor_id),
        applied: w.applied_contracted,
      });
    } else if (w.applied_contracted != null) {
      // A contracted-services cost is on file, but this WOM's vendor hasn't
      // been matched to a confirmed vendor record -- "Vendor cost allocation
      // needed" rather than guessing, and kept out of every vendor-specific
      // total/ranking below.
      unallocatedContractedTotal += w.applied_contracted;
      unallocatedContractedCount++;
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
  contractedComparisons.sort((a, b) => b.diff - a.diff);
  appliedOverToyotaPo.sort((a, b) => b.overage - a.overage);

  // Kept under its old name/shape for the "Contracted services increased"
  // review-category tile -- every comparable WOM that came in above quote,
  // vendor-matched or not (see vendorAboveQuote below for the vendor-grouped,
  // vendor-confirmed-only view).
  const contractedIncreased = contractedComparisons
    .filter((c) => c.aboveQuote)
    .map((c) => ({
      code: c.code,
      description: c.description,
      locationCode: c.locationCode,
      vendorId: c.vendorId,
      vendorName: c.vendorName,
      estimatedContracted: c.quote,
      appliedContracted: c.applied,
      overage: c.diff,
    }));

  // Repeated Costs Above Quote -- grouped by confirmed vendor only (an
  // unmatched WOM is never folded into a vendor's numbers). comparableWomCount
  // is every quote+applied WOM for that vendor, aboveQuoteCount how many of
  // those came in over -- "4 of 10 comparable WOMs above quote" reads
  // straight off these two. pctAboveQuote is total excess over the SAME
  // above-quote WOMs' total quote (not every comparable WOM's quote), per
  // Krista's definition -- null when that total is 0 rather than a divide-
  // by-zero. reviewStatus rolls up every above-quote WOM's own review: only
  // "reviewed" once every one of them is, "needs_review" when none are,
  // "mixed" otherwise.
  const vendorCompById = new Map();
  for (const c of contractedComparisons) {
    if (!c.vendorId) continue;
    const cur = vendorCompById.get(c.vendorId) || { vendorId: c.vendorId, vendorName: c.vendorName, comparable: [], aboveQuote: [] };
    cur.comparable.push(c);
    if (c.aboveQuote) cur.aboveQuote.push(c);
    vendorCompById.set(c.vendorId, cur);
  }
  const vendorAboveQuote = [...vendorCompById.values()]
    .filter((v) => v.aboveQuote.length > 1)
    .map((v) => {
      const totalAboveQuote = v.aboveQuote.reduce((sum, c) => sum + c.diff, 0);
      const totalComparisonQuote = v.aboveQuote.reduce((sum, c) => sum + c.quote, 0);
      const reviewedCount = v.aboveQuote.filter((c) => c.reviewStatus === "reviewed").length;
      const reviewStatus = reviewedCount === 0 ? "needs_review" : reviewedCount === v.aboveQuote.length ? "reviewed" : "mixed";
      return {
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        comparableWomCount: v.comparable.length,
        aboveQuoteCount: v.aboveQuote.length,
        totalAboveQuote,
        totalComparisonQuote,
        pctAboveQuote: totalComparisonQuote !== 0 ? (totalAboveQuote / totalComparisonQuote) * 100 : null,
        reviewStatus,
      };
    })
    .sort((a, b) => b.aboveQuoteCount - a.aboveQuoteCount || b.totalAboveQuote - a.totalAboveQuote);

  const vendorSpend = [...vendorSpendById.values()].sort((a, b) => b.totalAppliedContracted - a.totalAppliedContracted);
  const totalMatchedVendorCosts = vendorSpend.reduce((sum, v) => sum + v.totalAppliedContracted, 0);
  for (const v of vendorSpend) {
    v.shareOfMatchedCosts = totalMatchedVendorCosts !== 0 ? (v.totalAppliedContracted / totalMatchedVendorCosts) * 100 : null;
  }
  // What's actually posted to the GL against each vendor's matched POs --
  // a different, more authoritative figure than the WOM-reported applied
  // cost above (which comes from the project tracker, not a GL import).
  // Independent of the region/location/status filters Vendor Spend Overview
  // applies to the WOM-side figures: GL entries attach to POs, not WOMs, so
  // there's no shared per-WOM link to filter this the same way.
  const vendorGlTotals = getVendorGlTotals();

  const categoryOverages = SIMPLE_OVERCHARGE_CATEGORIES.map((cat) => {
    const items = categoryOvercharges[cat.key].sort((a, b) => b.overage - a.overage);
    return { key: cat.key, label: cat.label, count: items.length, total: items.reduce((sum, o) => sum + o.overage, 0), items };
  });

  // Remaining Toyota PO -- same "budget quoted but not yet used" shape as
  // Remaining Estimate, but against the REAL $ total of this WOM's actual
  // Toyota PO(s) (Budget PO Tracker's own po_amount, summed by WOM #) rather
  // than the single synced "TOY Value" sheet cell or this app's own
  // estimate. Only counts "active" PO Tracker rows (a still-
  // needs_organization row hasn't been confirmed to even have a real PO #
  // yet). A WOM can have more than one PO/change order over its life, so
  // this sums all of them and keeps each one's own raw status text (never
  // interpreted as open/closed -- see the Financials UI comment on why).
  const poRows = db
    .prepare("SELECT wom_number, po_number, po_amount, status FROM pos WHERE lifecycle_status = 'active' AND wom_number IS NOT NULL AND po_amount IS NOT NULL")
    .all();
  const poGroupsByWom = new Map();
  for (const p of poRows) {
    const group = poGroupsByWom.get(p.wom_number) || { total: 0, pos: [] };
    group.total += p.po_amount;
    group.pos.push({ poNumber: p.po_number, amount: p.po_amount, status: p.status });
    poGroupsByWom.set(p.wom_number, group);
  }
  const remainingToyotaPo = [];
  for (const w of rows) {
    const group = poGroupsByWom.get(w.code);
    if (!group || w.applied_price == null || group.total <= w.applied_price) continue;
    remainingToyotaPo.push({
      code: w.code,
      description: w.description,
      locationCode: w.location_code,
      poTotal: group.total,
      appliedPrice: w.applied_price,
      overage: group.total - w.applied_price,
      pos: group.pos,
    });
  }
  remainingToyotaPo.sort((a, b) => b.overage - a.overage);

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
    // Repeated Costs Above Quote and Vendor Spend Overview -- see the
    // comments above where each is built. contractedComparisons/
    // vendorSpendDetail are the flat per-WOM rows the Financials UI filters
    // and re-groups by region/location/subsidiary/status; vendorAboveQuote/
    // vendorSpend are the same thing already grouped by vendor, unfiltered.
    contractedComparisons,
    vendorAboveQuote,
    vendorSpend,
    vendorSpendDetail,
    vendorGlTotals,
    contractedUnallocated: { count: unallocatedContractedCount, total: unallocatedContractedTotal },
    categoryOverages,
    remainingToyotaPoCount: remainingToyotaPo.length,
    remainingToyotaPoTotal: remainingToyotaPo.reduce((sum, o) => sum + o.overage, 0),
    remainingToyotaPo,
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

// A role-queued task (assignedRole set, assignedTo not -- "Unclaimed --
// Admin/RFM", requiring a Claim click) only needs to stay unclaimed when
// there's genuinely more than one person it could belong to. With a single
// active admin account, or (for the reviewer-specific queue) a designated
// RFM, there's exactly one honest answer to "who does this belong to," so
// it goes straight to them instead of making a one-person team click
// Claim on everything. The moment a second active admin exists with no
// RFM designated, this naturally stops firing -- there's no longer a safe
// single default -- and new/refreshed tasks fall back to the existing
// role-queued behavior with no flag or migration needed for that
// transition. Never applies to "tech" (always more than one tech) or a
// bare null role (genuinely unassigned, nobody's queue at all).
function defaultAssigneeForRole(assignedRole) {
  if (assignedRole !== "admin" && assignedRole !== "financial" && assignedRole !== "reviewer") return null;
  if (assignedRole === "reviewer") {
    const reviewerId = getPseReviewerId();
    if (reviewerId) return reviewerId;
  }
  const activeAdmins = listAdmins().filter((a) => a.active);
  return activeAdmins.length === 1 ? activeAdmins[0].id : null;
}

// Centralized so every task creation/refresh path (WOM lifecycle,
// recurring, vendor compliance, and a hand-added task alike) gets
// auto-assignment for free rather than each workflow having to remember
// to call it -- an explicit assignedTo is always left alone either way.
function withAutoAssignee(assignedTo, assignedRole) {
  return assignedTo || defaultAssigneeForRole(assignedRole);
}

// Each reason a person can opt into separately -- "applies" decides whether
// a given task counts as that reason at all; the column is their own
// on/off switch for it. A task can match more than one (e.g. an urgent WOM
// task) -- that's one email naming every reason it matched, not several.
const TASK_NOTIFICATION_REASONS = [
  { key: "notify_task_assigned", label: "Tasks assigned to you", applies: () => true },
  { key: "notify_task_urgent", label: "Marked urgent", applies: (t) => t.priority === "high" },
  { key: "notify_task_wom", label: "A WOM project task", applies: (t) => Boolean(t.related_wom_code) },
  {
    key: "notify_task_po_discrepancy",
    label: "A PO discrepancy",
    applies: (t) =>
      t.source === "po_coding_drift" ||
      t.source === "po_vendor_unregistered" ||
      t.source === "po_job_number_type_mismatch" ||
      t.source === "po_wom_location_mismatch",
  },
];

// Fires once, right when a task first lands on a real person -- never from
// an automated workflow rule just re-touching a task that was already
// assigned (see the reassignment-only check in assignTask), so nobody gets
// re-emailed every time a page load happens to refresh an existing task.
function maybeNotifyTaskAssignee(task) {
  if (!task || !task.assigned_to) return;
  const person = findTechnician(task.assigned_to);
  if (!person || !person.email) return;
  const matched = TASK_NOTIFICATION_REASONS.filter((r) => person[r.key] && r.applies(task));
  if (matched.length === 0) return;
  mailer
    .sendMail({
      to: person.email,
      subject: `New task: ${task.title}`,
      text: `Hi ${person.name},\n\nA task was assigned to you:\n\n${task.title}${
        task.description ? `\n${task.description}` : ""
      }\n\nWhy you're hearing about this: ${matched.map((r) => r.label).join(", ")}.\n\nOpen Task Manager to view it.\n`,
    })
    .catch((err) => console.error(`[mailer] failed to notify ${person.id} of task ${task.id}:`, err.message));
}

function createTask(fields) {
  const now = new Date().toISOString();
  const assignedTo = withAutoAssignee(fields.assignedTo || null, fields.assignedRole || null);
  const result = db
    .prepare(
      `INSERT INTO tasks (source_key, title, description, assigned_to, assigned_role, category, priority, due_at,
       status, related_wom_code, related_vendor_id, related_location_code, related_tech_id, related_po, related_po_id,
       source, source_record_id, workflow_rule, is_exception, is_change_order, created_by, created_at, assigned_at, last_status_change_at,
       po_stage, po_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      fields.relatedPoId || null,
      fields.source || "manual",
      fields.sourceRecordId || null,
      fields.workflowRule || null,
      fields.isException ? 1 : 0,
      fields.isChangeOrder ? 1 : 0,
      fields.createdBy || null,
      now,
      assignedTo ? now : null,
      now,
      fields.poStage || null,
      fields.poOrigin || null
    );
  const created = findTask(Number(result.lastInsertRowid));
  maybeNotifyTaskAssignee(created);
  return created;
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
// preserveDueAtOnUpdate: for a recurring task, whose spec recomputes the
// same due date fresh on every lazy regeneration -- without this, that
// recompute would silently undo a comment-triggered push forward (see
// pushRecurringTaskDueDate) the very next time anyone loads the task list,
// since it happens on every GET. Only matters once the row already exists;
// its first-ever creation still gets the freshly computed due date.
function upsertTaskBySourceKey(sourceKey, fields, { reopenIfClosed = true, preserveDueAtOnUpdate = false } = {}) {
  const existing = findTaskBySourceKey(sourceKey);
  if (!existing) return createTask({ ...fields, sourceKey });
  if (!reopenIfClosed && (existing.status === "completed" || existing.status === "cancelled")) return existing;

  const now = new Date().toISOString();
  // Resolved ahead of the query (rather than inline in .run()) since
  // withAutoAssignee needs the final role, not just whatever this one
  // call happened to pass -- an unrelated refresh (e.g. a sync touching
  // the WOM) that doesn't pass assignedRole at all must still auto-assign
  // off the role the task already has.
  const resolvedAssignedRole = fields.assignedRole !== undefined ? fields.assignedRole || null : existing.assigned_role;
  const resolvedAssignedTo = withAutoAssignee(
    fields.assignedTo !== undefined ? fields.assignedTo || null : existing.assigned_to,
    resolvedAssignedRole
  );
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, assigned_to = ?, assigned_role = ?, category = ?,
     priority = ?, due_at = ?, related_wom_code = ?, related_vendor_id = ?, related_location_code = ?,
     related_tech_id = ?, related_po = ?, workflow_rule = ?, is_exception = ?, is_change_order = ?,
     referred_to_admin_at = ?,
     status = CASE WHEN status IN ('completed','cancelled') THEN 'open' ELSE status END,
     completed_at = CASE WHEN status IN ('completed','cancelled') THEN NULL ELSE completed_at END,
     last_status_change_at = ?
     WHERE id = ?`
  ).run(
    fields.title ?? existing.title,
    fields.description ?? existing.description,
    resolvedAssignedTo,
    resolvedAssignedRole,
    fields.category ?? existing.category,
    fields.priority ?? existing.priority,
    preserveDueAtOnUpdate ? existing.due_at : fields.dueAt !== undefined ? fields.dueAt || null : existing.due_at,
    fields.relatedWomCode !== undefined ? fields.relatedWomCode || null : existing.related_wom_code,
    fields.relatedVendorId !== undefined ? fields.relatedVendorId || null : existing.related_vendor_id,
    fields.relatedLocationCode !== undefined ? fields.relatedLocationCode || null : existing.related_location_code,
    fields.relatedTechId !== undefined ? fields.relatedTechId || null : existing.related_tech_id,
    fields.relatedPo !== undefined ? fields.relatedPo || null : existing.related_po,
    fields.workflowRule ?? existing.workflow_rule,
    fields.isException !== undefined ? (fields.isException ? 1 : 0) : existing.is_exception,
    fields.isChangeOrder !== undefined ? (fields.isChangeOrder ? 1 : 0) : existing.is_change_order,
    fields.referredToAdminAt !== undefined ? fields.referredToAdminAt : existing.referred_to_admin_at,
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

// assignedTo/assignedRole are independently optional -- passing just one
// (e.g. the common "assign this to a person" case) must never silently wipe
// the other back to null. Only a field actually present in the call
// (including explicitly null, to clear it) overwrites; an omitted one keeps
// its current value.
function assignTask(id, { assignedTo, assignedRole } = {}) {
  const existing = findTask(id);
  if (!existing) return null;
  const nextAssignedTo = assignedTo !== undefined ? assignedTo || null : existing.assigned_to;
  db.prepare("UPDATE tasks SET assigned_to = ?, assigned_role = ?, assigned_at = ? WHERE id = ?").run(
    nextAssignedTo,
    assignedRole !== undefined ? assignedRole || null : existing.assigned_role,
    new Date().toISOString(),
    id
  );
  const updated = findTask(id);
  // Only a real hand-off to someone new is worth an email -- re-saving the
  // same assignee (e.g. editing the role alongside it) isn't a new "you've
  // received this task" moment.
  if (nextAssignedTo && nextAssignedTo !== existing.assigned_to) maybeNotifyTaskAssignee(updated);
  return updated;
}

// The "mark PO generated" step of a po_request task: locks in which vendor
// it's actually for (the WOM's own vendor_id may have been null, or wrong),
// starts the vendor-invoice follow-up clock (see refreshAllPoRequestLifecycleTasks),
// and clears any prior snooze -- a task that was snoozed before this point
// genuinely has new, unreviewed state now.
const PO_FOLLOWUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function markTaskPoGenerated(id, { vendorId, generatedBy } = {}) {
  const existing = findTask(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const dueAt = new Date(Date.now() + PO_FOLLOWUP_WINDOW_MS).toISOString();
  db.prepare(
    `UPDATE tasks SET related_vendor_id = ?, po_stage = 'pending_invoice', po_generated_at = ?,
     po_generated_by = ?, due_at = ?, snoozed_until = NULL, last_status_change_at = ? WHERE id = ?`
  ).run(vendorId || existing.related_vendor_id || null, now, generatedBy || null, dueAt, now, id);
  return findTask(id);
}

// Tech-requested and AP-invoice-backfill po_request tasks measure two
// different things -- "how long to fulfill a request someone made" vs "how
// long to notice and fix a gap nobody flagged" -- so they're kept in
// separate buckets rather than one blended average. Only counts a task
// that's actually reached po_generated_at (created_at to po_generated_at
// is the turnaround figure); a still-open request has nothing to measure
// yet. NULL po_origin (every row from before that column existed) reads as
// "tech_requested", the only flow that existed then.
function getPoRequestTurnaroundStats() {
  const rows = db
    .prepare("SELECT po_origin, created_at, po_generated_at FROM tasks WHERE category = 'po_request' AND po_generated_at IS NOT NULL")
    .all();
  const hoursFor = (r) => (new Date(r.po_generated_at).getTime() - new Date(r.created_at).getTime()) / 3600000;
  const techRequested = rows.filter((r) => r.po_origin !== "ap_invoice_backfill").map(hoursFor);
  const apInvoiceBackfill = rows.filter((r) => r.po_origin === "ap_invoice_backfill").map(hoursFor);
  const summarize = (hours) => ({
    count: hours.length,
    avgHours: hours.length ? round2(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
  });
  return { techRequested: summarize(techRequested), apInvoiceBackfill: summarize(apInvoiceBackfill) };
}

// Per-person KPIs across every task-receiving person (tech or admin), all
// computed from timestamps the app already records rather than any new
// tracking UI: average time to generate a requested PO (po_generated_by,
// created_at -> po_generated_at), vendor-compliance cases resolved
// (vendor_requests.updated_by), and reclass request-to-submission
// turnaround (reclass_items.submitted_by, created_at -> submitted_at).
// `from`/`to` are plain "YYYY-MM-DD" strings (inclusive) scoping each
// metric by its own completion date -- a still-open item never counts
// toward anyone's average since it hasn't finished yet. Both omitted
// means all-time.
function getPerformanceKpis({ from, to } = {}) {
  const inRange = (isoTimestamp) => {
    if (!isoTimestamp) return false;
    const day = isoTimestamp.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };

  const people = [
    ...listTechnicians()
      .filter((t) => t.employment_status === "active")
      .map((t) => ({ id: t.id, name: t.name, role: "tech" })),
    ...listAdmins()
      .filter((a) => a.active)
      .map((a) => ({ id: a.id, name: a.name, role: "admin" })),
  ];

  const poRows = db
    .prepare(
      "SELECT po_generated_by, created_at, po_generated_at FROM tasks WHERE category = 'po_request' AND po_generated_by IS NOT NULL AND po_generated_at IS NOT NULL"
    )
    .all();
  const vendorRows = db.prepare("SELECT updated_by, updated_at FROM vendor_requests WHERE updated_by IS NOT NULL").all();
  const reclassRows = db
    .prepare("SELECT submitted_by, submitted_at, created_at FROM reclass_items WHERE submitted_by IS NOT NULL AND submitted_at IS NOT NULL")
    .all();

  const avgOf = (hours) => (hours.length ? round2(hours.reduce((a, b) => a + b, 0) / hours.length) : null);

  return people.map((p) => {
    const poForPerson = poRows.filter((r) => r.po_generated_by === p.id && inRange(r.po_generated_at));
    const poHours = poForPerson.map((r) => (new Date(r.po_generated_at).getTime() - new Date(r.created_at).getTime()) / 3600000);
    const reclassForPerson = reclassRows.filter((r) => r.submitted_by === p.id && inRange(r.submitted_at));
    const reclassHours = reclassForPerson.map((r) => (new Date(r.submitted_at).getTime() - new Date(r.created_at).getTime()) / 3600000);
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      poRequestsGenerated: poForPerson.length,
      poRequestsAvgHours: avgOf(poHours),
      vendorDocsCompleted: vendorRows.filter((r) => r.updated_by === p.id && inRange(r.updated_at)).length,
      reclassSubmitted: reclassForPerson.length,
      reclassAvgHours: avgOf(reclassHours),
    };
  });
}

// A flat week rather than deriving each recurring task's own exact cadence
// (weekly/biweekly/monthly, which varies by spec and isn't always stored
// anywhere a comment handler could easily look up) -- simple, and matches
// "chipping away at an ongoing project" well enough: multiple comments
// across a month keep a monthly task's due date pushed out the same as one
// comment would for a weekly one.
const RECURRING_TASK_COMMENT_PUSH_DAYS = 7;

function addTaskComment(taskId, authorId, authorName, body) {
  db.prepare("INSERT INTO task_comments (task_id, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    authorId,
    authorName,
    body,
    new Date().toISOString()
  );
  pushRecurringTaskDueDate(taskId);
  return listTaskComments(taskId);
}

// Logging progress on an ongoing recurring task (vendor compliance
// cleanup, timecard review, etc.) is itself evidence it's being worked --
// a comment pushes its due date out, clearing "overdue" instead of it
// reading overdue indefinitely just because the date it happened to
// generate with has passed while work is still actively going into it.
// Only ever pushes forward (never pulls a due date that's further out back
// in), and only while the task is still open -- a completed/cancelled
// task's due date is just history, not a live countdown.
function pushRecurringTaskDueDate(taskId) {
  const task = findTask(taskId);
  if (!task || task.category !== "recurring" || !OPEN_TASK_STATUSES.includes(task.status)) return;
  const pushedTo = new Date(Date.now() + RECURRING_TASK_COMMENT_PUSH_DAYS * 86400000).toISOString();
  const currentDueMs = task.due_at ? new Date(task.due_at).getTime() : 0;
  if (new Date(pushedTo).getTime() > currentDueMs) {
    db.prepare("UPDATE tasks SET due_at = ? WHERE id = ?").run(pushedTo, taskId);
  }
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

  // A task tied to a Budget PO Tracker record still sitting in Needs
  // Organization stays out of every list/count/notification, unconditionally
  // -- not just the default views -- until that PO is moved to Active. A
  // task with no PO link at all is unaffected.
  clauses.push("(related_po_id IS NULL OR related_po_id IN (SELECT id FROM pos WHERE lifecycle_status = 'active'))");

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
  if (filters.excludeCategory) {
    clauses.push("category != ?");
    params.push(filters.excludeCategory);
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
      { reopenIfClosed: false, preserveDueAtOnUpdate: true }
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
      { reopenIfClosed: false, preserveDueAtOnUpdate: true }
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
// A GL line's raw "Location Code" column is "<jde code> - <facility name>"
// (e.g. "20001805 - TOYOTA/HQ DR PLANO, TX") -- only the name portion is
// usable against matchLocationCodeByName below, since the numeric prefix
// doesn't correspond to anything this app already tracks.
function extractGlLocationName(raw) {
  if (!raw) return null;
  const idx = String(raw).indexOf(" - ");
  return idx === -1 ? String(raw).trim() : String(raw).slice(idx + 3).trim();
}

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

// A sheet's "Work Completed" column is free text, not a real checkbox --
// "True"/"Yes"/"Complete" style values map to done, "False"/"No"/blank map
// to not-done, and anything else (wording neither list recognizes) stays
// null rather than guessing. computeWomStatusConflict (routes/woms.js) also
// checks the raw text directly, so an unrecognized value isn't lost, just
// not folded into this derived flag.
function parseWorkCompletedFlag(raw) {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (["true", "yes", "y", "complete", "completed", "done", "x", "1"].includes(v)) return 1;
  if (["false", "no", "n", "incomplete", "0"].includes(v)) return 0;
  return null;
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

// Verbatim Status/Work Completed/Billing/Requested-By/billing-checklist
// values from the sheet -- same centralized-columns-list treatment as
// WOM_COST_BREAKDOWN_FIELDS above, for the same reason (one entry here
// instead of a hand-edit to several SQL statements + diffFields). Never
// read by anything that writes `status` itself -- see the
// woms.source_status_raw migration comment and computeWomStatusConflict in
// routes/woms.js. Every diffLabel here is null on purpose: these are raw
// text/checkbox cells that change often and mean nothing on their own (see
// the "Install drop ceiling" bug this replaced -- a Status cell saying
// something unrelated used to read as "done"). applyWomSourceEvidence below
// is what turns an actual, meaningful change in these into a message.
const WOM_SOURCE_FIELDS = [
  { dbColumn: "source_status_raw", jsField: "sourceStatusRaw", diffLabel: null },
  { dbColumn: "source_work_completed_raw", jsField: "sourceWorkCompletedRaw", diffLabel: null },
  { dbColumn: "source_work_completed", jsField: "sourceWorkCompleted", diffLabel: null },
  { dbColumn: "source_billing_raw", jsField: "sourceBillingRaw", diffLabel: null },
  { dbColumn: "source_requested_by", jsField: "sourceRequestedBy", diffLabel: "requested by" },
  { dbColumn: "source_vendor_inv_attached_raw", jsField: "vendorInvAttachedRaw", diffLabel: null },
  { dbColumn: "source_vendor_inv_attached", jsField: "vendorInvAttached", diffLabel: null },
  { dbColumn: "source_invoice_attached_raw", jsField: "invoiceAttachedRaw", diffLabel: null },
  { dbColumn: "source_invoice_attached", jsField: "invoiceAttached", diffLabel: null },
  { dbColumn: "source_journal_edit_raw", jsField: "journalEditRaw", diffLabel: null },
  { dbColumn: "source_journal_edit", jsField: "journalEdit", diffLabel: null },
  { dbColumn: "source_ariba_confirm_raw", jsField: "aribaConfirmRaw", diffLabel: null },
  { dbColumn: "source_ariba_confirm", jsField: "aribaConfirm", diffLabel: null },
  { dbColumn: "source_sent_to_jason_raw", jsField: "sentToJasonRaw", diffLabel: null },
  { dbColumn: "source_sent_to_jason", jsField: "sentToJason", diffLabel: null },
  // "Billing Ref #" -- a verbatim reference number (e.g. a RITM#) Krista
  // enters by hand once a batch is billed. Display-only, like the other raw
  // fields above; the "Billing" checkbox right below is the real evidence.
  { dbColumn: "source_billing_ref_number", jsField: "billingRefNumber", diffLabel: "billing reference #" },
  { dbColumn: "source_batch_posted_confirmed_raw", jsField: "batchPostedConfirmedRaw", diffLabel: null },
  { dbColumn: "source_batch_posted_confirmed", jsField: "batchPostedConfirmed", diffLabel: null },
  { dbColumn: "source_work_completed_date", jsField: "workCompletedDate", diffLabel: "work completed date" },
  { dbColumn: "source_batch_date", jsField: "batchDate", diffLabel: "batch date" },
  { dbColumn: "source_reclass_amount_requested", jsField: "reclassAmountRequested", diffLabel: "reclass amount requested" },
  { dbColumn: "source_reclass_submitted", jsField: "reclassSubmitted", diffLabel: null },
  { dbColumn: "source_reclass_to_raw", jsField: "reclassToRaw", diffLabel: null },
];

// The 6 billing-checklist sub-steps, specifically -- a subset of
// WOM_SOURCE_FIELDS used to ask "is billing fully done," separate from
// whether the work itself is done (source_work_completed, a different
// question entirely).
const WOM_BILLING_CHECKLIST_FIELDS = [
  { dbColumn: "source_vendor_inv_attached", jsField: "vendorInvAttached", label: "Vendor INV Attached" },
  { dbColumn: "source_invoice_attached", jsField: "invoiceAttached", label: "Invoice Attached" },
  { dbColumn: "source_journal_edit", jsField: "journalEdit", label: "Journal Edit" },
  { dbColumn: "source_ariba_confirm", jsField: "aribaConfirm", label: "Ariba Confirm" },
  { dbColumn: "source_sent_to_jason", jsField: "sentToJason", label: "Sent to Jason" },
  { dbColumn: "source_batch_posted_confirmed", jsField: "batchPostedConfirmed", label: "Batch Posted Confirmed" },
];

function isWomBillingChecklistComplete(w) {
  return WOM_BILLING_CHECKLIST_FIELDS.every((f) => w[f.dbColumn] === 1);
}

// The only evidence this app accepts that a WOM has actually been invoiced:
// a real invoice number on file, or the full billing checklist completed.
// Deliberately NOT Status/Work Completed/Billing free text -- that's what
// used to cause a WOM still mid-billing to get marked Invoiced purely
// because its Status cell said something unrelated ("Install drop ceiling").
// Shared here (not duplicated in routes/woms.js) since both the sync-time
// auto-promotion (applyWomSourceEvidence) and computeWomStatusConflict's
// banner need to agree on exactly what "the sheet says invoiced" means.
function sourceImpliesInvoiced(w) {
  return Boolean(w.invoice_number) || isWomBillingChecklistComplete(w);
}

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
  for (const f of WOM_SOURCE_FIELDS) {
    if (f.diffLabel && next[f.jsField] != null && valuesDiffer(existing[f.dbColumn], next[f.jsField])) fields.push(f.diffLabel);
  }
  if (next.matchedVendorId && !existing.vendor_id) fields.push("vendor");
  return fields;
}

// The one place a sync turns real evidence (not raw Status/Billing text)
// into an actual change: Work Completed marks only the "work_complete"
// lifecycle step; a new invoice number (or batch number) is written
// straight onto the WOM and, the first time one appears, promotes `status`
// itself to "invoiced" -- the same two facts a human enters by hand via
// completeWomLifecycleStep's "invoiced" step, just arriving from the sheet
// instead. `before` is the WOM row as it stood immediately before this
// sync's main UPDATE/INSERT; returns the specific messages (if any) to
// surface in this sync's change log, never a generic "status changed."
function applyWomSourceEvidence(code, before, sourceWorkCompleted, billingFields, invoiceNumber, batchNumber) {
  const messages = [];

  if (sourceWorkCompleted === 1 && before.source_work_completed !== 1) {
    messages.push("Work marked complete");
  }

  const billingNowComplete = WOM_BILLING_CHECKLIST_FIELDS.every((f) => billingFields[f.jsField] === 1);
  const billingWasComplete = WOM_BILLING_CHECKLIST_FIELDS.every((f) => before[f.dbColumn] === 1);
  if (billingNowComplete && !billingWasComplete) {
    messages.push("Billing checklist completed");
  }

  if (invoiceNumber && invoiceNumber !== before.invoice_number) {
    const isNew = !before.invoice_number;
    db.prepare("UPDATE woms SET invoice_number = ?, batch_number = COALESCE(?, batch_number) WHERE code = ?").run(
      invoiceNumber,
      batchNumber,
      code
    );
    messages.push(isNew ? "Invoice number added" : "Invoice number updated");
    if (isNew && !["invoiced", "closed", "cancelled"].includes(before.status)) {
      setWomStatus(code, "invoiced", { source: "smartsheet_sync" });
      messages.push("status: now invoiced (invoice # on file)");
    }
  } else if (batchNumber && batchNumber !== before.batch_number) {
    db.prepare("UPDATE woms SET batch_number = ? WHERE code = ?").run(batchNumber, code);
    messages.push(before.batch_number ? "Batch number updated" : "Batch number added");
  }

  return messages;
}

function syncWomsFromSheetRows(rows, columns) {
  const { wom: womColumn, estimate: estimateColumn, applied: appliedColumn, description: descriptionColumn } = columns;
  const { dateRequested: dateRequestedColumn, maximo: maximoColumn, location: locationColumn, subsidiary: subsidiaryColumn } = columns;
  const { vendor: vendorColumn } = columns;
  const { sourceStatus: sourceStatusColumn, sourceWorkCompleted: sourceWorkCompletedColumn } = columns;
  const { sourceBilling: sourceBillingColumn, sourceRequestedBy: sourceRequestedByColumn } = columns;
  const { invoiceNumber: invoiceNumberColumn, batchNumber: batchNumberColumn } = columns;
  const { billingRefNumber: billingRefNumberColumn } = columns;
  const { workCompletedDate: workCompletedDateColumn, batchDate: batchDateColumn } = columns;
  const { reclassAmountRequested: reclassAmountRequestedColumn, reclassSubmitted: reclassSubmittedColumn, reclassToRaw: reclassToColumn } = columns;
  // The Smartsheet column title for each breakdown category, resolved once
  // up front -- looked up by row below, not re-resolved every row.
  const breakdownColumnTitles = WOM_COST_BREAKDOWN_FIELDS.map((f) => columns[f.jsField]);
  const breakdownSetSql = WOM_COST_BREAKDOWN_FIELDS.map((f) => `${f.dbColumn} = ?`).join(", ");
  const breakdownInsertColumnsSql = WOM_COST_BREAKDOWN_FIELDS.map((f) => f.dbColumn).join(", ");
  const breakdownInsertPlaceholders = WOM_COST_BREAKDOWN_FIELDS.map(() => "?").join(", ");
  const sourceSetSql = WOM_SOURCE_FIELDS.map((f) => `${f.dbColumn} = ?`).join(", ");
  const sourceInsertColumnsSql = WOM_SOURCE_FIELDS.map((f) => f.dbColumn).join(", ");
  const sourceInsertPlaceholders = WOM_SOURCE_FIELDS.map(() => "?").join(", ");
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
    const sourceStatusRaw = (sourceStatusColumn && row[sourceStatusColumn] && String(row[sourceStatusColumn]).trim()) || null;
    const sourceWorkCompletedRaw =
      (sourceWorkCompletedColumn && row[sourceWorkCompletedColumn] != null && String(row[sourceWorkCompletedColumn]).trim()) || null;
    const sourceWorkCompleted = parseWorkCompletedFlag(sourceWorkCompletedRaw);
    const sourceBillingRaw = (sourceBillingColumn && row[sourceBillingColumn] && String(row[sourceBillingColumn]).trim()) || null;
    const sourceRequestedBy = (sourceRequestedByColumn && row[sourceRequestedByColumn] && String(row[sourceRequestedByColumn]).trim()) || null;
    const billingRefNumber = (billingRefNumberColumn && row[billingRefNumberColumn] && String(row[billingRefNumberColumn]).trim()) || null;
    // The billing checklist -- 6 checkbox columns, each parsed the same way
    // Work Completed is (true/yes/x/1 -> 1, false/no/0 -> 0, anything else
    // -> null for "not on this sheet/not set"). "Batch Posted Confirmed" is
    // the one exception -- it's Krista's own manual confirmation step, not
    // a column the tracker has, so it's derived from billingRefNumber
    // (any ref #, including a legacy "Prior to Column" marker on an older
    // row, counts as confirmed) instead of looked up by its own title.
    const billingFields = { batchPostedConfirmed: billingRefNumber ? 1 : 0, batchPostedConfirmedRaw: billingRefNumber };
    for (const f of WOM_BILLING_CHECKLIST_FIELDS) {
      if (f.jsField === "batchPostedConfirmed") continue;
      const colTitle = columns[f.jsField];
      const raw = (colTitle && row[colTitle] != null && String(row[colTitle]).trim()) || null;
      billingFields[f.jsField] = parseWorkCompletedFlag(raw);
      billingFields[`${f.jsField}Raw`] = raw;
    }
    const invoiceNumber = (invoiceNumberColumn && row[invoiceNumberColumn] && String(row[invoiceNumberColumn]).trim()) || null;
    const batchNumber = (batchNumberColumn && row[batchNumberColumn] && String(row[batchNumberColumn]).trim()) || null;
    const workCompletedDate = (workCompletedDateColumn && row[workCompletedDateColumn] && String(row[workCompletedDateColumn]).trim()) || null;
    const batchDate = (batchDateColumn && row[batchDateColumn] && String(row[batchDateColumn]).trim()) || null;
    const reclassAmountRequested = reclassAmountRequestedColumn ? parseDollarAmount(row[reclassAmountRequestedColumn]) : null;
    const reclassSubmittedRaw =
      (reclassSubmittedColumn && row[reclassSubmittedColumn] != null && String(row[reclassSubmittedColumn]).trim()) || null;
    const reclassSubmitted = parseWorkCompletedFlag(reclassSubmittedRaw);
    const reclassToRaw = (reclassToColumn && row[reclassToColumn] != null && String(row[reclassToColumn]).trim()) || null;
    const sourceFields = {
      sourceStatusRaw,
      sourceWorkCompletedRaw,
      sourceWorkCompleted,
      sourceBillingRaw,
      sourceRequestedBy,
      billingRefNumber,
      workCompletedDate,
      batchDate,
      reclassAmountRequested,
      reclassSubmitted,
      reclassToRaw,
      ...billingFields,
    };
    const sourceParams = WOM_SOURCE_FIELDS.map((f) => sourceFields[f.jsField]);
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
        const fields = diffFields(collision, {
          estimatedPrice,
          appliedPrice,
          maximoNumber,
          subsidiaryCode,
          matchedLocationCode,
          ...breakdown,
          ...sourceFields,
        });
        db.prepare(
          `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
           location_code = COALESCE(location_code, ?), ${breakdownSetSql}, ${sourceSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
           smartsheet_raw_data = ?, smartsheet_synced_at = ?,
           smartsheet_row_number = ?, smartsheet_row_id = COALESCE(smartsheet_row_id, ?) WHERE code = ?`
        ).run(
          estimatedPrice,
          appliedPrice,
          maximoNumber,
          subsidiaryCode,
          matchedLocationCode,
          ...breakdownParams,
          ...sourceParams,
          matchedVendorId,
          dateRequestedValue,
          rawData,
          stamp,
          rowNumber,
          rowId,
          code
        );
        fields.push(...applyWomSourceEvidence(code, collision, sourceWorkCompleted, billingFields, invoiceNumber, batchNumber));
        if (fields.length > 0) {
          updated++;
          changedWoms.push({ code, description: collision.description, fields });
        }
        checkWomLifecycleAutoSteps(code);
        continue;
      }
      // A brand-new row whose sheet data already carries a real invoice
      // number by the time this app first sees it goes straight to
      // "invoiced" instead of landing on "open"/"requested"/"pending" and
      // waiting for a second sync to catch up. This applies even with no
      // real WOM # yet (realCode null) -- a vendor-only job can be invoiced
      // on the sheet before that column is ever filled in.
      const status = invoiceNumber ? "invoiced" : realCode ? "open" : requested ? "requested" : "pending";
      db.prepare(
        `INSERT INTO woms (code, description, status, estimated_price, applied_price, maximo_number, subsidiary_code,
         location_code, ${breakdownInsertColumnsSql}, ${sourceInsertColumnsSql}, vendor_id, date_requested,
         invoice_number, batch_number,
         smartsheet_raw_data, smartsheet_row_id, smartsheet_row_number, smartsheet_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${breakdownInsertPlaceholders}, ${sourceInsertPlaceholders}, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        ...sourceParams,
        matchedVendorId,
        dateRequestedValue,
        invoiceNumber,
        batchNumber,
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
      const promotedStatus = "open";
      db.prepare(
        `UPDATE woms SET code = ?, status = ?, estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), ${breakdownSetSql}, ${sourceSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        realCode,
        promotedStatus,
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        ...sourceParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      promoted++;
      recordWomStatusChange(realCode, "status", existing.status, promotedStatus, { source: "smartsheet_sync" });
      // Evidence-driven: if an invoice number already sits on the sheet by
      // the time a real WOM # arrives, this promotes it straight on to
      // "invoiced" right after, recorded as its own, separate transition.
      const evidenceMessages = applyWomSourceEvidence(realCode, existing, sourceWorkCompleted, billingFields, invoiceNumber, batchNumber);
      changedWoms.push({
        code: realCode,
        description: existing.description,
        fields: ["status: now open (real WOM # arrived)", ...evidenceMessages],
      });
      checkWomLifecycleAutoSteps(realCode);
      continue;
    }

    if (existing.status === "pending" && requested) {
      const promotedStatus = "requested";
      db.prepare(
        `UPDATE woms SET status = ?, estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), ${breakdownSetSql}, ${sourceSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        promotedStatus,
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        ...sourceParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      updated++;
      recordWomStatusChange(existing.code, "status", "pending", promotedStatus, { source: "smartsheet_sync" });
      const evidenceMessages = applyWomSourceEvidence(existing.code, existing, sourceWorkCompleted, billingFields, invoiceNumber, batchNumber);
      changedWoms.push({
        code: existing.code,
        description: existing.description,
        fields: ["status: now requested", ...evidenceMessages],
      });
      checkWomLifecycleAutoSteps(existing.code);
      continue;
    }

    {
      const fields = diffFields(existing, {
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdown,
        ...sourceFields,
      });
      db.prepare(
        `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
         location_code = COALESCE(location_code, ?), ${breakdownSetSql}, ${sourceSetSql}, vendor_id = COALESCE(vendor_id, ?), date_requested = ?,
         smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(
        estimatedPrice,
        appliedPrice,
        maximoNumber,
        subsidiaryCode,
        matchedLocationCode,
        ...breakdownParams,
        ...sourceParams,
        matchedVendorId,
        dateRequestedValue,
        rawData,
        stamp,
        rowNumber,
        existing.code
      );
      // A real invoice number appearing is the only thing that promotes
      // `status` to "invoiced" here -- never touches "cancelled" (a
      // deliberate admin call, not something sync should second-guess -- see
      // computeWomStatusConflict in routes/woms.js) or "closed"/"invoiced"
      // (already done); applyWomSourceEvidence itself guards against both.
      fields.push(...applyWomSourceEvidence(existing.code, existing, sourceWorkCompleted, billingFields, invoiceNumber, batchNumber));
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
              weekend_addendum_at, purelyhr_verified_at, tech_confirmed_at
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
      techConfirmedAt: null,
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
    techConfirmedAt: row.tech_confirmed_at,
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

function submitWeek(techId, weekMonday, { confirmedByTech = false } = {}) {
  ensureWeekRow(techId, weekMonday);
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE weeks SET status = 'submitted', submitted_at = ?, note = '', tech_confirmed_at = ? WHERE tech_id = ? AND week_monday = ?"
  ).run(now, confirmedByTech ? now : null, techId, weekMonday);
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
    INSERT INTO files (id, related_type, related_id, category, original_name, stored_name, mime_type, size, uploaded_by, uploaded_at, form_type, expires_at, access_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    file.expiresAt || null,
    file.accessLevel || "standard"
  );
  return getFile(file.id);
}

function listFiles(relatedType, relatedId) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              form_type AS formType, expires_at AS expiresAt, access_level AS accessLevel
       FROM files WHERE related_type = ? AND related_id = ? ORDER BY uploaded_at DESC`
    )
    .all(relatedType, relatedId);
}

function getFile(id) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt,
              form_type AS formType, expires_at AS expiresAt, access_level AS accessLevel
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

// Admin-only toggle, independent of relocating/re-categorizing a file --
// see canWrite's accessLevel handling in routes/files.js for who can reach
// this.
function setFileAccessLevel(id, accessLevel) {
  db.prepare("UPDATE files SET access_level = ? WHERE id = ?").run(accessLevel, id);
  return getFile(id);
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
              f.form_type AS formType, f.expires_at AS expiresAt, f.access_level AS accessLevel, t.title AS taskTitle
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

// ---- Budget PO Tracker ----
// A separate, manually-uploaded Excel tracker (not a live Smartsheet sync
// like WOMs) for non-Toyota operating-budget purchases. See the pos table
// comment for the overall model: sticky vendor_id/region, lifecycle_status
// only ever changed by the explicit Move to Active POs action.

function normalizeMatchText(v) {
  return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
}

// The real PO Number once one exists is this app's preferred identity for a
// record across re-imports -- stable for the rest of that PO's life. Before
// one exists (a brand new request, or one logged with a status word like
// "Cancelled"/"Hold" instead of a number -- the source tracker does this
// for a meaningful fraction of rows), fall back to a composite of
// requestor/date/description: not bulletproof (editing the description
// between imports reads as a new request), but the best available signal
// given the source has no dedicated per-row tracking ID at all.
// Two independent keys per row, not one switched identity -- see the pos
// table comment for why. composite_key is always returned; po_number_key is
// null unless poNumber is a real number. A single real PO Number can
// legitimately cover more than one line item (several distinct charges
// invoiced under one PO), so both keys fold in the description too, to keep
// those as separate records instead of one line item's import silently
// overwriting another's.
function computePoMatchKeys({ poNumber, requestor, dateRequested, description }) {
  const trimmedPo = String(poNumber == null ? "" : poNumber).trim();
  const normDesc = normalizeMatchText(description);
  const compositeKey = `composite:${normalizeMatchText(requestor)}|${normalizeMatchText(dateRequested)}|${normDesc}`;
  const poNumberKey = /^\d+$/.test(trimmedPo) ? `po:${trimmedPo}|${normDesc}` : null;
  return { compositeKey, poNumberKey };
}

// The "E&F Contract Job #" column in the source sheet carries the job
// number and the location's own name together, tab-separated (e.g.
// "100110042966\tCincinnati ROB") -- these are the exact job numbers
// already on file in this app's own locations table. Returns just the
// numeric job number part, or null for a blank/placeholder cell ("-").
function parseEfJobNumber(raw) {
  if (!raw) return null;
  const first = String(raw).split(/[\t\n]/)[0].trim();
  if (!first || first === "-") return null;
  return first;
}

function findLocationByEfJobNumber(jobNumber) {
  if (!jobNumber) return null;
  return db.prepare("SELECT * FROM locations WHERE ef_job_number = ?").get(jobNumber);
}

// A GL line's own "Business Unit" is the same 12-digit JDE job number the
// COA import already backfilled onto locations -- just under whichever of
// the three job-number columns that business unit actually belongs to
// (E&F, PPS, or WOM; confirmed against real GL data that a business unit
// landing in exactly one of those three is the norm, not an edge case).
// This is the precise, no-guessing way to resolve a GL line to a location
// -- see matchLocationCodeByName for the fuzzy fallback used only when a
// business unit doesn't appear in any of the three columns at all.
// Prepared once, not per call -- this runs once for every gl_entries row on
// a full re-backfill (see the matched_location_source migration), and
// re-preparing the same statement hundreds of thousands of times measurably
// slowed server startup on real production data.
const findLocationByJobNumberStmt = db.prepare("SELECT * FROM locations WHERE ef_job_number = ? OR pps_job_number = ? OR wom_job_number = ?");
function findLocationByJobNumber(businessUnit) {
  if (!businessUnit) return null;
  return findLocationByJobNumberStmt.get(businessUnit, businessUnit, businessUnit);
}

// Vendor Number in the source sheet lines up with this app's own JDE
// Vendor # -- the only thing ever allowed to auto-link a vendor (never the
// vendor name, which is preserved as free text and can collide across
// unrelated vendors).
function findVendorByNumber(vendorNumber) {
  const trimmed = String(vendorNumber == null ? "" : vendorNumber).trim();
  if (!trimmed) return null;
  return db.prepare("SELECT id FROM vendors WHERE jde_vendor_number = ?").get(trimmed);
}

function presentPoRow(p) {
  return {
    id: p.id,
    lineNumber: p.line_number,
    poNumber: p.po_number,
    dateRequested: p.date_requested,
    requestor: p.requestor,
    description: p.description,
    efJobNumberRaw: p.ef_job_number_raw,
    efJobNumber: p.ef_job_number,
    locationCode: p.location_code,
    locationName: p.location_code ? (findLocation(p.location_code) || {}).name || null : null,
    territory: poTerritory(p),
    region: p.region,
    regionConfirmed: Boolean(p.region_confirmed),
    poAmount: p.po_amount,
    changeOrder: p.change_order,
    status: p.status,
    vendorName: p.vendor_name,
    vendorNumber: p.vendor_number,
    vendorId: p.vendor_id,
    vendorLinkedName: p.vendor_id ? (findVendor(p.vendor_id) || {}).name || null : null,
    vendorLinkConfirmed: Boolean(p.vendor_link_confirmed),
    vendorLinkStatus: p.vendor_id ? "matched" : "needs_matching",
    ppsJobNumber: p.pps_job_number,
    e1WomJobNumber: p.e1_wom_job_number,
    womNumber: p.wom_number,
    assetNumber: p.asset_number,
    maximoWo: p.maximo_wo,
    objectCode: p.object_code,
    subsidiary: p.subsidiary,
    adminName: p.admin_name,
    adminMatched: Boolean(activeAdminMatch(p.admin_name)),
    urgent: Boolean(p.urgent),
    urgentNotes: p.urgent_notes,
    lifecycleStatus: p.lifecycle_status,
    missingFromImport: Boolean(p.missing_from_import),
    firstImportedAt: p.first_imported_at,
    lastSeenAt: p.last_seen_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function listPos(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.lifecycleStatus) {
    clauses.push("lifecycle_status = ?");
    params.push(filters.lifecycleStatus);
  }
  if (filters.vendorId) {
    clauses.push("vendor_id = ?");
    params.push(Number(filters.vendorId));
  }
  if (filters.locationCode) {
    clauses.push("location_code = ?");
    params.push(filters.locationCode);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.vendorUnmatched) {
    clauses.push("vendor_id IS NULL");
  }
  if (filters.regionUnassigned) {
    clauses.push("region IS NULL");
  }
  // "Admin on the PO file isn't a real account yet" -- the same name match
  // activeAdminMatch does, just as a SQL subquery so it can filter at the
  // list level. Surfaces exactly who still needs to be added to the Roster
  // for poTerritory to pick them up.
  if (filters.adminUnmatched) {
    clauses.push(
      `(admin_name IS NOT NULL AND TRIM(admin_name) != '' AND NOT EXISTS (
        SELECT 1 FROM technicians t
        WHERE t.role = 'admin' AND t.employment_status = 'active'
        AND LOWER(TRIM(t.name)) = LOWER(TRIM(pos.admin_name))
      ))`
    );
  }
  // "Cut with WOM coding but no WOM # listed": the real PO Request Tracking
  // export carries E1 WOM Job # and WOM Number as two separate columns --
  // a PO can have the former (coded as WOM-type work in E1) without the
  // latter ever being filled in. WOM coding can also show up through the
  // E&F or PPS Job # field instead, when it's actually a location's own
  // WOM job number typed into the wrong column -- same gap either way. See
  // poMissingWomLink for the JS-side equivalent used by the live task.
  if (filters.womLinkMissing) {
    clauses.push(`(
      (wom_number IS NULL OR wom_number = '') AND (
        (e1_wom_job_number IS NOT NULL AND e1_wom_job_number != '') OR
        (ef_job_number IS NOT NULL AND ef_job_number IN (SELECT wom_job_number FROM locations WHERE wom_job_number IS NOT NULL AND wom_job_number != '')) OR
        (pps_job_number IS NOT NULL AND pps_job_number IN (SELECT wom_job_number FROM locations WHERE wom_job_number IS NOT NULL AND wom_job_number != ''))
      )
    )`);
  }
  if (filters.womNumber) {
    clauses.push("wom_number = ?");
    params.push(filters.womNumber);
  }
  if (filters.search) {
    clauses.push("(vendor_name LIKE ? OR description LIKE ? OR po_number LIKE ? OR requestor LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM pos ${where} ORDER BY date_requested DESC, id DESC`)
    .all(...params)
    .map(presentPoRow);
  return attachOpenReclassFlags(rows);
}

// Which of these POs already has an open (not yet confirmed-posted or
// dismissed) reclass item flagged against it -- a single bulk lookup rather
// than one query per row, since the Budget PO Tracker's list can run to a
// few hundred rows.
function attachOpenReclassFlags(poRows) {
  if (poRows.length === 0) return poRows;
  const flaggedIds = new Set(
    db
      .prepare("SELECT DISTINCT related_po_id FROM reclass_items WHERE related_po_id IS NOT NULL AND status NOT IN ('confirmed_posted', 'dismissed')")
      .all()
      .map((r) => r.related_po_id)
  );
  return poRows.map((p) => ({ ...p, hasOpenReclassFlag: flaggedIds.has(p.id) }));
}

function findPo(id) {
  const row = db.prepare("SELECT * FROM pos WHERE id = ?").get(Number(id));
  if (!row) return null;
  return attachOpenReclassFlags([presentPoRow(row)])[0];
}

function getLastPoImport() {
  return db.prepare("SELECT * FROM po_imports ORDER BY id DESC LIMIT 1").get() || null;
}

// "PO Request Task #<id>" -- the exact text the request-po confirmation
// screen tells a tech/admin to copy into the Smartsheet form's Description
// field (see techHome.js/pos.js's renderRequestPoConfirmation). Matched
// case-insensitively since it's hand-typed into an external form.
const PO_REQUEST_TASK_REF_RE = /PO Request Task #(\d+)/i;

// Closes the loop a manual copy-paste reference opens: once the real PO
// shows up in a tracker import carrying that reference in its Description,
// this links the originating po_request task to it automatically, so the
// admin can see which real PO resulted from a given request without having
// to search for it by eye. Silently does nothing if the description has no
// reference, the referenced task doesn't exist, isn't a po_request task, or
// is already linked to this same PO (an unmatched/wrong-category reference
// is far more likely to be a tech's typo or a copy of something else than
// a real attack surface, so this fails quiet rather than erroring the
// whole import over one bad row).
function linkPoRequestTaskFromImport(poId, description, importedBy) {
  if (!description) return;
  const match = String(description).match(PO_REQUEST_TASK_REF_RE);
  if (!match) return;
  const taskId = Number(match[1]);
  const task = findTask(taskId);
  if (!task || task.category !== "po_request" || task.matched_po_id === poId) return;
  db.prepare("UPDATE tasks SET matched_po_id = ? WHERE id = ?").run(poId, taskId);
  addAudit(
    importedBy,
    "PO_REQUEST_TASK_MATCHED",
    `PO import matched task #${taskId} ("${task.title}") to PO #${poId} via its Description reference`
  );
}

// The shared engine behind both the import preview and the real import --
// identical logic either way, run inside a transaction that's committed for
// a real import and rolled back for a preview, so "what would happen" can
// never drift from what actually happens.
function runPoImport(rows, importedBy, { dryRun }) {
  const now = new Date().toISOString();
  const touchedIds = new Set();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let invalid = 0;

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const poNumberRaw = row.poNumber == null ? "" : String(row.poNumber).trim();
      const hasAnyContent = row.description || row.vendorName || poNumberRaw || row.requestor;
      if (!hasAnyContent) {
        invalid++;
        continue;
      }

      const { compositeKey, poNumberKey } = computePoMatchKeys(row);
      const lineNumber = row.lineNumber || null;

      // Line position is tried first -- see the pos table comment: Krista
      // edits a row's vendor/description text in place once she's corrected
      // a vendor number, which can change what composite_key that row would
      // compute to, so matching by line_number lets that edit still land on
      // the same record. It's only trusted when the requestor on file still
      // matches, though -- a row deleted/inserted elsewhere in the sheet
      // shifts every later line_number down or up by one, and without that
      // guard this would silently hijack a since-shifted, unrelated record
      // instead of falling through to the key-based lookup below.
      let existing = null;
      if (lineNumber) {
        const byLine = db.prepare("SELECT * FROM pos WHERE line_number = ?").get(lineNumber);
        if (byLine && normalizeMatchText(byLine.requestor) === normalizeMatchText(row.requestor)) {
          existing = byLine;
        }
      }
      // The real PO Number, once one exists, is the next most specific
      // identity -- try it before the composite key. Falling back to the
      // composite key (never the other way around) is what makes the
      // "promotion" below safe: it only ever adds a po_number_key to a
      // record the composite key already owns, it never moves/renames that
      // record's composite_key, so any other row in this same tracker still
      // sharing that composite identity (a not-yet-PO'd duplicate of this
      // exact request) keeps finding it too.
      if (!existing) existing = poNumberKey ? db.prepare("SELECT * FROM pos WHERE po_number_key = ?").get(poNumberKey) : null;
      if (!existing) existing = db.prepare("SELECT * FROM pos WHERE composite_key = ?").get(compositeKey);

      const efJobNumber = parseEfJobNumber(row.efJobNumberRaw);
      const matchedLocation = efJobNumber ? findLocationByEfJobNumber(efJobNumber) : null;
      const matchedVendor = row.vendorNumber ? findVendorByNumber(row.vendorNumber) : null;

      if (existing) {
        touchedIds.add(existing.id);
        const changed =
          existing.po_number !== (poNumberRaw || null) ||
          existing.description !== (row.description || null) ||
          existing.po_amount !== (row.poAmount == null ? null : row.poAmount) ||
          existing.status !== (row.status || null) ||
          existing.change_order !== (row.changeOrder || null) ||
          existing.vendor_name !== (row.vendorName || null) ||
          existing.vendor_number !== (row.vendorNumber || null);

        db.prepare(
          `UPDATE pos SET
            po_number_key = COALESCE(po_number_key, ?),
            line_number = ?,
            po_number = ?, date_requested = ?, requestor = ?, description = ?,
            ef_job_number_raw = ?, ef_job_number = ?,
            location_code = COALESCE(location_code, ?),
            region = COALESCE(region, ?),
            po_amount = ?, change_order = ?, status = ?, vendor_name = ?, vendor_number = ?,
            vendor_id = COALESCE(vendor_id, ?),
            pps_job_number = ?, e1_wom_job_number = ?, wom_number = ?, asset_number = ?, maximo_wo = ?,
            object_code = ?, subsidiary = ?, admin_name = ?, urgent = ?, urgent_notes = ?,
            missing_from_import = 0, last_seen_at = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          poNumberKey,
          lineNumber,
          poNumberRaw || null,
          row.dateRequested || null,
          row.requestor || null,
          row.description || null,
          row.efJobNumberRaw || null,
          efJobNumber,
          matchedLocation ? matchedLocation.code : null,
          matchedLocation ? matchedLocation.territory || null : null,
          row.poAmount == null ? null : row.poAmount,
          row.changeOrder || null,
          row.status || null,
          row.vendorName || null,
          row.vendorNumber || null,
          matchedVendor ? matchedVendor.id : null,
          row.ppsJobNumber || null,
          row.e1WomJobNumber || null,
          row.womNumber || null,
          row.assetNumber || null,
          row.maximoWo || null,
          row.objectCode || null,
          row.subsidiary || null,
          row.adminName || null,
          row.urgent ? 1 : 0,
          row.urgentNotes || null,
          now,
          now,
          existing.id
        );
        maybeAutoActivatePo(existing.id);
        refreshPoWomLinkTask(existing.id);
        refreshPoJobNumberTypeMismatchTask(existing.id);
        refreshPoWomLocationMismatchTask(existing.id);
        refreshGlMismatchFlagsForPo(existing.id);
        linkPoRequestTaskFromImport(existing.id, row.description, importedBy);
        if (changed) updated++;
        else unchanged++;
      } else {
        const result = db
          .prepare(
            `INSERT INTO pos (
              composite_key, po_number_key, line_number, po_number, date_requested, requestor, description,
              ef_job_number_raw, ef_job_number, location_code, region,
              po_amount, change_order, status, vendor_name, vendor_number, vendor_id,
              pps_job_number, e1_wom_job_number, wom_number, asset_number, maximo_wo,
              object_code, subsidiary, admin_name, urgent, urgent_notes,
              lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_organization', ?, ?, ?, ?)`
          )
          .run(
            compositeKey,
            poNumberKey,
            lineNumber,
            poNumberRaw || null,
            row.dateRequested || null,
            row.requestor || null,
            row.description || null,
            row.efJobNumberRaw || null,
            efJobNumber,
            matchedLocation ? matchedLocation.code : null,
            matchedLocation ? matchedLocation.territory || null : null,
            row.poAmount == null ? null : row.poAmount,
            row.changeOrder || null,
            row.status || null,
            row.vendorName || null,
            row.vendorNumber || null,
            matchedVendor ? matchedVendor.id : null,
            row.ppsJobNumber || null,
            row.e1WomJobNumber || null,
            row.womNumber || null,
            row.assetNumber || null,
            row.maximoWo || null,
            row.objectCode || null,
            row.subsidiary || null,
            row.adminName || null,
            row.urgent ? 1 : 0,
            row.urgentNotes || null,
            now,
            now,
            now,
            now
          );
        touchedIds.add(Number(result.lastInsertRowid));
        maybeAutoActivatePo(Number(result.lastInsertRowid));
        refreshPoWomLinkTask(Number(result.lastInsertRowid));
        refreshPoJobNumberTypeMismatchTask(Number(result.lastInsertRowid));
        refreshPoWomLocationMismatchTask(Number(result.lastInsertRowid));
        linkPoRequestTaskFromImport(Number(result.lastInsertRowid), row.description, importedBy);
        created++;
      }
    }

    // Anything on file from a previous import that this run didn't touch at
    // all is flagged, never deleted -- the source row may have simply been
    // deleted/moved in the tracker, and that's for a person to review, not
    // for an import to decide on its own.
    const allIds = db.prepare("SELECT id FROM pos").all().map((r) => r.id);
    const missingIds = allIds.filter((id) => !touchedIds.has(id));
    for (const id of missingIds) {
      db.prepare("UPDATE pos SET missing_from_import = 1 WHERE id = ?").run(id);
    }
    // A record that WAS missing but reappeared in this import is un-flagged
    // by the normal update path above (missing_from_import = 0 is part of
    // every UPDATE), so no extra step is needed for that direction.

    const summary = {
      totalRows: rows.length,
      createdCount: created,
      updatedCount: updated,
      unchangedCount: unchanged,
      missingCount: missingIds.length,
      invalidCount: invalid,
    };

    if (dryRun) {
      db.exec("ROLLBACK");
    } else {
      db.prepare(
        "INSERT INTO po_imports (imported_by, imported_at, total_rows, created_count, updated_count, unchanged_count, missing_count, invalid_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(importedBy, now, summary.totalRows, created, updated, unchanged, missingIds.length, invalid);
      db.exec("COMMIT");
    }
    return summary;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// A record has nothing left for Krista to confirm once it has a real PO
// Number, a matched location, and a matched vendor -- at that point sitting
// in Needs Organization is just friction, not a safeguard, so it's moved to
// Active automatically. Never fires the other way (doesn't touch an
// already-Active record, and never un-activates one), and never overrides a
// still-needs_organization record missing any of the three -- those still
// need either a real match or Krista's own manual Move to Active call.
function isPoFullyResolved(po) {
  return Boolean(po.po_number && /^\d+$/.test(String(po.po_number).trim()) && po.location_code && po.vendor_id);
}

function maybeAutoActivatePo(id) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(id);
  if (po && po.lifecycle_status === "needs_organization" && isPoFullyResolved(po)) {
    db.prepare("UPDATE pos SET lifecycle_status = 'active', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }
}

function poWomLinkTaskSourceKey(poId) {
  return `PO-${poId}-MISSING-WOM-LINK`;
}

// Same real-column gap as listPos' womLinkMissing filter: E1 WOM Job # and
// WOM Number are separate fields on the PO Request Tracking export, and a
// PO can carry the former without the latter ever getting filled in. WOM
// coding doesn't only show up in E1 WOM Job #, though -- a location's own
// WOM job number can just as easily get typed into the E&F or PPS Job #
// field instead (the same wrong-field situation po_job_number_type_mismatch
// flags), and that's just as much "WOM work with no WOM # on file" as the
// E1 case is. Returns which field carried the WOM coding, or null if this
// PO isn't WOM-coded at all (or already has its WOM Number).
function poMissingWomLink(po) {
  if (po.wom_number && String(po.wom_number).trim()) return null;
  if (po.e1_wom_job_number && String(po.e1_wom_job_number).trim()) {
    return { field: "E1 WOM Job #", value: po.e1_wom_job_number };
  }
  const ef = po.ef_job_number ? String(po.ef_job_number).trim() : null;
  const pps = po.pps_job_number ? String(po.pps_job_number).trim() : null;
  const findByWomJobNumber = db.prepare("SELECT 1 FROM locations WHERE wom_job_number = ?");
  if (ef && findByWomJobNumber.get(ef)) return { field: "E&F Job #", value: ef };
  if (pps && findByWomJobNumber.get(pps)) return { field: "PPS Job #", value: pps };
  return null;
}

// Mirrors refreshVendorComplianceTask's pattern: a task that tracks a live
// condition, created the moment the gap appears and auto-completed the
// moment it's fixed (by correcting the WOM Number in the source file and
// re-importing -- there's no manual per-field PO edit, matching this
// screen's existing "nothing here is guessed" / import-is-truth model).
// Only checked once a PO is Active: a still-needs_organization record
// already has its own catch-all task, and flagging a WOM gap before it's
// even been looked at would just be noise on top of that.
function refreshPoWomLinkTask(poId) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(poId);
  if (!po) return;
  const sourceKey = poWomLinkTaskSourceKey(poId);
  const gap = po.lifecycle_status === "active" ? poMissingWomLink(po) : null;
  if (gap) {
    upsertTaskBySourceKey(sourceKey, {
      title: `Confirm WOM # for PO ${po.po_number || poId}`,
      description: `This PO has a ${gap.field} (${gap.value}) but no WOM Number recorded -- confirm which WOM this ties back to and correct it in the next PO Tracker import.`,
      category: "po_wom_link",
      assignedRole: "financial",
      priority: "normal",
      relatedPoId: poId,
      source: "po_wom_link",
      sourceRecordId: String(poId),
      workflowRule: "po_wom_link",
    });
  } else {
    completeTaskBySourceKey(sourceKey);
  }
}

function refreshAllPoWomLinkTasks() {
  for (const row of db.prepare("SELECT id FROM pos WHERE lifecycle_status = 'active'").all()) {
    refreshPoWomLinkTask(row.id);
  }
}

// Keeps a PO's already-matched GL lines' precomputed mismatch flags correct
// when the PO's own subsidiary/object code gets corrected in a later PO
// Tracker import -- without this, a fix made here would only show up in GL
// Reconciliation after the next GL re-import, since gl_entries rows aren't
// otherwise touched by a PO import. No-ops instantly for a PO with no
// matched GL lines yet (the common case for a brand-new PO).
function refreshGlMismatchFlagsForPo(poId) {
  const po = db.prepare("SELECT subsidiary, object_code FROM pos WHERE id = ?").get(poId);
  if (!po) return;
  const lines = db.prepare("SELECT id, subsidiary, object_account_code FROM gl_entries WHERE matched_po_id = ?").all(poId);
  if (lines.length === 0) return;
  const poSubsidiaryCode = parseObjectAccountCode(po.subsidiary);
  const poObjectCode = parseObjectAccountCode(po.object_code);
  const stmt = db.prepare("UPDATE gl_entries SET subsidiary_mismatch = ?, object_code_mismatch = ? WHERE id = ?");
  for (const line of lines) {
    const subsidiaryMismatch = poSubsidiaryCode && line.subsidiary && String(line.subsidiary) !== poSubsidiaryCode ? 1 : 0;
    const objectCodeMismatch = poObjectCode && line.object_account_code && String(line.object_account_code) !== poObjectCode ? 1 : 0;
    stmt.run(subsidiaryMismatch, objectCodeMismatch, line.id);
  }
}

function confirmPoVendor(id, vendorId) {
  const vendor = findVendor(vendorId);
  if (!vendor) throw new Error("Vendor not found");
  db.prepare("UPDATE pos SET vendor_id = ?, vendor_link_confirmed = 1, updated_at = ? WHERE id = ?").run(
    vendorId,
    new Date().toISOString(),
    id
  );
  maybeAutoActivatePo(id);
  return findPo(id);
}

function clearPoVendorMatch(id) {
  // Lets an admin undo a wrong auto-match/confirmation -- back to "needs
  // matching" so it shows up in that filter again, picked up by the next
  // bulk-confirm or hand-matched to the right vendor instead.
  db.prepare("UPDATE pos SET vendor_id = NULL, vendor_link_confirmed = 0, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return findPo(id);
}

// Re-resolves every PO carrying this E&F job # against whatever location is
// now tagged with it -- not just the one PO an admin was looking at, since
// the same job # commonly shows up on several PO lines. Mirrors the
// matching runPoImport already does at import time, just run on demand the
// moment a location gets tagged instead of waiting for the next import.
function resolvePosForJobNumber(jobNumber) {
  const location = findLocationByEfJobNumber(jobNumber);
  if (!location) return;
  const rows = db.prepare("SELECT id FROM pos WHERE ef_job_number = ?").all(jobNumber);
  const now = new Date().toISOString();
  for (const row of rows) {
    db.prepare("UPDATE pos SET location_code = ?, region = ?, region_confirmed = 1, updated_at = ? WHERE id = ?").run(
      location.code,
      location.territory || null,
      now,
      row.id
    );
    maybeAutoActivatePo(row.id);
  }
}

// Replaces the old assignPoRegion, which let an admin type a bare region
// directly onto one PO -- that never touched location_code, so the PO could
// never actually finish resolving (see isPoFullyResolved), and it did
// nothing for every other PO sharing the same real-world job site. This
// tags an actual Location with the PO's own E&F job #, the same field
// runPoImport already matches locations by, so the fix is permanent and
// shared across every PO (past and future) carrying that job #.
function tagLocationForPo(poId, { locationCode, newLocation } = {}) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(Number(poId));
  if (!po) throw new Error("PO not found");
  if (!po.ef_job_number) throw new Error("This PO has no E&F Contract Job # on file to tag a location with");

  if (newLocation) {
    if (!newLocation.code || !String(newLocation.code).trim()) throw new Error("A new location needs a code");
    if (!newLocation.name || !String(newLocation.name).trim()) throw new Error("A new location needs a name");
    if (findLocation(newLocation.code)) throw new Error(`Location ${newLocation.code} already exists`);
    if (!newLocation.territory) throw new Error("A new location needs a territory");
    createLocation(newLocation.code.trim(), newLocation.name.trim(), po.ef_job_number, null, null, newLocation.territory);
  } else if (locationCode) {
    const location = findLocation(locationCode);
    if (!location) throw new Error("Location not found");
    if (location.ef_job_number && location.ef_job_number !== po.ef_job_number) {
      throw new Error(`${location.name} is already tagged with a different job # (${location.ef_job_number})`);
    }
    setLocationDetails(location.code, {
      name: location.name,
      efJobNumber: po.ef_job_number,
      region: location.region,
      womJobNumber: location.wom_job_number,
      territory: location.territory,
    });
  } else {
    throw new Error("locationCode or newLocation is required");
  }

  resolvePosForJobNumber(po.ef_job_number);
  return findPo(poId);
}

function bulkConfirmPoVendor(ids, vendorId) {
  return ids.map((id) => confirmPoVendor(id, vendorId));
}

// The one explicit switch from Needs Organization to Active -- never a side
// effect of matching a vendor or assigning a region. Tasks already linked
// to this PO (created while it was still being organized) become visible in
// task lists the moment lifecycle_status flips, via listTasks' own join --
// no separate "activate its tasks" step needed, and nothing is duplicated
// since they're the same rows all along.
function movePoToActive(id) {
  db.prepare("UPDATE pos SET lifecycle_status = 'active', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return findPo(id);
}

function bulkMovePoToActive(ids) {
  return ids.map((id) => movePoToActive(id));
}

// Every task linked to this PO, any status -- the PO detail page's own
// Tasks section. Unlike listTasks, this is never filtered by
// lifecycle_status: the PO's own detail page is one of the two places
// (alongside the Needs Organization tab) a pre-activation task is allowed
// to be seen from.
function listPoTasks(poId) {
  return db.prepare("SELECT * FROM tasks WHERE related_po_id = ? ORDER BY id DESC").all(poId);
}

// Flags vendors doing real business with us (they show up on a PO, by name
// AND a JDE Vendor #) who have no vendor profile on file at all -- distinct
// from "Needs matching" in the PO tracker, which also covers a PO missing a
// vendor number entirely. Grouped by vendor_number (the stable identity),
// never by name, same reasoning as everywhere else vendor matching happens
// in this app. Covers POs in either lifecycle state -- whether this
// particular PO record has been organized yet doesn't change the fact that
// this vendor itself has no profile.
function listUnregisteredPoVendors() {
  return db
    .prepare(
      `SELECT
         vendor_number AS vendorNumber,
         (SELECT p2.vendor_name FROM pos p2
           WHERE p2.vendor_number = p.vendor_number AND p2.vendor_id IS NULL
           ORDER BY p2.last_seen_at DESC LIMIT 1) AS vendorName,
         COUNT(*) AS poCount,
         SUM(po_amount) AS totalAmount
       FROM pos p
       WHERE vendor_id IS NULL AND vendor_number IS NOT NULL AND vendor_number != ''
         AND vendor_number NOT IN (
           SELECT jde_vendor_number FROM vendors WHERE jde_vendor_number IS NOT NULL AND jde_vendor_number != ''
         )
       GROUP BY vendor_number
       ORDER BY poCount DESC`
    )
    .all();
}

function poVendorUnregisteredTaskSourceKey(vendorNumber) {
  return `VENDOR-UNREGISTERED-${vendorNumber}`;
}

// Both PO-discrepancy task types (an unregistered vendor # and a GL/PO
// coding mismatch) get a 3-day SLA due date the moment they're first
// opened -- preserveDueAtOnUpdate below means every later lazy refresh
// leaves that original due date alone, so it behaves like any other task's
// due date (flagged overdue once it passes) rather than resetting the
// clock every time the page loads.
const PO_DISCREPANCY_SLA_MS = 3 * 24 * 60 * 60 * 1000;

// Tasks the admin who owns the most recently seen unmatched PO for each
// unregistered vendor # (see listUnregisteredPoVendors) to create or update
// that vendor's profile. One task per vendor_number group, not per PO --
// the same vendor can show up on several POs, and it's one profile that
// needs creating either way. Same "still task it, just unassigned, with the
// raw name kept for manual routing" treatment as the other PO-driven tasks
// when the Admin column doesn't match a real account.
function refreshAllUnregisteredVendorTasks() {
  const groups = listUnregisteredPoVendors();
  const stillOpen = new Set(groups.map((g) => g.vendorNumber));

  for (const g of groups) {
    const representativePo = db
      .prepare(
        `SELECT id, po_number, admin_name FROM pos
         WHERE vendor_number = ? AND vendor_id IS NULL
         ORDER BY last_seen_at DESC LIMIT 1`
      )
      .get(g.vendorNumber);
    const matchedAdmin = representativePo ? matchAdminByName(representativePo.admin_name) : null;
    const totalAmount = `$${Number(g.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    upsertTaskBySourceKey(poVendorUnregisteredTaskSourceKey(g.vendorNumber), {
      title: `Create a vendor profile for ${g.vendorName || `Vendor #${g.vendorNumber}`} (Vendor # ${g.vendorNumber})`,
      description:
        `Shows up on ${g.poCount} Budget PO${g.poCount === 1 ? "" : "s"} (${totalAmount} total) by name and JDE Vendor # but has no vendor profile here yet.` +
        (representativePo && representativePo.admin_name && !matchedAdmin
          ? ` The Budget PO Tracker lists "${representativePo.admin_name}" as the admin on the most recent one, but that name doesn't match any admin account -- route this manually.`
          : ""),
      category: "po_vendor_unregistered",
      assignedTo: matchedAdmin ? matchedAdmin.id : null,
      assignedRole: matchedAdmin ? "admin" : null,
      relatedPoId: representativePo ? representativePo.id : null,
      priority: "normal",
      source: "po_vendor_unregistered",
      sourceRecordId: g.vendorNumber,
      workflowRule: "po_vendor_unregistered",
      dueAt: new Date(Date.now() + PO_DISCREPANCY_SLA_MS).toISOString(),
    }, { preserveDueAtOnUpdate: true });
  }

  // A vendor # that was unregistered last time this ran but isn't anymore
  // (a profile got created or it got matched) -- clear its task rather than
  // leaving it open forever.
  const openTasks = db
    .prepare("SELECT source_key FROM tasks WHERE category = 'po_vendor_unregistered' AND status NOT IN ('completed', 'cancelled')")
    .all();
  for (const row of openTasks) {
    const vendorNumber = row.source_key.replace("VENDOR-UNREGISTERED-", "");
    if (!stillOpen.has(vendorNumber)) completeTaskBySourceKey(row.source_key);
  }
}

function poCodingDriftTaskSourceKey(poId) {
  return `PO-${poId}-CODING-DRIFT`;
}

// The GL is the latest real record of what actually got coded to a PO --
// the Budget PO Tracker's own object code/subsidiary (whatever Smartsheet
// says) can drift out of date after the real work happened (a mid-stream
// change, a correction made directly in JDE) without anyone updating the
// tracker to match. Flags this PO's own admin (same name-matching as the
// reclass-Smartsheet-update task) the moment any GL line posted against it
// shows a different object code or subsidiary than what's on file, naming
// the GL's own value as what needs to replace what's in Smartsheet.
// Clears itself the instant the mismatch resolves -- either the PO gets
// corrected to match (see refreshGlMismatchFlagsForPo, called from the same
// PO-import path that would fix this), or a later GL import corrects the
// line. Runs lazily off whatever GL activity already exists -- never a
// trigger of its own -- so it naturally re-evaluates every time more GL
// reports come in and get matched to POs.
function refreshPoCodingDriftTask(poId) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(poId);
  if (!po) return;
  const sourceKey = poCodingDriftTaskSourceKey(poId);
  const mismatchedLine = db
    .prepare(
      `SELECT * FROM gl_entries WHERE matched_po_id = ? AND (subsidiary_mismatch = 1 OR object_code_mismatch = 1)
       ORDER BY gl_date DESC, id DESC LIMIT 1`
    )
    .get(poId);
  if (!mismatchedLine) {
    completeTaskBySourceKey(sourceKey);
    return;
  }
  const diffs = [];
  if (mismatchedLine.object_code_mismatch) {
    diffs.push(
      `object code: GL shows "${mismatchedLine.object_account || mismatchedLine.object_account_code}" -- we have "${po.object_code || "nothing"}" on file`
    );
  }
  if (mismatchedLine.subsidiary_mismatch) {
    diffs.push(`subsidiary: GL shows "${mismatchedLine.subsidiary}" -- we have "${po.subsidiary || "nothing"}" on file`);
  }
  const matchedAdmin = matchAdminByName(po.admin_name);
  upsertTaskBySourceKey(sourceKey, {
    title: `Update Smartsheet coding for PO ${po.po_number || poId}`,
    description:
      `A GL report shows this PO's ${diffs.join(" and ")}. The GL is the latest real posting -- update the PO's coding on the Smartsheet tracker to match.` +
      (po.admin_name && !matchedAdmin
        ? ` The Budget PO Tracker lists "${po.admin_name}" as this PO's admin, but that name doesn't match any admin account -- route this manually.`
        : ""),
    category: "po_coding_drift",
    assignedTo: matchedAdmin ? matchedAdmin.id : null,
    assignedRole: matchedAdmin ? "admin" : null,
    relatedPoId: poId,
    priority: "normal",
    source: "po_coding_drift",
    sourceRecordId: String(poId),
    workflowRule: "po_coding_drift",
    dueAt: new Date(Date.now() + PO_DISCREPANCY_SLA_MS).toISOString(),
  }, { preserveDueAtOnUpdate: true });
}

function refreshAllPoCodingDriftTasks() {
  const rows = db.prepare("SELECT DISTINCT matched_po_id AS id FROM gl_entries WHERE matched_po_id IS NOT NULL").all();
  for (const row of rows) refreshPoCodingDriftTask(row.id);
}

function poJobNumberTypeMismatchTaskSourceKey(poId) {
  return `PO-${poId}-JOB-NUMBER-TYPE-MISMATCH`;
}

// A location carries three DIFFERENT JDE job numbers (E&F Contract Job
// Number, PPS Contract Job Number, E1 WOM Job Number -- see the comments on
// the locations table above) for three different accounting purposes. The
// Budget PO Tracker's "E&F Job #" and "PPS Job #" columns are supposed to
// each carry the matching type for that PO's own location -- this flags the
// real, checkable data-entry error of one column holding a job number that
// does belong to a real location, just under the WRONG type (e.g. a
// location's PPS number typed into the E&F Job # column). A number that
// doesn't belong to any location at all under any type isn't this check's
// job -- that's a plain unmatched-location gap, not a wrong-type one.
function poJobNumberTypeMismatch(po) {
  const ef = po.ef_job_number ? String(po.ef_job_number).trim() : null;
  const pps = po.pps_job_number ? String(po.pps_job_number).trim() : null;
  if (ef) {
    const wrongType = db
      .prepare(
        `SELECT code, name FROM locations
         WHERE (pps_job_number = ? OR wom_job_number = ?) AND (ef_job_number IS NULL OR ef_job_number != ?)`
      )
      .get(ef, ef, ef);
    if (wrongType) return { field: "E&F Job #", value: ef, location: wrongType };
  }
  if (pps) {
    const wrongType = db
      .prepare(
        `SELECT code, name FROM locations
         WHERE (ef_job_number = ? OR wom_job_number = ?) AND (pps_job_number IS NULL OR pps_job_number != ?)`
      )
      .get(pps, pps, pps);
    if (wrongType) return { field: "PPS Job #", value: pps, location: wrongType };
  }
  return null;
}

// Only checked once a PO is Active, same reasoning as refreshPoWomLinkTask
// -- a still-needs_organization record already has its own catch-all task.
function refreshPoJobNumberTypeMismatchTask(poId) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(poId);
  if (!po) return;
  const sourceKey = poJobNumberTypeMismatchTaskSourceKey(poId);
  const mismatch = po.lifecycle_status === "active" ? poJobNumberTypeMismatch(po) : null;
  if (!mismatch) {
    completeTaskBySourceKey(sourceKey);
    return;
  }
  const matchedAdmin = matchAdminByName(po.admin_name);
  upsertTaskBySourceKey(
    sourceKey,
    {
      title: `Fix ${mismatch.field} on PO ${po.po_number || poId}`,
      description:
        `This PO's ${mismatch.field} (${mismatch.value}) is actually ${mismatch.location.name}'s job number for a different type -- correct the coding on the Smartsheet tracker.` +
        (po.admin_name && !matchedAdmin
          ? ` The Budget PO Tracker lists "${po.admin_name}" as this PO's admin, but that name doesn't match any admin account -- route this manually.`
          : ""),
      category: "po_job_number_type_mismatch",
      assignedTo: matchedAdmin ? matchedAdmin.id : null,
      assignedRole: matchedAdmin ? "admin" : null,
      relatedPoId: poId,
      priority: "normal",
      source: "po_job_number_type_mismatch",
      sourceRecordId: String(poId),
      workflowRule: "po_job_number_type_mismatch",
      dueAt: new Date(Date.now() + PO_DISCREPANCY_SLA_MS).toISOString(),
    },
    { preserveDueAtOnUpdate: true }
  );
}

function refreshAllPoJobNumberTypeMismatchTasks() {
  for (const row of db.prepare("SELECT id FROM pos WHERE lifecycle_status = 'active'").all()) {
    refreshPoJobNumberTypeMismatchTask(row.id);
  }
}

function poWomLocationMismatchTaskSourceKey(poId) {
  return `PO-${poId}-WOM-LOCATION-MISMATCH`;
}

// A PO's own WOM Number should belong to the same location the PO itself is
// coded to -- the WOM's location_code (its own Smartsheet-synced project
// location, not anything this app guesses) is the source of truth to check
// against. A mismatch here means either the PO's location or its WOM # is
// wrong in the tracker; only meaningful once the PO actually has both a
// resolved location and a WOM # on file.
function poWomLocationMismatch(po) {
  if (!po.wom_number || !po.location_code) return null;
  const wom = db.prepare("SELECT code, location_code FROM woms WHERE code = ?").get(po.wom_number);
  if (!wom || !wom.location_code || wom.location_code === po.location_code) return null;
  return wom;
}

// Only checked once a PO is Active, same reasoning as the job-number-type
// check above.
function refreshPoWomLocationMismatchTask(poId) {
  const po = db.prepare("SELECT * FROM pos WHERE id = ?").get(poId);
  if (!po) return;
  const sourceKey = poWomLocationMismatchTaskSourceKey(poId);
  const mismatch = po.lifecycle_status === "active" ? poWomLocationMismatch(po) : null;
  if (!mismatch) {
    completeTaskBySourceKey(sourceKey);
    return;
  }
  const matchedAdmin = matchAdminByName(po.admin_name);
  upsertTaskBySourceKey(
    sourceKey,
    {
      title: `Confirm WOM # ${po.wom_number} on PO ${po.po_number || poId}`,
      description:
        `This PO is coded to location ${po.location_code}, but WOM ${po.wom_number} is synced to a different location (${mismatch.location_code}) -- confirm which is right and correct it in the next PO Tracker import.` +
        (po.admin_name && !matchedAdmin
          ? ` The Budget PO Tracker lists "${po.admin_name}" as this PO's admin, but that name doesn't match any admin account -- route this manually.`
          : ""),
      category: "po_wom_location_mismatch",
      assignedTo: matchedAdmin ? matchedAdmin.id : null,
      assignedRole: matchedAdmin ? "admin" : null,
      relatedPoId: poId,
      priority: "normal",
      source: "po_wom_location_mismatch",
      sourceRecordId: String(poId),
      workflowRule: "po_wom_location_mismatch",
      dueAt: new Date(Date.now() + PO_DISCREPANCY_SLA_MS).toISOString(),
    },
    { preserveDueAtOnUpdate: true }
  );
}

function refreshAllPoWomLocationMismatchTasks() {
  for (const row of db.prepare("SELECT id FROM pos WHERE lifecycle_status = 'active'").all()) {
    refreshPoWomLocationMismatchTask(row.id);
  }
}

// ---- GL import / PO reconciliation ----
//
// Matches a monthly GL extract against the Budget PO Tracker by PO number
// (the GL's own "Purchase Order" column -- a real JDE field, not inferred),
// to answer the two things the PO Tracker alone can't: what actually got
// paid against a PO (vs. what it was approved for), and whether the GL
// posting used the same object/subsidiary code the PO itself specifies.

function normalizePoNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isNaN(n) && String(raw).trim() !== "") return String(Math.trunc(n));
  return String(raw).trim() || null;
}

// "601000 - Events~Labor" -> "601000" -- the numeric object code prefix,
// comparable against the PO Tracker's own object_code field.
function parseObjectAccountCode(raw) {
  if (raw == null) return null;
  const match = String(raw).match(/^\s*(\d+)/);
  return match ? match[1] : null;
}

// The chart-of-accounts label a GL line's Object Account already carries
// after its cost-center infix -- "647200 - Gen B&A~Cell Phone" -> "Cell
// Phone". This is the category a Spend Breakdown pie slice/legend row is
// grouped by (see getGlSpendBreakdown): the same category name recurs
// across every cost center that uses it, so e.g. every "~Cell Phone" line
// collapses into one "Cell Phone" slice regardless of which department's
// cost center it posted under.
function parseObjectAccountCategory(raw) {
  if (raw == null) return null;
  const match = String(raw).match(/~\s*(.+)$/);
  return match ? match[1].trim() : null;
}

// Krista's real C&W Services Monthly Closing Schedule (CW-Services-CY2026,
// the actual uploaded file) -- period number lines up exactly with the
// calendar month (period 7 = July), confirmed directly against that
// document for both FY25 and FY26. hfmCorporateLoad is the last close
// milestone for that period (HFM/Corporate Load EOD) -- the point at which
// that month's GL is genuinely final, not just "month-end passed."
// womCloseDate is that same document's own WOM close deadline for the
// period, for later use anywhere a reclass/WOM cutoff needs to key off the
// real close calendar instead of a guessed month-end. Only FY25-FY26 are
// seeded (what that document covers); once a later year's calendar is
// published, add its rows here the same way, not a new mechanism.
// A function (not a top-level const) so migration-time code elsewhere in
// this file can call it safely regardless of where in the file that
// migration happens to sit -- a `const` here would still be in its temporal
// dead zone if referenced from a migration positioned earlier in the file,
// where a hoisted function declaration works fine (same reasoning as
// parseObjectAccountCode's own migration-time use above).
function getGlFiscalCalendar() {
  return [
    { periodNumber: 1, fiscalYear: 25, monthName: "January", fiscalMonthEnd: "2025-01-12", hfmCorporateLoad: "2025-02-06", womCloseDate: "2025-01-21" },
    { periodNumber: 2, fiscalYear: 25, monthName: "February", fiscalMonthEnd: "2025-02-09", hfmCorporateLoad: "2025-03-06", womCloseDate: "2025-02-18" },
    { periodNumber: 3, fiscalYear: 25, monthName: "March", fiscalMonthEnd: "2025-03-16", hfmCorporateLoad: "2025-04-04", womCloseDate: "2025-03-24" },
    { periodNumber: 4, fiscalYear: 25, monthName: "April", fiscalMonthEnd: "2025-04-13", hfmCorporateLoad: "2025-05-06", womCloseDate: "2025-04-22" },
    { periodNumber: 5, fiscalYear: 25, monthName: "May", fiscalMonthEnd: "2025-05-11", hfmCorporateLoad: "2025-06-05", womCloseDate: "2025-05-20" },
    { periodNumber: 6, fiscalYear: 25, monthName: "June", fiscalMonthEnd: "2025-06-15", hfmCorporateLoad: "2025-07-07", womCloseDate: "2025-06-23" },
    { periodNumber: 7, fiscalYear: 25, monthName: "July", fiscalMonthEnd: "2025-07-13", hfmCorporateLoad: "2025-08-06", womCloseDate: "2025-07-22" },
    { periodNumber: 8, fiscalYear: 25, monthName: "August", fiscalMonthEnd: "2025-08-10", hfmCorporateLoad: "2025-09-05", womCloseDate: "2025-08-19" },
    { periodNumber: 9, fiscalYear: 25, monthName: "September", fiscalMonthEnd: "2025-09-14", hfmCorporateLoad: "2025-10-06", womCloseDate: "2025-09-22" },
    { periodNumber: 10, fiscalYear: 25, monthName: "October", fiscalMonthEnd: "2025-10-12", hfmCorporateLoad: "2025-11-06", womCloseDate: "2025-10-21" },
    { periodNumber: 11, fiscalYear: 25, monthName: "November", fiscalMonthEnd: "2025-11-09", hfmCorporateLoad: "2025-12-04", womCloseDate: "2025-11-18" },
    { periodNumber: 12, fiscalYear: 25, monthName: "December", fiscalMonthEnd: "2025-12-14", hfmCorporateLoad: "2026-01-07", womCloseDate: "2025-12-22" },
    { periodNumber: 1, fiscalYear: 26, monthName: "January", fiscalMonthEnd: "2026-01-11", hfmCorporateLoad: "2026-02-05", womCloseDate: "2026-01-20" },
    { periodNumber: 2, fiscalYear: 26, monthName: "February", fiscalMonthEnd: "2026-02-08", hfmCorporateLoad: "2026-03-05", womCloseDate: "2026-02-17" },
    { periodNumber: 3, fiscalYear: 26, monthName: "March", fiscalMonthEnd: "2026-03-15", hfmCorporateLoad: "2026-04-06", womCloseDate: "2026-03-23" },
    { periodNumber: 4, fiscalYear: 26, monthName: "April", fiscalMonthEnd: "2026-04-12", hfmCorporateLoad: "2026-05-06", womCloseDate: "2026-04-21" },
    { periodNumber: 5, fiscalYear: 26, monthName: "May", fiscalMonthEnd: "2026-05-10", hfmCorporateLoad: "2026-06-04", womCloseDate: "2026-05-19" },
    { periodNumber: 6, fiscalYear: 26, monthName: "June", fiscalMonthEnd: "2026-06-14", hfmCorporateLoad: "2026-07-07", womCloseDate: "2026-06-22" },
    { periodNumber: 7, fiscalYear: 26, monthName: "July", fiscalMonthEnd: "2026-07-12", hfmCorporateLoad: "2026-08-06", womCloseDate: "2026-07-21" },
    { periodNumber: 8, fiscalYear: 26, monthName: "August", fiscalMonthEnd: "2026-08-09", hfmCorporateLoad: "2026-09-04", womCloseDate: "2026-08-18" },
    { periodNumber: 9, fiscalYear: 26, monthName: "September", fiscalMonthEnd: "2026-09-13", hfmCorporateLoad: "2026-10-06", womCloseDate: "2026-09-21" },
    { periodNumber: 10, fiscalYear: 26, monthName: "October", fiscalMonthEnd: "2026-10-11", hfmCorporateLoad: "2026-11-05", womCloseDate: "2026-10-20" },
    { periodNumber: 11, fiscalYear: 26, monthName: "November", fiscalMonthEnd: "2026-11-08", hfmCorporateLoad: "2026-12-04", womCloseDate: "2026-11-16" },
    { periodNumber: 12, fiscalYear: 26, monthName: "December", fiscalMonthEnd: "2026-12-13", hfmCorporateLoad: "2027-01-07", womCloseDate: "2026-12-21" },
  ];
}

// Which fiscal period a real calendar date falls into -- a fiscal period's
// own date range does NOT line up with calendar month boundaries (confirmed
// against Krista's real February GL export: rows dated in mid-January are
// legitimately tagged Period 2/FY26, since that period's own fiscal month
// end runs from the prior period's end through this one's, e.g. Jan 12 -
// Feb 8 for Period 2/FY26). Finds the earliest period whose own
// fiscalMonthEnd is on or after the given date; null if the date falls
// after the last seeded period (or the calendar simply doesn't go back far
// enough for it).
function resolveFiscalPeriod(dateStr) {
  if (!dateStr) return null;
  const sorted = getGlFiscalCalendar()
    .slice()
    .sort((a, b) => (a.fiscalMonthEnd < b.fiscalMonthEnd ? -1 : a.fiscalMonthEnd > b.fiscalMonthEnd ? 1 : 0));
  const match = sorted.find((p) => p.fiscalMonthEnd >= dateStr);
  return match ? { periodNumber: match.periodNumber, fiscalYear: match.fiscalYear } : null;
}

// Whether the most recently-closed GL period (per the real close calendar,
// not a guessed "percent through the month") has a report imported yet.
// null expectedPeriod means no period has even closed yet under this
// calendar (too early in the seeded range, or past the last period it
// covers) -- genuinely nothing to expect yet, not an error.
function getGlImportStatus() {
  const today = new Date().toISOString().slice(0, 10);
  let expected = null;
  for (const period of getGlFiscalCalendar()) {
    if (period.hfmCorporateLoad <= today && (!expected || period.hfmCorporateLoad > expected.hfmCorporateLoad)) {
      expected = period;
    }
  }
  if (!expected) return { expectedPeriod: null, overdue: false };
  const imported = db
    .prepare("SELECT 1 FROM gl_imports WHERE period_number = ? AND fiscal_year = ? LIMIT 1")
    .get(expected.periodNumber, expected.fiscalYear);
  return {
    expectedPeriod: {
      periodNumber: expected.periodNumber,
      fiscalYear: expected.fiscalYear,
      monthName: expected.monthName,
      closedDate: expected.hfmCorporateLoad,
    },
    overdue: !imported,
  };
}

// Every period in one fiscal year of the close calendar, each marked with
// whether it's been imported and whether it's even closed yet -- so the
// admin can see at a glance how much of the fiscal year is actually covered
// rather than just the single most-recent gap getGlImportStatus flags.
// "Not closed yet" is distinct from "missing": nothing to import there yet
// either way. Defaults to FY26 (today's working year) -- the GL
// Reconciliation coverage strip shows one fiscal year at a time, not every
// seeded year at once.
function getGlFiscalYearCoverage(fiscalYear = 26) {
  const today = new Date().toISOString().slice(0, 10);
  const importedPeriods = new Set(
    db
      .prepare("SELECT DISTINCT period_number AS periodNumber, fiscal_year AS fiscalYear FROM gl_imports")
      .all()
      .map((r) => `${r.periodNumber}|${r.fiscalYear}`)
  );
  return getGlFiscalCalendar().filter((period) => period.fiscalYear === fiscalYear).map((period) => ({
    periodNumber: period.periodNumber,
    fiscalYear: period.fiscalYear,
    monthName: period.monthName,
    fiscalMonthEnd: period.fiscalMonthEnd,
    womCloseDate: period.womCloseDate,
    closedDate: period.hfmCorporateLoad,
    closedYet: period.hfmCorporateLoad <= today,
    imported: importedPeriods.has(`${period.periodNumber}|${period.fiscalYear}`),
  }));
}

// Which fiscal years the close calendar actually covers -- unlike Spend
// Breakdown's own fiscal-year dropdown (loadFiscalYears in
// spendBreakdown.js), which only offers years with a real GL import on
// file, this backs a plain reference view of the calendar itself: an admin
// should be able to look up a period's dates whether or not anything's
// been imported for it yet.
function getGlFiscalCalendarYears() {
  return [...new Set(getGlFiscalCalendar().map((p) => p.fiscalYear))].sort((a, b) => b - a);
}

function importGlEntries(rows, periodNumber, fiscalYear, importedBy, sourceFileName) {
  const now = new Date().toISOString();
  db.prepare("DELETE FROM gl_entries WHERE period_number = ? AND fiscal_year = ?").run(periodNumber, fiscalYear);

  const insert = db.prepare(`
    INSERT INTO gl_entries
      (import_id, period_number, fiscal_year, gl_date, document_type, document_number,
       journal_entry_line_number, business_unit, object_account, object_account_code, subsidiary,
       amount, batch_number, supplier_invoice_number, invoice_date, location_code, matched_location_code,
       matched_location_source, name_alpha, remark, purchase_order, subledger_gl, matched_po_id,
       subsidiary_mismatch, object_code_mismatch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findPoByNumber = db.prepare("SELECT id, subsidiary, object_code FROM pos WHERE po_number = ? LIMIT 1");
  const poCache = new Map();
  const lookupPo = (poNumber) => {
    if (!poCache.has(poNumber)) poCache.set(poNumber, findPoByNumber.get(poNumber) || null);
    return poCache.get(poNumber);
  };
  // Business Unit is the precise match (see findLocationByJobNumber) -- tried
  // first. A handful of distinct business units/facility names repeat across
  // thousands of lines, so cache each lookup per unique raw value instead of
  // re-matching every row. Falls back to the tolerant name match only when a
  // business unit isn't on file under any of the three job-number columns
  // (e.g. a site the COA import hasn't captured, or a non-Toyota contract).
  const locationByJobNumberCache = new Map();
  const lookupLocationByBusinessUnit = (businessUnit) => {
    if (!businessUnit) return null;
    if (!locationByJobNumberCache.has(businessUnit)) {
      const location = findLocationByJobNumber(businessUnit);
      locationByJobNumberCache.set(businessUnit, location ? location.code : null);
    }
    return locationByJobNumberCache.get(businessUnit);
  };
  const locationCodeCache = new Map();
  const lookupLocationCode = (rawLocationCode) => {
    if (!rawLocationCode) return null;
    if (!locationCodeCache.has(rawLocationCode)) {
      locationCodeCache.set(rawLocationCode, matchLocationCodeByName(extractGlLocationName(rawLocationCode)));
    }
    return locationCodeCache.get(rawLocationCode);
  };
  const resolveMatchedLocation = (businessUnit, rawLocationCode) => {
    const byJobNumber = lookupLocationByBusinessUnit(businessUnit);
    if (byJobNumber) return { code: byJobNumber, source: "business_unit" };
    const byName = lookupLocationCode(rawLocationCode);
    return byName ? { code: byName, source: "name" } : { code: null, source: null };
  };

  const importRow = db.prepare(
    `INSERT INTO gl_imports
      (period_number, fiscal_year, row_count, matched_count, unmatched_count, no_po_reference_count, source_file_name, imported_by, created_at)
     VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?)`
  ).run(periodNumber, fiscalYear, sourceFileName, importedBy, now);
  const importId = Number(importRow.lastInsertRowid);

  let matchedCount = 0;
  let unmatchedCount = 0;
  let noPoReferenceCount = 0;
  for (const r of rows) {
    const poNumber = normalizePoNumber(r.purchaseOrder);
    const matchedPo = poNumber ? lookupPo(poNumber) : null;
    const matchedPoId = matchedPo ? matchedPo.id : null;
    if (poNumber) {
      if (matchedPoId) matchedCount++;
      else unmatchedCount++;
    } else {
      // Payroll, journal entries, accruals, etc. -- legitimately never had a
      // PO # to begin with, not a reconciliation gap.
      noPoReferenceCount++;
    }
    const objectAccountCode = parseObjectAccountCode(r.objectAccount);
    let subsidiaryMismatch = 0;
    let objectCodeMismatch = 0;
    if (matchedPo) {
      const poSubsidiaryCode = parseObjectAccountCode(matchedPo.subsidiary);
      const poObjectCode = parseObjectAccountCode(matchedPo.object_code);
      subsidiaryMismatch = poSubsidiaryCode && r.subsidiary && String(r.subsidiary) !== poSubsidiaryCode ? 1 : 0;
      objectCodeMismatch = poObjectCode && objectAccountCode && String(objectAccountCode) !== poObjectCode ? 1 : 0;
    }
    const matchedLocation = resolveMatchedLocation(r.businessUnit, r.locationCode);
    insert.run(
      importId,
      periodNumber,
      fiscalYear,
      r.glDate || null,
      r.documentType || null,
      r.documentNumber || null,
      r.journalEntryLineNumber ?? null,
      r.businessUnit || null,
      r.objectAccount || null,
      objectAccountCode,
      r.subsidiary || null,
      r.amount ?? null,
      r.batchNumber || null,
      r.supplierInvoiceNumber || null,
      r.invoiceDate || null,
      r.locationCode || null,
      matchedLocation.code,
      matchedLocation.source,
      r.nameAlpha || null,
      r.remark || null,
      poNumber,
      r.subledgerGl || null,
      matchedPoId,
      subsidiaryMismatch,
      objectCodeMismatch,
      now
    );
  }
  db.prepare("UPDATE gl_imports SET row_count = ?, matched_count = ?, unmatched_count = ?, no_po_reference_count = ? WHERE id = ?").run(
    rows.length,
    matchedCount,
    unmatchedCount,
    noPoReferenceCount,
    importId
  );
  return findGlImport(importId);
}

function presentGlImport(row) {
  if (!row) return null;
  return {
    id: row.id,
    periodNumber: row.period_number,
    fiscalYear: row.fiscal_year,
    rowCount: row.row_count,
    matchedCount: row.matched_count,
    unmatchedCount: row.unmatched_count,
    noPoReferenceCount: row.no_po_reference_count,
    sourceFileName: row.source_file_name,
    importedBy: row.imported_by,
    createdAt: row.created_at,
  };
}

function findGlImport(id) {
  return presentGlImport(db.prepare("SELECT * FROM gl_imports WHERE id = ?").get(id));
}

// Whether this exact period already has an import on file -- surfaced on
// /preview so uploading a second GL report for the same month tells the
// admin up front that it'll replace the first one, rather than them finding
// out only after confirming.
function findGlImportByPeriod(periodNumber, fiscalYear) {
  return presentGlImport(
    db.prepare("SELECT * FROM gl_imports WHERE period_number = ? AND fiscal_year = ? ORDER BY created_at DESC LIMIT 1").get(periodNumber, fiscalYear)
  );
}

function listGlImports() {
  return db.prepare("SELECT * FROM gl_imports ORDER BY created_at DESC").all().map(presentGlImport);
}

// A WOM's real Toyota PO(s) (Budget PO Tracker's own wom_number, same field
// getWomCostSummary's Remaining Toyota PO check already sums by), plus
// whatever GL has actually posted against each one -- read-only, for
// looking at whether a reclass naming this WOM actually shows up in the
// GL yet. Never used to auto-confirm a reclass; that's still the admin's
// own call (see confirmed_gl_reference on reclass_items).
// Real GL-posted $ per vendor, via each vendor's matched POs -- used
// alongside Vendor Spend Overview's WOM-reported applied cost so Krista can
// compare the project tracker's own number against what the GL actually
// shows. Keyed by vendor id; a vendor with no GL-matched PO at all is just
// absent from the map (not a 0, which would look like a confirmed non-spend).
function getVendorGlTotals() {
  return db
    .prepare(
      `SELECT p.vendor_id AS vendorId, SUM(g.amount) AS totalGlAmount, COUNT(*) AS glLineCount
       FROM gl_entries g
       JOIN pos p ON p.id = g.matched_po_id
       WHERE p.vendor_id IS NOT NULL
       GROUP BY p.vendor_id`
    )
    .all();
}

function getPoGlLinksByWom(womNumber) {
  // "-" is the sheet's own placeholder for "blank," not a real WOM # -- see
  // the parsing fix in server/routes/pos.js/reclasses.js for the real fix;
  // this guard is just so a stray "-" (old imported data, say) can never
  // again fan this lookup out across every PO that also has no real WOM #.
  if (!womNumber || womNumber === "-") return [];
  const pos = db
    .prepare("SELECT id, po_number AS poNumber, po_amount AS poAmount, status AS poStatus, object_code AS objectCode, subsidiary AS subsidiary FROM pos WHERE wom_number = ?")
    .all(womNumber);
  return pos
    .map((p) => {
      const lines = db
        .prepare(
          `SELECT period_number AS periodNumber, fiscal_year AS fiscalYear, gl_date AS glDate, document_type AS documentType,
                  document_number AS documentNumber, object_account AS objectAccount, subsidiary, amount,
                  name_alpha AS nameAlpha, supplier_invoice_number AS supplierInvoiceNumber
           FROM gl_entries WHERE matched_po_id = ? ORDER BY gl_date`
        )
        .all(p.id);
      return {
        poId: p.id,
        poNumber: p.poNumber,
        poAmount: p.poAmount,
        poStatus: p.poStatus,
        objectCode: p.objectCode,
        subsidiary: p.subsidiary,
        glLineCount: lines.length,
        actualPaid: lines.reduce((sum, l) => sum + (l.amount || 0), 0),
        lines,
      };
    })
    .filter((p) => p.glLineCount > 0); // a PO with no GL activity at all can't be where a reclass posting shows up -- and a shared/home WOM can carry dozens of unrelated POs, most never touched by GL, which otherwise buries the one PO that matters under noise.
}

// Krista confirmed against a real GL export that a posted reclass names
// itself in "Name - Alpha Explanation" (e.g. "AER Reclass", "AER Reclass
// July 2026" -- the customer-code prefix varies, "Reclass" is the constant
// part), posting as a batch of offsetting debit/credit lines across the old
// and new Business Unit. Searches for a GL line on each side's own job #
// (reclass_items.from/to_job_number, which is the GL's Business Unit field)
// whose amount matches that side's reclassed amount (either sign, since the
// reversing side flips it) and whose Name - Alpha Explanation contains
// "reclass" -- a real, confirmed signal, not a guess, but still just a
// candidate for the admin to look at, never an auto-confirmation.
function findReclassPostingMatches(jobNumber, amount) {
  if (!jobNumber || amount == null) return [];
  return db
    .prepare(
      `SELECT period_number AS periodNumber, fiscal_year AS fiscalYear, gl_date AS glDate, business_unit AS businessUnit,
              object_account AS objectAccount, subsidiary, amount, name_alpha AS nameAlpha, remark, batch_number AS batchNumber
       FROM gl_entries
       WHERE business_unit = ? AND ABS(ABS(amount) - ABS(?)) < 0.01 AND name_alpha LIKE '%reclass%' COLLATE NOCASE
       ORDER BY gl_date`
    )
    .all(jobNumber, amount);
}

// Every GL line that looks like a reclass posting (same "Name - Alpha
// Explanation contains Reclass" signal as findReclassPostingMatches above),
// independent of whether anyone ever imported a Reclass Submission workbook
// for it -- lets the Reclasses tab show what the GL itself says happened,
// not just what's been formally submitted. Ordered by batch number so the
// debit/credit pair (or set) that make up one reclass transaction land next
// to each other (confirmed against a real pair: same batch, opposite-signed
// amounts, both tagged "AER Reclass").
function getGlReclassActivity() {
  return db
    .prepare(
      `SELECT period_number AS periodNumber, fiscal_year AS fiscalYear, gl_date AS glDate,
              batch_number AS batchNumber, business_unit AS businessUnit, object_account AS objectAccount,
              subsidiary, amount, name_alpha AS nameAlpha, remark, document_number AS documentNumber,
              supplier_invoice_number AS supplierInvoiceNumber
       FROM gl_entries
       WHERE name_alpha LIKE '%reclass%' COLLATE NOCASE
       ORDER BY batch_number, gl_date, business_unit`
    )
    .all();
}

// A plain keyword read of the PO's own free-text status, for the Open/
// Closed filter only -- never shown in place of the real status text (see
// the Financials UI comment on why that's never algorithmically
// classified elsewhere). "fully invoiced"/"closed" are the only wordings
// confirmed to mean done; anything else (including blank) defaults to
// open rather than guess.
function classifyPoStatusBucket(status) {
  if (!status) return "open";
  const s = status.toLowerCase();
  return s.includes("closed") || s.includes("fully invoiced") ? "closed" : "open";
}

const GL_PAGE_SIZE_DEFAULT = 100;
const GL_ENTRY_COLUMNS = `id, period_number AS periodNumber, fiscal_year AS fiscalYear, gl_date AS glDate,
            document_type AS documentType, document_number AS documentNumber,
            journal_entry_line_number AS journalEntryLineNumber, business_unit AS businessUnit,
            object_account AS objectAccount, object_account_code AS objectAccountCode, subsidiary,
            amount, location_code AS locationCode, batch_number AS batchNumber, invoice_date AS invoiceDate,
            purchase_order AS purchaseOrder, supplier_invoice_number AS supplierInvoiceNumber,
            subledger_gl AS subledgerGl`;

// Shared by getGlSpendBreakdown/getGlSpendDetailPage: periodNumber+fiscalYear
// pins one exact month; fiscalYear alone (optionally narrowed by
// periodFrom/periodTo, inclusive) covers a range of months within one
// fiscal year -- "fiscal month to fiscal month" -- so last year's numbers
// never silently blend into this year's, and a specific stretch of months
// can be isolated without pinning to just one.
function buildGlSpendPeriodConditions({ periodNumber, fiscalYear, periodFrom, periodTo }) {
  const conditions = [];
  const params = [];
  if (periodNumber != null && fiscalYear != null) {
    conditions.push("g.period_number = ? AND g.fiscal_year = ?");
    params.push(periodNumber, fiscalYear);
  } else if (fiscalYear != null) {
    conditions.push("g.fiscal_year = ?");
    params.push(fiscalYear);
    if (periodFrom != null) {
      conditions.push("g.period_number >= ?");
      params.push(periodFrom);
    }
    if (periodTo != null) {
      conditions.push("g.period_number <= ?");
      params.push(periodTo);
    }
  }
  return { conditions, params };
}

// Cheap aggregate-only counts/totals for the summary tiles -- computed over
// the whole GL history (not just the current page), but as single SQL
// aggregates rather than materializing every matched line in JS. Backed by
// idx_gl_entries_mismatch and idx_gl_entries_purchase_order.
function getGlReconciliationSummary() {
  const reconciledRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(variance), 0) AS total FROM (
         SELECT SUM(g.amount) - COALESCE(p.po_amount, 0) AS variance
         FROM pos p JOIN gl_entries g ON g.matched_po_id = p.id
         GROUP BY p.id
       ) t`
    )
    .get();
  const subsidiaryMismatchCount = db
    .prepare("SELECT COUNT(DISTINCT matched_po_id) AS cnt FROM gl_entries WHERE matched_po_id IS NOT NULL AND subsidiary_mismatch = 1")
    .get().cnt;
  const objectCodeMismatchCount = db
    .prepare("SELECT COUNT(DISTINCT matched_po_id) AS cnt FROM gl_entries WHERE matched_po_id IS NOT NULL AND object_code_mismatch = 1")
    .get().cnt;
  const unmatchedRow = db
    .prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM gl_entries WHERE purchase_order IS NOT NULL AND matched_po_id IS NULL")
    .get();
  const noPoReferenceRow = db.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM gl_entries WHERE purchase_order IS NULL").get();

  return {
    reconciledCount: reconciledRow.cnt,
    reconciledTotal: reconciledRow.total,
    subsidiaryMismatchCount,
    objectCodeMismatchCount,
    unmatchedCount: unmatchedRow.cnt,
    unmatchedTotal: unmatchedRow.total,
    noPoReferenceCount: noPoReferenceRow.cnt,
    noPoReferenceTotal: noPoReferenceRow.total,
  };
}

// Scoped by default to GL lines with no Purchase Order reference at all --
// payroll labor/burden distributions, journal entries, Concur, Pcard,
// fleet accruals -- the bucket GL Reconciliation's own PO-matching tiles
// don't break down any further (its other two buckets, matched-to-a-PO and
// PO-number-not-found, are already fully covered there). This is where
// things like health-insurance burden and cell-phone charges actually
// post, since neither goes through AP as a PO-backed vendor invoice.
// Pass noPoReferenceOnly: false to see every GL line regardless of PO
// status, for comparison. Grouped by the chart-of-accounts category
// already embedded in each line's own Object Account text (see
// parseObjectAccountCategory) -- a line with no parseable category
// (blank/malformed Object Account) falls into "Unknown / Uncategorized"
// rather than being dropped, so nothing silently disappears from the
// totals. territory, when given, scopes to lines whose Location Code
// matched a location in that territory (see matched_location_code); a line
// that never matched any location falls under "Unassigned" in the
// territory breakdown and is included in the category breakdown
// regardless of the territory filter being unable to place it -- excluded
// only when a specific territory is requested and it can't be confirmed to
// belong to it. periodNumber/fiscalYear (both required together to take
// effect) scope to one imported period -- every period on file is
// combined by default, which is the real point of this view once several
// months have been imported.
// A PO's own object_code is a bare JDE number (e.g. "22067000"), the same
// format gl_entries.object_account_code already parses out of a GL line's
// full "647200 - Gen B&A~Cell Phone" text (see parseObjectAccountCode) --
// but a PO never carries the human-readable category name itself, only the
// GL extract does. Resolves a PO's object code to the same category name
// Spend Analysis already groups GL lines by, by looking up the most recent
// real GL line that used this exact code. A code that's never shown up on
// any imported GL yet has nothing to resolve against -- falls through to
// the same "Unknown / Uncategorized" bucket GL lines with no parseable
// category already use.
function resolveCategoryForObjectCode(objectCode) {
  if (!objectCode) return null;
  const row = db
    .prepare("SELECT object_account FROM gl_entries WHERE object_account_code = ? AND object_account LIKE '%~%' ORDER BY id DESC LIMIT 1")
    .get(objectCode);
  return row ? parseObjectAccountCategory(row.object_account) : null;
}

// The "current estimated PO" layer Spend Analysis's own checkbox adds on
// top of GL actuals: for every Active PO with a dollar amount on file,
// whatever portion of it hasn't shown up in the GL yet (po_amount minus
// whatever's already matched to it) -- not the PO's full amount, so a
// partially-invoiced PO only contributes its real remaining exposure, and
// a fully-invoiced one (remaining <= 0) contributes nothing at all here,
// since that dollar is already counted on the GL side. This is a snapshot
// of today's outstanding commitment, not a period-bound transaction like a
// GL line -- it deliberately ignores the fiscal year/period filter, since
// an open PO doesn't belong to one month the way a GL posting does.
function getPoRemainingAmounts({ territory } = {}) {
  const rows = db
    .prepare(
      `SELECT p.id, p.po_amount, p.object_code, p.location_code, l.territory AS territory,
         COALESCE((SELECT SUM(g.amount) FROM gl_entries g WHERE g.matched_po_id = p.id), 0) AS matchedTotal
       FROM pos p LEFT JOIN locations l ON l.code = p.location_code
       WHERE p.lifecycle_status = 'active' AND p.po_amount IS NOT NULL AND p.po_amount > 0`
    )
    .all();

  const byCategory = new Map();
  const byTerritory = new Map();
  let totalAmount = 0;
  let poCount = 0;
  for (const r of rows) {
    const remaining = r.po_amount - (r.matchedTotal || 0);
    if (remaining <= 0) continue;
    const rowTerritory = r.territory || null;
    if (territory && rowTerritory !== territory) continue;

    poCount++;
    totalAmount += remaining;

    const category = resolveCategoryForObjectCode(r.object_code) || "Unknown / Uncategorized";
    const c = byCategory.get(category) || { category, total: 0, count: 0 };
    c.total += remaining;
    c.count += 1;
    byCategory.set(category, c);

    const territoryKey = rowTerritory || "Unassigned";
    const t = byTerritory.get(territoryKey) || { territory: territoryKey, total: 0, count: 0 };
    t.total += remaining;
    t.count += 1;
    byTerritory.set(territoryKey, t);
  }

  return { totalAmount, poCount, byCategory, byTerritory };
}

function getGlSpendBreakdown({
  territory,
  periodNumber,
  fiscalYear,
  periodFrom,
  periodTo,
  noPoReferenceOnly = true,
  noWomReferenceOnly = true,
  includePoRemaining = false,
} = {}) {
  const { conditions, params } = buildGlSpendPeriodConditions({ periodNumber, fiscalYear, periodFrom, periodTo });
  if (noPoReferenceOnly) conditions.push("g.purchase_order IS NULL");
  // A line can be coded straight to a WOM project (subledger_gl set, no PO
  // at all) -- a different kind of "no PO" than payroll burden or an
  // accrual, and tracked through the WOM feature already, so it's excluded
  // by default here too alongside PO-referenced lines.
  if (noWomReferenceOnly) conditions.push("g.subledger_gl IS NULL");

  const rows = db
    .prepare(
      `SELECT g.object_account, g.amount, g.matched_location_code, l.territory AS territory
       FROM gl_entries g LEFT JOIN locations l ON l.code = g.matched_location_code
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`
    )
    .all(...params);

  const byCategory = new Map();
  const byTerritory = new Map();
  let totalAmount = 0;
  let entryCount = 0;
  let unassignedLocationCount = 0;
  for (const r of rows) {
    const rowTerritory = r.territory || null;
    if (territory && rowTerritory !== territory) continue;

    entryCount++;
    const amount = r.amount || 0;
    totalAmount += amount;

    const category = parseObjectAccountCategory(r.object_account) || "Unknown / Uncategorized";
    const c = byCategory.get(category) || { category, total: 0, count: 0 };
    c.total += amount;
    c.count += 1;
    byCategory.set(category, c);

    const territoryKey = rowTerritory || "Unassigned";
    if (!rowTerritory) unassignedLocationCount++;
    const t = byTerritory.get(territoryKey) || { territory: territoryKey, total: 0, count: 0 };
    t.total += amount;
    t.count += 1;
    byTerritory.set(territoryKey, t);
  }

  let poRemainingTotal = 0;
  let poRemainingCount = 0;
  if (includePoRemaining) {
    const poRemaining = getPoRemainingAmounts({ territory });
    poRemainingTotal = poRemaining.totalAmount;
    poRemainingCount = poRemaining.poCount;
    totalAmount += poRemaining.totalAmount;
    for (const c of poRemaining.byCategory.values()) {
      const existing = byCategory.get(c.category) || { category: c.category, total: 0, count: 0 };
      existing.total += c.total;
      existing.count += c.count;
      byCategory.set(c.category, existing);
    }
    for (const t of poRemaining.byTerritory.values()) {
      const existing = byTerritory.get(t.territory) || { territory: t.territory, total: 0, count: 0 };
      existing.total += t.total;
      existing.count += t.count;
      byTerritory.set(t.territory, existing);
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  return {
    totalAmount: round(totalAmount),
    entryCount,
    unassignedLocationCount,
    poRemainingTotal: round(poRemainingTotal),
    poRemainingCount,
    categories: [...byCategory.values()].map((c) => ({ ...c, total: round(c.total) })).sort((a, b) => b.total - a.total),
    territories: [...byTerritory.values()].map((t) => ({ ...t, total: round(t.total) })).sort((a, b) => b.total - a.total),
  };
}

// The actual GL lines behind one slice of the Spend Breakdown view -- a
// category row ("Cell Phone") or a territory row, clicked to answer "which
// phones did we pay for, and when" rather than just a total. Uses the exact
// same filtering/grouping rules as getGlSpendBreakdown (category from
// parseObjectAccountCategory, territory from matched_location_code) so a
// row's own total always matches what drilling into it shows. category
// and/or territory select the slice; at least one is expected, but neither
// is required so this can also page through everything a given
// period/fiscal year/noPoReferenceOnly scope covers.
function getGlSpendDetailPage({
  category,
  territory,
  periodNumber,
  fiscalYear,
  periodFrom,
  periodTo,
  noPoReferenceOnly = true,
  noWomReferenceOnly = true,
  search,
  page = 1,
  pageSize = GL_PAGE_SIZE_DEFAULT,
} = {}) {
  const { conditions, params } = buildGlSpendPeriodConditions({ periodNumber, fiscalYear, periodFrom, periodTo });
  // Searching for a specific PO # or WOM # (subledger_gl) means wanting
  // that referenced line regardless of the no-PO/no-WOM-reference defaults
  // below -- those exist to hide the common case (payroll, accruals, etc.)
  // from the main breakdown, not to hide the one line someone's
  // specifically looking for. A partial match (LIKE) since neither field
  // is normalized to one exact format across the GL export.
  if (search) {
    conditions.push("(g.purchase_order LIKE ? OR g.subledger_gl LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  } else {
    if (noPoReferenceOnly) conditions.push("g.purchase_order IS NULL");
    if (noWomReferenceOnly) conditions.push("g.subledger_gl IS NULL");
  }

  const rows = db
    .prepare(
      `SELECT ${GL_ENTRY_COLUMNS}, g.matched_location_code AS matchedLocationCode,
              g.name_alpha AS nameAlpha, g.remark, l.territory AS territory
       FROM gl_entries g LEFT JOIN locations l ON l.code = g.matched_location_code
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY g.gl_date DESC`
    )
    .all(...params);

  const matching = rows.filter((r) => {
    if (category != null) {
      const rowCategory = parseObjectAccountCategory(r.objectAccount) || "Unknown / Uncategorized";
      if (rowCategory !== category) return false;
    }
    if (territory != null) {
      const rowTerritory = r.territory || "Unassigned";
      if (rowTerritory !== territory) return false;
    }
    return true;
  });

  const p = Math.max(1, Number(page) || 1);
  const ps = Math.max(1, Number(pageSize) || GL_PAGE_SIZE_DEFAULT);
  const items = matching.slice((p - 1) * ps, p * ps).map((r) => ({
    id: r.id,
    periodNumber: r.periodNumber,
    fiscalYear: r.fiscalYear,
    glDate: r.glDate,
    documentType: r.documentType,
    documentNumber: r.documentNumber,
    objectAccount: r.objectAccount,
    subsidiary: r.subsidiary,
    amount: r.amount,
    locationCode: r.locationCode,
    territory: r.territory || "Unassigned",
    purchaseOrder: r.purchaseOrder,
    supplierInvoiceNumber: r.supplierInvoiceNumber,
    vendorOrDescription: r.nameAlpha || r.remark || null,
    // Full underlying GL line, for the "view full GL line" detail popup --
    // same shape/purpose as Meals/Cell Phones' own glLine (see
    // getMealsCharges), just assembled here from the richer column set this
    // query already selects.
    glLine: {
      objectAccount: r.objectAccount,
      objectAccountCode: r.objectAccountCode,
      documentType: r.documentType,
      documentNumber: r.documentNumber,
      journalEntryLineNumber: r.journalEntryLineNumber,
      businessUnit: r.businessUnit,
      subsidiary: r.subsidiary,
      batchNumber: r.batchNumber,
      supplierInvoiceNumber: r.supplierInvoiceNumber,
      invoiceDate: r.invoiceDate,
      purchaseOrder: r.purchaseOrder,
      locationCode: r.locationCode,
      remark: r.remark,
      nameAlpha: r.nameAlpha,
      subledgerGl: r.subledgerGl,
    },
  }));

  return { items, total: matching.length, page: p, pageSize: ps };
}

// GL_ENTRY_COLUMNS doesn't carry name_alpha/remark (getGlSpendDetailPage
// above selects those itself), and remark is the one place Krista's actual
// cell phone # lives for a Cell Phone GL line (confirmed against her real
// GL export: "Name - Remark Explanation" is a bare 10-digit number on every
// Cell Phone row, while name_alpha is always just the carrier/aggregator --
// "CALERO SOFTWARE LLC" -- same on every row, so it's useless for telling
// phones apart). A 10-digit remark is formatted for readability; anything
// else (an older/short code, a blank line) is passed through as-is rather
// than silently dropped.
function formatPhoneNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).trim().replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(raw).trim();
}

// Last-10-digits comparison key -- tolerates a leading "1" country code,
// dashes/parens/spaces, whichever side (GL remark vs. roster) happens to
// have them.
function normalizePhoneDigits(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Rows whose Location Code never matched anything in the Locations table --
// these can't resolve to a territory, so picking a specific territory in
// the filter silently excludes them (same as if they genuinely belonged to
// a different territory) rather than surfacing anywhere as "data that
// needs attention." Grouped by the raw location text so it's obvious which
// site is missing from the Locations tab.
function summarizeUnmatchedLocations(items) {
  const byLocation = new Map();
  for (const it of items) {
    if (it.locationMatched) continue;
    const key = it.locationLabel || "(no location code)";
    const l = byLocation.get(key) || { locationLabel: key, total: 0, count: 0 };
    l.total += it.amount || 0;
    l.count += 1;
    byLocation.set(key, l);
  }
  const round = (n) => Math.round(n * 100) / 100;
  return [...byLocation.values()].map((l) => ({ ...l, total: round(l.total) })).sort((a, b) => b.total - a.total);
}

// Who a Cell Phone GL line's number belongs to -- every technician's own
// phone (technicians.phone) plus every phone- or ipad-type device assigned
// to them (tech_devices.device_type IN ('phone', 'ipad'), so someone
// carrying more than one line -- or a cellular iPad with its own line on
// the plan -- is still matched on each). A laptop's asset tag/serial never
// false-matches here since normalizePhoneDigits requires 10+ digits.
// Carries employmentStatus too so getCellPhoneCharges can flag a line
// still billing a terminated employee's old number -- the company paying
// for a line nobody's using anymore. Built fresh per call, not cached --
// this backs an admin report, not a hot path, and device assignments
// change.
function buildTechPhoneRoster() {
  const roster = new Map(); // last-10-digits -> { id, name, employmentStatus }
  for (const t of db.prepare("SELECT id, name, phone, employment_status AS employmentStatus FROM technicians").all()) {
    const digits = normalizePhoneDigits(t.phone);
    if (digits) roster.set(digits, { id: t.id, name: t.name, employmentStatus: t.employmentStatus });
  }
  const phoneDevices = db
    .prepare(
      `SELECT d.device_name AS deviceName, t.id AS techId, t.name AS techName, t.employment_status AS employmentStatus
       FROM tech_devices d JOIN technicians t ON t.id = d.tech_id
       WHERE d.device_type IN ('phone', 'ipad')`
    )
    .all();
  for (const d of phoneDevices) {
    const digits = normalizePhoneDigits(d.deviceName);
    if (digits) roster.set(digits, { id: d.techId, name: d.techName, employmentStatus: d.employmentStatus });
  }
  return roster;
}

// Every distinct number that's ever shown up on a Cell Phone GL bill,
// formatted for display -- offered as suggestions when assigning a Phone
// or iPad device, since these are numbers the company is already paying
// for (Calero), not ones to type blind. Not scoped to a fiscal year or
// territory -- this is a reference list for the Devices tab, not a report.
function listKnownCellPhoneNumbers() {
  const rows = db.prepare("SELECT DISTINCT remark FROM gl_entries WHERE object_account LIKE '%~Cell Phone%' AND remark IS NOT NULL").all();
  const byDigits = new Map();
  for (const r of rows) {
    const digits = normalizePhoneDigits(r.remark);
    if (digits && !byDigits.has(digits)) byDigits.set(digits, formatPhoneNumber(r.remark));
  }
  return [...byDigits.values()].sort();
}

// Cell Phone is one Spend Breakdown category (see parseObjectAccountCategory)
// pulled out into its own purpose-built report: which number was charged,
// how much, and in which month -- not just a flat GL-line list like the
// generic drill-down modal gives every other category. No PO/WOM
// filtering here (unlike getGlSpendDetailPage's defaults) -- a phone line
// is never coded to either, so there's nothing to exclude.
function getCellPhoneCharges({ territory, fiscalYear } = {}) {
  const conditions = ["g.object_account LIKE '%~Cell Phone'"];
  const params = [];
  if (fiscalYear != null) {
    conditions.push("g.fiscal_year = ?");
    params.push(Number(fiscalYear));
  }
  const rows = db
    .prepare(
      `SELECT g.period_number AS periodNumber, g.fiscal_year AS fiscalYear, g.gl_date AS glDate,
              g.amount, g.remark, g.name_alpha AS nameAlpha,
              g.matched_location_code AS matchedLocationCode, g.location_code AS locationCode,
              l.name AS locationName, l.territory AS territory
       FROM gl_entries g LEFT JOIN locations l ON l.code = g.matched_location_code
       WHERE ${conditions.join(" AND ")}
       ORDER BY g.fiscal_year, g.period_number, g.remark`
    )
    .all(...params);

  const calendar = getGlFiscalCalendar();
  const monthFor = (periodNumber, fy) => {
    const p = calendar.find((c) => c.periodNumber === periodNumber && c.fiscalYear === fy);
    return p ? p.monthName : null;
  };
  const roster = buildTechPhoneRoster();

  const items = [];
  for (const r of rows) {
    const rowTerritory = r.territory || "Unassigned";
    if (territory && rowTerritory !== territory) continue;
    const match = roster.get(normalizePhoneDigits(r.remark));
    items.push({
      periodNumber: r.periodNumber,
      fiscalYear: r.fiscalYear,
      month: monthFor(r.periodNumber, r.fiscalYear),
      glDate: r.glDate,
      phoneNumber: formatPhoneNumber(r.remark),
      phoneNumberRaw: r.remark,
      vendor: r.nameAlpha,
      amount: r.amount,
      // When matched_location_code doesn't resolve (the site isn't
      // registered in Locations yet), the raw GL export's own "Location
      // Code" text -- e.g. "20000438 - TOYOTA MS TLS- NEWARK" -- already
      // reads fine on its own, so that's the fallback here rather than
      // leaving the row blank. Those rows also can't resolve a territory,
      // so picking a specific territory silently excludes them -- see
      // unmatchedLocations below for which sites that's actually hitting.
      locationLabel: r.locationName || r.matchedLocationCode || r.locationCode,
      locationMatched: Boolean(r.matchedLocationCode),
      territory: rowTerritory,
      // Matched against every technician's own phone # plus every
      // phone-type device on their profile (see buildTechPhoneRoster) --
      // null means this number isn't on file for anyone yet, not that the
      // match failed.
      assignedToId: match ? match.id : null,
      assignedToName: match ? match.name : null,
      // The company is still being billed for this line even though
      // whoever it's assigned to has left -- a real wasted-spend flag,
      // not just a data-quality one (see assignedToId/Name above).
      assignedToTerminated: match ? match.employmentStatus === "terminated" : false,
    });
  }

  const byPhone = new Map();
  for (const it of items) {
    const key = it.phoneNumber || "Unknown #";
    const p =
      byPhone.get(key) ||
      {
        phoneNumber: key,
        total: 0,
        count: 0,
        months: new Set(),
        locationLabel: it.locationLabel,
        assignedToName: it.assignedToName,
        assignedToTerminated: it.assignedToTerminated,
      };
    p.total += it.amount || 0;
    p.count += 1;
    p.months.add(it.month);
    byPhone.set(key, p);
  }

  const round = (n) => Math.round(n * 100) / 100;
  return {
    items,
    totalAmount: round(items.reduce((sum, it) => sum + (it.amount || 0), 0)),
    count: items.length,
    byPhone: [...byPhone.values()]
      .map((p) => ({
        phoneNumber: p.phoneNumber,
        total: round(p.total),
        count: p.count,
        monthCount: p.months.size,
        locationLabel: p.locationLabel,
        assignedToName: p.assignedToName,
        assignedToTerminated: p.assignedToTerminated,
      }))
      .sort((a, b) => b.total - a.total),
    // Lines billed for someone who's since left -- surfaced up top as its
    // own count/total, not just a per-row badge, since this is money that
    // could likely be cancelled outright.
    terminatedCount: items.filter((it) => it.assignedToTerminated).length,
    terminatedTotal: round(items.filter((it) => it.assignedToTerminated).reduce((sum, it) => sum + (it.amount || 0), 0)),
    unmatchedLocations: summarizeUnmatchedLocations(items),
  };
}

// Meals has no clean per-line identifier the way Cell Phone's remark field
// is a bare phone #. Checked against Krista's real GL export: remark is
// free text Concur writes per expense line -- sometimes a name ("Plano Aug
// McDonald Charles", "Monica's expenses August 2026"), sometimes a bulk
// correction with no name at all ("Aug26 FP/ADM Concur Entry USD", a single
// lump debit/credit pair with nothing to tie to a person). Reference 2 --
// which does carry a clean "LASTNAME FIRSTNAME" value on some other GL
// categories -- is unpopulated on every single Meals row in the file this
// was built against, so it's not a usable fallback here (unlike remark for
// Cell Phone, there's nothing to reliably parse). Remark is therefore kept
// verbatim as "description" rather than algorithmically split into a name
// -- forcing that would silently fabricate names on the rows that don't
// have one. Grouping by the exact same remark text (byDescription) still
// clusters one person's repeated Concur lines together in practice, since
// Concur reuses one remark string across every line of the same report.
// Two Object Account categories exist ("Meals Empl", "Meals & Ent") with
// very different shapes -- Meals & Ent includes large negative correction
// batches unrelated to any one person -- so both the per-line items and
// the summary carry category, not just a combined "Meals" total.
function getMealsCharges({ territory, fiscalYear } = {}) {
  const conditions = ["g.object_account LIKE '%~Meals%'"];
  const params = [];
  if (fiscalYear != null) {
    conditions.push("g.fiscal_year = ?");
    params.push(Number(fiscalYear));
  }
  const rows = db
    .prepare(
      `SELECT g.id, g.period_number AS periodNumber, g.fiscal_year AS fiscalYear, g.gl_date AS glDate,
              g.object_account AS objectAccount, g.amount, g.remark, g.name_alpha AS nameAlpha,
              g.matched_location_code AS matchedLocationCode, g.location_code AS locationCode,
              l.name AS locationName, l.territory AS territory,
              g.document_type AS documentType, g.document_number AS documentNumber,
              g.journal_entry_line_number AS journalEntryLineNumber, g.business_unit AS businessUnit,
              g.object_account_code AS objectAccountCode, g.subsidiary, g.batch_number AS batchNumber,
              g.supplier_invoice_number AS supplierInvoiceNumber, g.invoice_date AS invoiceDate,
              g.purchase_order AS purchaseOrder, g.subledger_gl AS subledgerGl
       FROM gl_entries g LEFT JOIN locations l ON l.code = g.matched_location_code
       WHERE ${conditions.join(" AND ")}
       ORDER BY g.fiscal_year, g.period_number, g.remark`
    )
    .all(...params);

  const calendar = getGlFiscalCalendar();
  const monthFor = (periodNumber, fy) => {
    const p = calendar.find((c) => c.periodNumber === periodNumber && c.fiscalYear === fy);
    return p ? p.monthName : null;
  };

  const items = [];
  for (const r of rows) {
    const rowTerritory = r.territory || "Unassigned";
    if (territory && rowTerritory !== territory) continue;
    items.push({
      id: r.id,
      periodNumber: r.periodNumber,
      fiscalYear: r.fiscalYear,
      month: monthFor(r.periodNumber, r.fiscalYear),
      glDate: r.glDate,
      category: parseObjectAccountCategory(r.objectAccount) || "Meals",
      description: (r.remark && r.remark.trim()) || r.nameAlpha || null,
      amount: r.amount,
      locationLabel: r.locationName || r.matchedLocationCode || r.locationCode,
      locationMatched: Boolean(r.matchedLocationCode),
      territory: rowTerritory,
      // Full underlying GL line, for the "view full GL line" detail popup --
      // the summary table above only shows the handful of fields that matter
      // for a quick scan.
      glLine: {
        objectAccount: r.objectAccount,
        objectAccountCode: r.objectAccountCode,
        documentType: r.documentType,
        documentNumber: r.documentNumber,
        journalEntryLineNumber: r.journalEntryLineNumber,
        businessUnit: r.businessUnit,
        subsidiary: r.subsidiary,
        batchNumber: r.batchNumber,
        supplierInvoiceNumber: r.supplierInvoiceNumber,
        invoiceDate: r.invoiceDate,
        purchaseOrder: r.purchaseOrder,
        locationCode: r.locationCode,
        remark: r.remark,
        subledgerGl: r.subledgerGl,
      },
    });
  }

  const byDescription = new Map();
  const byCategory = new Map();
  for (const it of items) {
    const key = `${it.category}::${it.description || "(no description)"}`;
    const d =
      byDescription.get(key) || { category: it.category, description: it.description || "(no description)", total: 0, count: 0, months: new Set(), locationLabel: it.locationLabel };
    d.total += it.amount || 0;
    d.count += 1;
    d.months.add(it.month);
    byDescription.set(key, d);

    const c = byCategory.get(it.category) || { category: it.category, total: 0, count: 0 };
    c.total += it.amount || 0;
    c.count += 1;
    byCategory.set(it.category, c);
  }

  const round = (n) => Math.round(n * 100) / 100;
  return {
    items,
    totalAmount: round(items.reduce((sum, it) => sum + (it.amount || 0), 0)),
    count: items.length,
    byCategory: [...byCategory.values()].map((c) => ({ ...c, total: round(c.total) })).sort((a, b) => b.total - a.total),
    byDescription: [...byDescription.values()]
      .map((d) => ({ category: d.category, description: d.description, total: round(d.total), count: d.count, monthCount: d.months.size, locationLabel: d.locationLabel }))
      .sort((a, b) => b.total - a.total),
    unmatchedLocations: summarizeUnmatchedLocations(items),
  };
}

function buildReconciledFilterClauses(filters) {
  const whereClauses = [];
  const havingClauses = [];
  if (filters.missingLocationOnly) {
    whereClauses.push("(p.location_code IS NULL OR p.location_code = '')");
  }
  // Mirrors classifyPoStatusBucket's own keyword logic exactly, so a PO's
  // bucket reads the same whether computed here (for filtering) or in JS
  // (for the statusBucket field on each returned row).
  if (filters.status === "open") {
    whereClauses.push("(p.status IS NULL OR (LOWER(p.status) NOT LIKE '%closed%' AND LOWER(p.status) NOT LIKE '%fully invoiced%'))");
  } else if (filters.status === "closed") {
    whereClauses.push("(LOWER(p.status) LIKE '%closed%' OR LOWER(p.status) LIKE '%fully invoiced%')");
  }
  if (filters.coding === "subsidiary") {
    havingClauses.push("MAX(g.subsidiary_mismatch) = 1");
  } else if (filters.coding === "objectCode") {
    havingClauses.push("MAX(g.object_code_mismatch) = 1");
  } else if (filters.coding === "either") {
    havingClauses.push("(MAX(g.subsidiary_mismatch) = 1 OR MAX(g.object_code_mismatch) = 1)");
  }
  if (filters.aboveOnly) {
    havingClauses.push("(SUM(g.amount) - COALESCE(p.po_amount, 0)) > 0");
  }
  return {
    where: whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "",
    having: havingClauses.length ? `HAVING ${havingClauses.join(" AND ")}` : "",
  };
}

// Per-PO reconciliation, one page at a time: what the PO was approved for
// vs. what the GL shows actually paid against it (summed across every
// matched GL line, which can span more than one invoice/batch), plus
// whether any matched line's own object/subsidiary code differs from what
// the PO itself specifies (precomputed on gl_entries -- see
// subsidiary_mismatch/object_code_mismatch -- so filtering by coding
// mismatch is a plain indexed HAVING clause, not a JS scan of every line).
// Replaces the old all-at-once getPoReconciliation: that pulled every
// matched line in the GL's entire history on every single page load, which
// only got slower as more months were imported -- this only ever touches
// the current page's POs' own lines.
function getReconciledPage(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.max(1, Number(filters.pageSize) || GL_PAGE_SIZE_DEFAULT);
  const { where, having } = buildReconciledFilterClauses(filters);

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT p.id FROM pos p JOIN gl_entries g ON g.matched_po_id = p.id ${where} GROUP BY p.id ${having}
       ) t`
    )
    .get();

  const rows = db
    .prepare(
      `SELECT
         p.id, p.po_number AS poNumber, p.description, p.location_code AS locationCode,
         p.wom_number AS womNumber, p.po_amount AS poAmount, p.object_code AS objectCode,
         p.subsidiary AS poSubsidiary, p.vendor_name AS vendorName, p.status AS poStatus,
         COUNT(g.id) AS glLineCount, SUM(g.amount) AS actualPaid,
         MAX(g.subsidiary_mismatch) AS subsidiaryMismatch, MAX(g.object_code_mismatch) AS objectCodeMismatch
       FROM pos p JOIN gl_entries g ON g.matched_po_id = p.id
       ${where}
       GROUP BY p.id
       ${having}
       ORDER BY ABS(SUM(g.amount) - COALESCE(p.po_amount, 0)) DESC
       LIMIT ? OFFSET ?`
    )
    .all(pageSize, (page - 1) * pageSize);

  // Only this page's POs' own matched lines -- never the whole history.
  const linesByPo = new Map();
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    for (const line of db.prepare(`SELECT * FROM gl_entries WHERE matched_po_id IN (${placeholders})`).all(...rows.map((r) => r.id))) {
      if (!linesByPo.has(line.matched_po_id)) linesByPo.set(line.matched_po_id, []);
      linesByPo.get(line.matched_po_id).push({
        periodNumber: line.period_number,
        fiscalYear: line.fiscal_year,
        glDate: line.gl_date,
        documentType: line.document_type,
        documentNumber: line.document_number,
        objectAccount: line.object_account,
        objectAccountCode: line.object_account_code,
        subsidiary: line.subsidiary,
        amount: line.amount,
        supplierInvoiceNumber: line.supplier_invoice_number,
        invoiceDate: line.invoice_date,
      });
    }
  }

  // Each import only replaces its own period/fiscal year (see
  // importGlEntries), so gl_entries can hold several imported months at
  // once -- a PO's matched lines aren't guaranteed to all be from the same
  // one. "periodLabel" names every period actually represented for that PO
  // (e.g. "P7/FY26" or "P6/FY26, P7/FY26"), so the table never implies a
  // single period when the underlying lines span more than one.
  const items = rows.map((p) => {
    const lines = linesByPo.get(p.id) || [];
    const periods = [...new Set(lines.map((l) => `P${l.periodNumber}/FY${l.fiscalYear}`))];
    return {
      poId: p.id,
      poNumber: p.poNumber,
      description: p.description,
      locationCode: p.locationCode,
      womNumber: p.womNumber,
      vendorName: p.vendorName,
      poStatus: p.poStatus,
      statusBucket: classifyPoStatusBucket(p.poStatus),
      poAmount: p.poAmount,
      actualPaid: p.actualPaid,
      variance: p.actualPaid - (p.poAmount || 0),
      glLineCount: p.glLineCount,
      subsidiaryMismatch: Boolean(p.subsidiaryMismatch),
      objectCodeMismatch: Boolean(p.objectCodeMismatch),
      periodLabel: periods.join(", "),
      lines,
    };
  });

  return { items, total: countRow.cnt, page, pageSize };
}

// A GL line naming a PO # that isn't in the Budget PO Tracker -- a real gap
// worth investigating (missing from the tracker, or billed against the
// wrong PO #).
function getUnmatchedEntriesPage({ page = 1, pageSize = GL_PAGE_SIZE_DEFAULT } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.max(1, Number(pageSize) || GL_PAGE_SIZE_DEFAULT);
  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM gl_entries WHERE purchase_order IS NOT NULL AND matched_po_id IS NULL").get();
  const items = db
    .prepare(`SELECT ${GL_ENTRY_COLUMNS} FROM gl_entries WHERE purchase_order IS NOT NULL AND matched_po_id IS NULL ORDER BY ABS(amount) DESC LIMIT ? OFFSET ?`)
    .all(ps, (p - 1) * ps);
  return { items, total: countRow.cnt, page: p, pageSize: ps };
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
  TASK_NOTIFICATION_REASONS,
  getTaskNotificationPrefs,
  setTaskNotificationPrefs,
  CW_STATUSES,
  TOYOTA_STATUSES,
  FORMS_STATUSES,
  ONBOARDING_STAGES,
  listVendors,
  findVendor,
  findVendorByNumber,
  getVendorTerritories,
  getVendorPoGlRollup,
  createVendor,
  updateVendor,
  deleteVendor,
  setVendorPreferred,
  VENDOR_DENIAL_REASONS,
  denyVendor,
  reinstateVendor,
  listExpiredVendorComplianceCategories,
  addVendorRemark,
  listVendorRemarks,
  WOM_COST_REVIEW_STATUSES,
  WOM_COST_REVIEW_REASONS,
  setWomCostReview,
  RECLASS_STATUSES,
  RECLASS_STATUS_LABELS,
  RECLASS_CAUSED_BY_OPTIONS,
  RECLASS_ROOT_CAUSE_OPTIONS,
  importReclassBatch,
  listReclassBatches,
  findReclassBatch,
  listReclassItems,
  getReclassSummary,
  findReclassItem,
  addReclassItem,
  flagPosForReclass,
  unflagPosForReclass,
  updateReclassItem,
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
  setDeviceUpgradeDate,
  listTechRemarks,
  addTechRemark,
  deleteTechRemark,
  addDeviceRequest,
  setDeviceRequestCompleted,
  setDeviceRequestDetails,
  getAllocationHistory,
  listLocations,
  findLocation,
  getAdminTerritory,
  createLocation,
  runLocationCoaImport,
  deleteLocation,
  deleteTechnician,
  setLocationDetails,
  TERRITORIES,
  listWoms,
  findWom,
  hasWomInvoiceDocument,
  listWomsNeedingInvoicing,
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
  sourceImpliesInvoiced,
  isWomBillingChecklistComplete,
  WOM_BILLING_CHECKLIST_FIELDS,
  refreshAllOpenWomLifecycles,
  lifecycleTaskSourceKey,
  referWomChangeOrderToAdmin,
  requestWomChangeOrderPo,
  refreshVendorComplianceTask,
  refreshAllVendorComplianceTasks,
  refreshAllPoWomLinkTasks,
  listVendorComplianceTasks,
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
  markTaskPoGenerated,
  getPoRequestTurnaroundStats,
  getPerformanceKpis,
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
  setFileAccessLevel,
  listTaskDocuments,
  relocateFile,
  listExpiringForms,
  listWeekendAddenda,
  listReportGapMonths,
  listPos,
  findPo,
  getLastPoImport,
  runPoImport,
  confirmPoVendor,
  clearPoVendorMatch,
  tagLocationForPo,
  bulkConfirmPoVendor,
  movePoToActive,
  bulkMovePoToActive,
  listPoTasks,
  listUnregisteredPoVendors,
  refreshAllUnregisteredVendorTasks,
  refreshAllPoCodingDriftTasks,
  refreshAllPoJobNumberTypeMismatchTasks,
  refreshAllPoWomLocationMismatchTasks,
  refreshAllWomInvoicingTasks,
  importGlEntries,
  refreshGlMismatchFlagsForPo,
  listGlImports,
  findGlImport,
  findGlImportByPeriod,
  getPoGlLinksByWom,
  findReclassPostingMatches,
  getGlReclassActivity,
  getGlReconciliationSummary,
  getGlSpendBreakdown,
  getGlSpendDetailPage,
  getCellPhoneCharges,
  getMealsCharges,
  listKnownCellPhoneNumbers,
  getReconciledPage,
  getUnmatchedEntriesPage,
  getGlImportStatus,
  getGlFiscalYearCoverage,
  getGlFiscalCalendarYears,
  getGlFiscalCalendar,
  resolveFiscalPeriod,
};
