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
    created_by TEXT,
    created_at TEXT NOT NULL,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
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
// The PSE/PO pipeline (see PSE_STAGES below) tracked separately from the
// existing `status` column -- status still gates whether a WOM can be
// allocated to (open/closed/etc.), while pse_stage tracks where it sits in
// the real-world PSE-to-invoice workflow (a WOM can be "open" for weeks
// while its pse_stage moves through several steps). NULL means this WOM
// isn't in the pipeline at all (created by hand rather than synced from
// Smartsheet, or from before this feature existed) -- it just won't show
// up on anyone's PSE task list.
if (!hasColumn("woms", "pse_stage")) {
  db.exec("ALTER TABLE woms ADD COLUMN pse_stage TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_hold_reason TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_hold_note TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_schedule_block INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE woms ADD COLUMN pse_followup_at TEXT");
  db.exec("ALTER TABLE woms ADD COLUMN pse_stage_updated_at TEXT");
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
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

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
    now,
    now,
  ];
  const result = db
    .prepare(`INSERT INTO vendors (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...values);
  return findVendor(result.lastInsertRowid);
}

function updateVendor(id, fields) {
  if (!findVendor(id)) return null;
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
// rather than force-fitting it.
function listVendorRequests(vendorId) {
  return db
    .prepare(
      `SELECT id, request_type AS requestType, reference_number AS referenceNumber, status,
              requested_at AS requestedAt
       FROM vendor_requests WHERE vendor_id = ? ORDER BY id DESC`
    )
    .all(vendorId);
}

function addVendorRequest(vendorId, requestType, referenceNumber, status) {
  db.prepare(
    "INSERT INTO vendor_requests (vendor_id, request_type, reference_number, status, requested_at) VALUES (?, ?, ?, ?, ?)"
  ).run(vendorId, requestType, referenceNumber || "", status || "", new Date().toISOString());
  return listVendorRequests(vendorId);
}

function updateVendorRequest(vendorId, requestId, { requestType, referenceNumber, status }) {
  db.prepare(
    "UPDATE vendor_requests SET request_type = ?, reference_number = ?, status = ? WHERE id = ? AND vendor_id = ?"
  ).run(requestType, referenceNumber || "", status || "", requestId, vendorId);
  return listVendorRequests(vendorId);
}

function deleteVendorRequest(vendorId, requestId) {
  db.prepare("DELETE FROM vendor_requests WHERE id = ? AND vendor_id = ?").run(requestId, vendorId);
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

function createLocation(code, name, efJobNumber, region, womJobNumber) {
  db.prepare("INSERT INTO locations (code, name, ef_job_number, region, wom_job_number) VALUES (?, ?, ?, ?, ?)").run(
    code,
    name,
    efJobNumber || null,
    region || null,
    womJobNumber || null
  );
  return findLocation(code);
}

function setLocationDetails(code, { name, efJobNumber, region, womJobNumber } = {}) {
  if (!findLocation(code)) return null;
  db.prepare("UPDATE locations SET name = ?, ef_job_number = ?, region = ?, wom_job_number = ? WHERE code = ?").run(
    name,
    efJobNumber || null,
    region || null,
    womJobNumber || null,
    code
  );
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

// ---- PSE / PO pipeline ----
//
// Tracks a WOM through the real-world PSE-to-invoice workflow (create WOM
// request -> produce PSE -> Toyota approval -> issue PO -> schedule work ->
// check expenses -> Status 95 approval -> invoice), separately from the
// `status` column above, which only ever gates whether a WOM can be
// allocated to. A WOM can be "open" (allocatable) for its entire time in
// this pipeline; pse_stage tracks where it sits within that.
//
// Two roles split the work: "reviewer" (produces the PSE, liaises with
// Toyota, approves Status 95 -- one specific admin) and "financial" (issues
// the WOM/PO, monitors charges, invoices -- any other active admin). NULL
// pse_stage means a WOM isn't in this pipeline at all (created by hand
// rather than synced from Smartsheet) and never shows up on anyone's list.
const PSE_STAGES = {
  pse_review: { label: "Review & produce PSE", role: "reviewer" },
  awaiting_toyota_approval: { label: "Awaiting Toyota approval", role: "reviewer" },
  generate_wom_po: { label: "Generate WOM / PO", role: "financial" },
  awaiting_toyota_po: { label: "Awaiting Toyota PO #", role: "reviewer" },
  schedule_blocked: { label: "Blocked from scheduling (PO pending)", role: "reviewer" },
  ready_to_schedule: { label: "Ready to schedule", role: null },
  check_expenses: { label: "Check expenses & invoicing", role: "financial" },
  pending_status95_approval: { label: "Sent for Status 95 approval", role: "reviewer" },
  ready_to_invoice: { label: "Approved -- ready to invoice", role: "financial" },
  closed: { label: "Invoiced / closed", role: null },
};

const PSE_HOLD_REASONS = ["vendor_invoice", "labor_allocations", "other"];

// One entry per action a task list button can fire. `next: "same"` re-sets
// the follow-up date without changing stage (a snooze); `"scheduleAware"`
// resolves to schedule_blocked or ready_to_schedule depending on
// pse_schedule_block at the moment the action runs. followupDays sets
// pse_followup_at that many days out (null clears it).
const PSE_ACTIONS = {
  mark_pse_produced: { from: ["pse_review"], role: "reviewer", next: "awaiting_toyota_approval", followupDays: 14 },
  snooze_followup: { from: ["awaiting_toyota_approval", "awaiting_toyota_po"], role: "reviewer", next: "same", followupDays: 30 },
  toyota_approved: { from: ["awaiting_toyota_approval"], role: "reviewer", next: "generate_wom_po", followupDays: null },
  generated_missing_po: { from: ["generate_wom_po"], role: "financial", next: "awaiting_toyota_po", followupDays: 14 },
  generated_with_po: { from: ["generate_wom_po"], role: "financial", next: "scheduleAware", followupDays: null },
  po_received: { from: ["awaiting_toyota_po"], role: "reviewer", next: "scheduleAware", followupDays: null },
  clear_schedule_block: { from: ["schedule_blocked"], role: "reviewer", next: "ready_to_schedule", followupDays: null },
  send_status95: { from: ["check_expenses"], role: "financial", next: "pending_status95_approval", followupDays: null },
  approve_status95: { from: ["pending_status95_approval"], role: "reviewer", next: "ready_to_invoice", followupDays: null },
  reject_status95: { from: ["pending_status95_approval"], role: "reviewer", next: "check_expenses", followupDays: null },
  mark_invoiced: { from: ["ready_to_invoice"], role: "financial", next: "closed", followupDays: null, closesWom: true },
};

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

// Nobody designated yet shouldn't lock reviewer-only actions out entirely
// -- until that one-time setup happens, any admin can take either role.
function pseRoleFor(adminId) {
  const reviewer = getPseReviewerId();
  if (!reviewer) return null; // null = "any role allowed", checked below
  return adminId === reviewer ? "reviewer" : "financial";
}

// Auto-enters a WOM into the pipeline the first time it syncs in from
// Smartsheet -- never re-enters one already past this point, so a later
// sync touching the same row doesn't reset progress someone's already
// made on it.
function ensurePseStage(code) {
  const wom = db.prepare("SELECT pse_stage FROM woms WHERE code = ?").get(code);
  if (!wom || wom.pse_stage) return;
  db.prepare("UPDATE woms SET pse_stage = 'pse_review', pse_stage_updated_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  recordWomStatusChange(code, "pse_stage", null, "pse_review", { source: "smartsheet_sync" });
  syncPseStageTask(code, null, "pse_review");
}

function listPseTasks(admin) {
  const role = pseRoleFor(admin.id);
  return db
    .prepare("SELECT * FROM woms WHERE pse_stage IS NOT NULL AND pse_stage != 'closed'")
    .all()
    .map(womWithRemaining)
    .filter((w) => {
      const stage = PSE_STAGES[w.pse_stage];
      if (!stage || !stage.role) return false;
      return role === null || stage.role === role;
    })
    .sort((a, b) => (a.pse_followup_at || "").localeCompare(b.pse_followup_at || ""));
}

function applyPseAction(code, actionKey, admin) {
  const wom = findWom(code);
  if (!wom) return { error: "not_found" };
  const action = PSE_ACTIONS[actionKey];
  if (!action) return { error: "unknown_action" };
  if (!action.from.includes(wom.pse_stage)) return { error: "wrong_stage", currentStage: wom.pse_stage };
  const role = pseRoleFor(admin.id);
  if (role !== null && role !== action.role) return { error: "wrong_role" };

  let nextStage = action.next;
  if (nextStage === "same") nextStage = wom.pse_stage;
  else if (nextStage === "scheduleAware") nextStage = wom.pse_schedule_block ? "schedule_blocked" : "ready_to_schedule";

  const followupAt = action.followupDays == null ? null : new Date(Date.now() + action.followupDays * 86400000).toISOString();
  const previousStage = wom.pse_stage;
  db.prepare("UPDATE woms SET pse_stage = ?, pse_followup_at = ?, pse_stage_updated_at = ? WHERE code = ?").run(
    nextStage,
    followupAt,
    new Date().toISOString(),
    code
  );
  recordWomStatusChange(code, "pse_stage", previousStage, nextStage, { changedAt: new Date().toISOString(), changedBy: admin.id, source: "pse_action" });
  syncPseStageTask(code, previousStage, nextStage);
  if (action.closesWom) setWomStatus(code, "invoiced", { changedBy: admin.id, source: "pse_action" });

  return { wom: findWom(code) };
}

function setPseHold(code, { holdReason, holdNote }) {
  if (!findWom(code)) return null;
  if (holdReason && !PSE_HOLD_REASONS.includes(holdReason)) return { error: "invalid_reason" };
  db.prepare("UPDATE woms SET pse_hold_reason = ?, pse_hold_note = ? WHERE code = ?").run(
    holdReason || null,
    holdReason === "other" ? holdNote || null : null,
    code
  );
  refreshStageTask(code);
  return { wom: findWom(code) };
}

function setPseScheduleBlock(code, blocked) {
  if (!findWom(code)) return null;
  db.prepare("UPDATE woms SET pse_schedule_block = ? WHERE code = ?").run(blocked ? 1 : 0, code);
  return findWom(code);
}

// Hooked into a technician's own "mark complete" action -- only advances a
// WOM that was actually waiting to be worked (ready_to_schedule), so
// marking complete on a WOM outside this pipeline (or already past this
// point) never creates a phantom task.
function advancePseOnComplete(code) {
  const wom = db.prepare("SELECT pse_stage FROM woms WHERE code = ?").get(code);
  if (!wom || wom.pse_stage !== "ready_to_schedule") return;
  db.prepare("UPDATE woms SET pse_stage = 'check_expenses', pse_stage_updated_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  recordWomStatusChange(code, "pse_stage", "ready_to_schedule", "check_expenses", { source: "tech_complete" });
  syncPseStageTask(code, "ready_to_schedule", "check_expenses");
}

// ---- Task / workflow engine ----
//
// "States create tasks, tasks create timestamps, timestamps create
// analytics." A task is always generated off a WOM stage change or a
// recurring schedule, or entered by hand -- this is the operational engine
// behind Priorities/My Work, not a bare to-do list bolted on the side.

const TASK_STATUSES = ["open", "in_progress", "waiting", "completed", "cancelled"];
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
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
       source, source_record_id, workflow_rule, is_exception, created_by, created_at, assigned_at, last_status_change_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
     related_tech_id = ?, related_po = ?, workflow_rule = ?, is_exception = ?,
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
    fields.isException ? 1 : existing.is_exception,
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
    clauses.push("assigned_role = ?");
    params.push(filters.assignedRole);
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
    clauses.push("assigned_to IS NULL");
  }
  if (filters.dueOn) {
    clauses.push("due_at LIKE ?");
    params.push(`${filters.dueOn}%`);
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
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY due_at IS NULL, due_at, id DESC`).all(...params);
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

