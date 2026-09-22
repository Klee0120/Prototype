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

function createTechnician({ id, name, pin, homeLocationCode, email, phone, ukgId, position }) {
  db.prepare(
    `INSERT INTO technicians (id, name, pin, role, active, employment_status, home_location_code, email, phone, ukg_id, position)
     VALUES (?, ?, ?, 'tech', 1, 'active', ?, ?, ?, ?, ?)`
  ).run(id, name, hashPin(pin), homeLocationCode || null, email || null, phone || null, ukgId || null, position || null);
  return findTechnician(id);
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

function createWom(code, description, locationCode, budgetHours, subsidiaryCode) {
  db.prepare(
    "INSERT INTO woms (code, description, status, location_code, budget_hours, subsidiary_code) VALUES (?, ?, 'open', ?, ?, ?)"
  ).run(
    code,
    description,
    locationCode || null,
    budgetHours == null ? null : Number(budgetHours),
    subsidiaryCode || null
  );
  return findWom(code);
}

// "pending" is a WOM request that's been added to the Smartsheet tracker
// but hasn't reached the point in the real PSE process where admin creates
// the actual WOM and issues the PO with a real WOM # (steps 1-8 of the
// process; the WOM # only exists from step 9 onward) -- technicians can't
// allocate hours against one (same "must be open" check as any other
// non-open WOM), it exists here purely so admin/RFM can track and act on
// it before it's a real job. "invoiced" sits between open and closed --
// work is done and billed, but not yet formally closed out. Any status is
// settable by an admin at any time (see routes/woms.js), independent of a
// technician's own "mark complete" action, which only ever sets "closed"
// directly.
const WOM_STATUSES = ["pending", "open", "invoiced", "closed"];

function setWomStatus(code, status) {
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
  }
  return findWom(code);
}

function markWomSmartsheetReflected(code) {
  const wom = findWom(code);
  if (!wom || wom.status !== "closed") return null;
  db.prepare("UPDATE woms SET smartsheet_reflected_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  return findWom(code);
}

function setWomDetails(code, { description, locationCode, budgetHours, subsidiaryCode } = {}) {
  if (!findWom(code)) return null;
  db.prepare(
    "UPDATE woms SET description = ?, location_code = ?, budget_hours = ?, subsidiary_code = ? WHERE code = ?"
  ).run(
    description,
    locationCode || null,
    budgetHours == null ? null : Number(budgetHours),
    subsidiaryCode || null,
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
// after its code changes:
//   - A row with a real WOM # assigned syncs as a normal 'open' WOM, coded
//     with that real number.
//   - A row with no WOM # yet (still just a request -- per the real PSE
//     process, that only exists from the point admin creates the WOM and
//     issues the PO onward) syncs as a 'pending' WOM instead, coded
//     "PENDING-<row id>" since there's no real number yet. Technicians
//     can't allocate hours against a non-open WOM, so this is purely
//     visible/trackable for admin/RFM until it's a real job.
//   - The first time a later sync finds a real WOM # for a row that's
//     still 'pending' here, that record is "promoted": renamed to the real
//     code and moved to 'open'. After that, this never touches status
//     again -- an admin's later invoiced/closed doesn't get overwritten.
function syncWomsFromSheetRows(rows, womColumn, estimateColumn, appliedColumn, descriptionColumn) {
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
    const description = (descriptionColumn && row[descriptionColumn] && String(row[descriptionColumn]).trim()) || `Smartsheet request (row ${rowId})`;
    const estimatedPrice = estimateColumn ? parseDollarAmount(row[estimateColumn]) : null;
    const appliedPrice = appliedColumn ? parseDollarAmount(row[appliedColumn]) : null;

    const existing = findWomBySmartsheetRowId(rowId);

    if (!existing) {
      const code = realCode || `PENDING-${rowId}`;
      // A real WOM # this app already has a record for, created some other
      // way (by hand, or an older sync before row-tracking existed) --
      // adopt it rather than erroring on a duplicate code.
      const collision = findWom(code);
      if (collision) {
        db.prepare(
          "UPDATE woms SET estimated_price = ?, applied_price = ?, smartsheet_synced_at = ?, smartsheet_row_id = COALESCE(smartsheet_row_id, ?) WHERE code = ?"
        ).run(estimatedPrice, appliedPrice, stamp, rowId, code);
        updated++;
        continue;
      }
      db.prepare(
        "INSERT INTO woms (code, description, status, estimated_price, applied_price, smartsheet_row_id, smartsheet_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(code, description, realCode ? "open" : "pending", estimatedPrice, appliedPrice, String(rowId), stamp);
      created++;
      continue;
    }

    if (existing.status === "pending" && realCode) {
      db.prepare(
        "UPDATE woms SET code = ?, status = 'open', estimated_price = ?, applied_price = ?, smartsheet_synced_at = ? WHERE code = ?"
      ).run(realCode, estimatedPrice, appliedPrice, stamp, existing.code);
      promoted++;
      continue;
    }

    db.prepare("UPDATE woms SET estimated_price = ?, applied_price = ?, smartsheet_synced_at = ? WHERE code = ?").run(
      estimatedPrice,
      appliedPrice,
      stamp,
      existing.code
    );
    updated++;
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
  listAdmins,
  createAdmin,
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
  setLocationDetails,
  listWoms,
  findWom,
  createWom,
  WOM_STATUSES,
  setWomStatus,
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
