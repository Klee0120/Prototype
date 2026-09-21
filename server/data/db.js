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
    position TEXT
  );

  CREATE TABLE IF NOT EXISTS woms (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    location_code TEXT,
    budget_hours REAL,
    subsidiary_code TEXT
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
    uploaded_at TEXT NOT NULL
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

// Flags a specific day as waiting on a real UKG punch correction (a missed
// clock-out, etc.) -- visible to the technician so a wrong/zero UKG number
// reads as "not final yet" rather than "admin forgot about me".
if (!hasColumn("ukg_hours", "pending_punch")) {
  db.exec("ALTER TABLE ukg_hours ADD COLUMN pending_punch INTEGER NOT NULL DEFAULT 0");
}

// A device is either a phone (device_name holds the phone number) or a
// laptop (device_name holds an asset tag/serial) -- existing rows predate
// this distinction, so they default to "phone" since that's what the old
// single free-text field was actually labeled.
if (!hasColumn("tech_devices", "device_type")) {
  db.exec("ALTER TABLE tech_devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'phone'");
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
if (!hasColumn("woms", "subsidiary_code")) {
  db.exec("ALTER TABLE woms ADD COLUMN subsidiary_code TEXT");
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

const DEVICE_TYPES = ["phone", "laptop"];

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
      "SELECT id, device_type AS deviceType, device_name AS deviceName, notes, assigned_at AS assignedAt FROM tech_devices WHERE tech_id = ? ORDER BY id DESC"
    )
    .all(techId);
  return devices.map((d) => ({ ...d, requests: listDeviceRequests(d.id) }));
}

function addDevice(techId, deviceType, deviceName, notes) {
  db.prepare("INSERT INTO tech_devices (tech_id, device_type, device_name, notes, assigned_at) VALUES (?, ?, ?, ?, ?)").run(
    techId,
    deviceType,
    deviceName,
    notes || "",
    new Date().toISOString()
  );
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

function createLocation(code, name, efJobNumber, region) {
  db.prepare("INSERT INTO locations (code, name, ef_job_number, region) VALUES (?, ?, ?, ?)").run(
    code,
    name,
    efJobNumber || null,
    region || null
  );
  return findLocation(code);
}

function setLocationDetails(code, { name, efJobNumber, region } = {}) {
  if (!findLocation(code)) return null;
  db.prepare("UPDATE locations SET name = ?, ef_job_number = ?, region = ? WHERE code = ?").run(
    name,
    efJobNumber || null,
    region || null,
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

function setWomStatus(code, status) {
  if (!findWom(code)) return null;
  db.prepare("UPDATE woms SET status = ? WHERE code = ?").run(status, code);
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

function setPendingPunch(techId, weekMonday, day, flagged) {
  db.prepare(
    `INSERT INTO ukg_hours (tech_id, week_monday, day, hours, pending_punch) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (tech_id, week_monday, day) DO UPDATE SET pending_punch = excluded.pending_punch`
  ).run(techId, weekMonday, day, flagged ? 1 : 0);
  return getPendingPunchByDay(techId, weekMonday);
}

// ---- Weekly allocation records ----

function getWeek(techId, weekMonday) {
  const row = db
    .prepare(
      "SELECT status, submitted_at, reviewed_at, reviewed_by, note, ukg_confirmed_at, ukg_confirmed_by FROM weeks WHERE tech_id = ? AND week_monday = ?"
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
  };
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
    INSERT INTO files (id, related_type, related_id, category, original_name, stored_name, mime_type, size, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    file.uploadedAt
  );
  return getFile(file.id);
}

function listFiles(relatedType, relatedId) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt
       FROM files WHERE related_type = ? AND related_id = ? ORDER BY uploaded_at DESC`
    )
    .all(relatedType, relatedId);
}

function getFile(id) {
  return db
    .prepare(
      `SELECT id, related_type AS relatedType, related_id AS relatedId, category, original_name AS originalName,
              stored_name AS storedName, mime_type AS mimeType, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt
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

module.exports = {
  UPLOADS_DIR,
  findTechnician,
  listTechnicians,
  verifyLogin,
  setHomeLocation,
  EMPLOYMENT_STATUSES,
  setEmploymentStatus,
  createTechnician,
  setTechnicianBasicInfo,
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
  getAllocationHistory,
  listLocations,
  findLocation,
  createLocation,
  setLocationDetails,
  listWoms,
  findWom,
  createWom,
  setWomStatus,
  setWomDetails,
  getUkgHoursByDay,
  setUkgHours,
  getPendingPunchByDay,
  setPendingPunch,
  getWeek,
  saveAllocations,
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
};