// What task (if any) should be open while a WOM sits at each pse_stage --
// upserted on entry, completed on exit, via a deterministic per-WOM source
// key (e.g. "WOM-20528831-REVIEW-EXPENSES") so re-syncing or re-clicking
// through the pipeline never creates a duplicate.
const PSE_STAGE_TASKS = {
  pse_review: (wom) => ({ suffix: "PRODUCE-PSE", title: `Produce PSE for ${wom.code}`, assignedRole: "reviewer", priority: "normal" }),
  awaiting_toyota_approval: (wom) => ({
    suffix: "TOYOTA-APPROVAL",
    title: `Follow up: Toyota approval for ${wom.code}`,
    assignedRole: "reviewer",
    priority: "normal",
    dueAt: wom.pse_followup_at,
  }),
  generate_wom_po: (wom) => ({ suffix: "CREATE-WOM-PO", title: `Create WOM / issue PO for ${wom.code}`, assignedRole: "financial", priority: "high" }),
  awaiting_toyota_po: (wom) => ({
    suffix: "TOYOTA-PO",
    title: `Follow up: Toyota PO # for ${wom.code}`,
    assignedRole: "reviewer",
    priority: "normal",
    dueAt: wom.pse_followup_at,
  }),
  schedule_blocked: (wom) => ({ suffix: "CLEAR-PO-BLOCK", title: `Clear PO block for ${wom.code}`, assignedRole: "reviewer", priority: "normal" }),
  ready_to_schedule: (wom) => ({ suffix: "SCHEDULE-WORK", title: `Schedule work for ${wom.code}`, assignedRole: "tech", priority: "high" }),
  check_expenses: (wom) => ({
    suffix: "REVIEW-EXPENSES",
    title: `Review expenses for ${wom.code}`,
    category: "financial",
    assignedRole: "financial",
    priority: "normal",
    isException: Boolean(wom.pse_hold_reason),
  }),
  pending_status95_approval: (wom) => ({
    suffix: "APPROVE-STATUS95",
    title: `Approve ${wom.code} for billing (Status 95)`,
    assignedRole: "reviewer",
    priority: "high",
  }),
  ready_to_invoice: (wom) => ({
    suffix: "GENERATE-BILL",
    title: `Generate batch and bill Toyota for ${wom.code}`,
    category: "financial",
    assignedRole: "financial",
    priority: "high",
  }),
};

function pseTaskSourceKey(womCode, suffix) {
  return `WOM-${womCode}-${suffix}`;
}

// Shared by syncPseStageTask (a real stage transition) and refreshStageTask
// (something about the *current* stage changed, like a hold being set --
// same task, same stage, just re-evaluating its fields such as isException).
function upsertCurrentStageTask(wom, stage) {
  const spec = stage && PSE_STAGE_TASKS[stage] ? PSE_STAGE_TASKS[stage](wom) : null;
  if (!spec) return;
  upsertTaskBySourceKey(pseTaskSourceKey(wom.code, spec.suffix), {
    title: spec.title,
    category: spec.category || "wom_workflow",
    assignedRole: spec.assignedRole,
    priority: spec.priority,
    dueAt: spec.dueAt || null,
    relatedWomCode: wom.code,
    relatedLocationCode: wom.location_code,
    isException: spec.isException,
    source: "wom_workflow",
    sourceRecordId: wom.code,
    workflowRule: stage,
  });
}

// A hold doesn't move pse_stage, but it changes whether the *current*
// stage's task should read as a workflow exception (see check_expenses in
// PSE_STAGE_TASKS) -- re-evaluate that task's fields against the fresh
// hold state rather than waiting for the next real stage transition.
function refreshStageTask(code) {
  const wom = findWom(code);
  if (wom && wom.pse_stage) upsertCurrentStageTask(wom, wom.pse_stage);
}

// Completes whichever task belongs to a WOM's OLD stage (if that stage has
// one) and upserts the one for its NEW stage (if that one does) -- the
// literal "states create tasks" rule, called every time pse_stage changes
// regardless of what triggered it (a button click or a sync).
function syncPseStageTask(womCode, previousStage, newStage) {
  const wom = findWom(womCode);
  if (!wom) return;

  // A snooze re-fires the same stage it's already on (just pushing the
  // follow-up date out) -- complete-then-reopen would be a pointless
  // round trip through "completed", so only the upsert below runs, which
  // already refreshes due_at on its own.
  if (previousStage && previousStage !== newStage && PSE_STAGE_TASKS[previousStage]) {
    completeTaskBySourceKey(pseTaskSourceKey(womCode, PSE_STAGE_TASKS[previousStage](wom).suffix));
  }
  upsertCurrentStageTask(wom, newStage);
  // Closing the pipeline should never leave a stray open task behind, even
  // if some earlier stage's task didn't get cleanly completed along the way
  // (e.g. it was reopened by a Status 95 rejection loop after this WOM had
  // already moved past it once).
  if (newStage === "closed") {
    for (const stageKey of Object.keys(PSE_STAGE_TASKS)) {
      completeTaskBySourceKey(pseTaskSourceKey(womCode, PSE_STAGE_TASKS[stageKey](wom).suffix));
    }
  }
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
}

// The "Last sync: ... / N tasks created / View Sync Details" panel needs
// this to survive a page reload, not just live in the response of the
// click that triggered it -- one row per sync, so it also doubles as a
// history of every sync ever run if that's ever useful later.
function recordSyncLog(fields) {
  db.prepare(
    `INSERT INTO wom_sync_log (synced_at, synced_by, woms_created, woms_promoted, woms_updated,
     tasks_created, tasks_completed, exceptions_flagged, total_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    fields.syncedBy || null,
    fields.womsCreated || 0,
    fields.womsPromoted || 0,
    fields.womsUpdated || 0,
    fields.tasksCreated || 0,
    fields.tasksCompleted || 0,
    fields.exceptionsFlagged || 0,
    fields.totalRows || 0
  );
  return getLastSyncLog();
}

function getLastSyncLog() {
  return db.prepare("SELECT * FROM wom_sync_log ORDER BY id DESC LIMIT 1").get() || null;
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

// `columns` names each Smartsheet column to pull from, as found by
// findColumn in server/utils/smartsheet.js: { wom, estimate, applied,
// description, dateRequested, maximo, location, subsidiary }. Any of them
// can be null if that column wasn't found -- that field is just skipped,
// same as before this became an options object (this used to be a long
// positional-argument list; a plain object stopped that from growing
// unreadable every time another sheet column needed pulling in).
function syncWomsFromSheetRows(rows, columns) {
  const { wom: womColumn, estimate: estimateColumn, applied: appliedColumn, description: descriptionColumn } = columns;
  const { dateRequested: dateRequestedColumn, maximo: maximoColumn, location: locationColumn, subsidiary: subsidiaryColumn } = columns;
  let created = 0;
  let promoted = 0;
  let updated = 0;
  const stamp = new Date().toISOString();

  for (const row of rows) {
    const rowId = row.__smartsheetRowId;
    if (!rowId) continue;

    const rawCode = womColumn ? row[womColumn] : null;
    const trimmedCode = rawCode != null ? String(rawCode).trim() : "";
    const realCode = trimmedCode && trimmedCode !== "0" ? trimmedCode : null;
    const requested = Boolean(dateRequestedColumn && String(row[dateRequestedColumn] ?? "").trim());
    const rowNumber = row.__smartsheetRowNumber || null;
    const description =
      (descriptionColumn && row[descriptionColumn] && String(row[descriptionColumn]).trim()) ||
      (rowNumber ? `Smartsheet request (Line ${rowNumber})` : `Smartsheet request (row ${rowId})`);
    const estimatedPrice = estimateColumn ? parseDollarAmount(row[estimateColumn]) : null;
    const appliedPrice = appliedColumn ? parseDollarAmount(row[appliedColumn]) : null;
    const maximoNumber = (maximoColumn && row[maximoColumn] && String(row[maximoColumn]).trim()) || null;
    const subsidiaryCode = (subsidiaryColumn && row[subsidiaryColumn] && String(row[subsidiaryColumn]).trim()) || null;
    const matchedLocationCode = locationColumn ? matchLocationCodeByName(row[locationColumn]) : null;
    const rawData = JSON.stringify(row);

    const existing = findWomBySmartsheetRowId(rowId);

    if (!existing) {
      const code = realCode || `PENDING-${rowId}`;
      // A real WOM # this app already has a record for, created some other
      // way (by hand, or an older sync before row-tracking existed) --
      // adopt it rather than erroring on a duplicate code.
      const collision = findWom(code);
      if (collision) {
        db.prepare(
          `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
           location_code = COALESCE(location_code, ?), smartsheet_raw_data = ?, smartsheet_synced_at = ?,
           smartsheet_row_number = ?, smartsheet_row_id = COALESCE(smartsheet_row_id, ?) WHERE code = ?`
        ).run(estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, rawData, stamp, rowNumber, rowId, code);
        updated++;
        ensurePseStage(code);
        continue;
      }
      const status = realCode ? "open" : requested ? "requested" : "pending";
      db.prepare(
        `INSERT INTO woms (code, description, status, estimated_price, applied_price, maximo_number, subsidiary_code,
         location_code, smartsheet_raw_data, smartsheet_row_id, smartsheet_row_number, smartsheet_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(code, description, status, estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, rawData, String(rowId), rowNumber, stamp);
      created++;
      ensurePseStage(code);
      continue;
    }

    if ((existing.status === "pending" || existing.status === "requested") && realCode) {
      db.prepare(
        `UPDATE woms SET code = ?, status = 'open', estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(realCode, estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, rawData, stamp, rowNumber, existing.code);
      promoted++;
      recordWomStatusChange(realCode, "status", existing.status, "open", { source: "smartsheet_sync" });
      ensurePseStage(realCode);
      continue;
    }

    if (existing.status === "pending" && requested) {
      db.prepare(
        `UPDATE woms SET status = 'requested', estimated_price = ?, applied_price = ?, maximo_number = ?,
         subsidiary_code = ?, location_code = COALESCE(location_code, ?), smartsheet_raw_data = ?, smartsheet_synced_at = ?,
         smartsheet_row_number = ? WHERE code = ?`
      ).run(estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, rawData, stamp, rowNumber, existing.code);
      updated++;
      recordWomStatusChange(existing.code, "status", "pending", "requested", { source: "smartsheet_sync" });
      ensurePseStage(existing.code);
      continue;
    }

    db.prepare(
      `UPDATE woms SET estimated_price = ?, applied_price = ?, maximo_number = ?, subsidiary_code = ?,
       location_code = COALESCE(location_code, ?), smartsheet_raw_data = ?, smartsheet_synced_at = ?,
       smartsheet_row_number = ? WHERE code = ?`
    ).run(estimatedPrice, appliedPrice, maximoNumber, subsidiaryCode, matchedLocationCode, rawData, stamp, rowNumber, existing.code);
    updated++;
    ensurePseStage(existing.code);
  }

  return { created, promoted, updated, total: rows.length };
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
  setTechnicianBasicInfo,
  NOTIFICATION_PREFS,
  setNotificationPref,
  CW_STATUSES,
  TOYOTA_STATUSES,
  FORMS_STATUSES,
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
  listWoms,
  findWom,
  createWom,
  countWomAllocatedHours,
  womHoursByTechnician,
  deleteWom,
  WOM_STATUSES,
  setWomStatus,
  PSE_STAGES,
  PSE_HOLD_REASONS,
  getPseReviewerId,
  setPseReviewer,
  ensurePseStage,
  listPseTasks,
  applyPseAction,
  setPseHold,
  setPseScheduleBlock,
  advancePseOnComplete,
  TASK_STATUSES,
  TASK_PRIORITIES,
  OPEN_TASK_STATUSES,
  createTask,
  findTask,
  findTaskBySourceKey,
  upsertTaskBySourceKey,
  completeTaskBySourceKey,
  setTaskStatus,
  assignTask,
  addTaskComment,
  listTaskComments,
  listTasks,
  recordWomStatusChange,
  listWomStatusHistory,
  ensureRecurringTasks,
  recordSyncLog,
  getLastSyncLog,
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
  listExpiringForms,
  listWeekendAddenda,
  listReportGapMonths,
};
