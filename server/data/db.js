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
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    home_location_code TEXT
  );

  CREATE TABLE IF NOT EXISTS woms (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    location_code TEXT,
    budget_hours REAL
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
`);

seedIfEmpty();

function seedIfEmpty() {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM technicians").get();
  if (count > 0) return;

  const data = seed();

  const insertLocation = db.prepare("INSERT INTO locations (code, name) VALUES (?, ?)");
  for (const l of data.locations) insertLocation.run(l.code, l.name);

  const insertTech = db.prepare(
    "INSERT INTO technicians (id, name, pin, role, active, home_location_code) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const t of data.technicians) insertTech.run(t.id, t.name, hashPin(t.pin), t.role, t.active, t.homeLocationCode);

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

function verifyLogin(id, pin) {
  const tech = findTechnician(id);
  if (!tech || !tech.active) return null;
  if (!verifyPin(pin, tech.pin)) return null;
  return tech;
}

function setHomeLocation(techId, locationCode) {
  db.prepare("UPDATE technicians SET home_location_code = ? WHERE id = ?").run(locationCode, techId);
  return findTechnician(techId);
}

// ---- Locations ----

function listLocations() {
  return db.prepare("SELECT * FROM locations ORDER BY name").all();
}

function findLocation(code) {
  return db.prepare("SELECT * FROM locations WHERE code = ?").get(code);
}

function createLocation(code, name) {
  db.prepare("INSERT INTO locations (code, name) VALUES (?, ?)").run(code, name);
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

function createWom(code, description, locationCode, budgetHours) {
  db.prepare("INSERT INTO woms (code, description, status, location_code, budget_hours) VALUES (?, ?, 'open', ?, ?)").run(
    code,
    description,
    locationCode || null,
    budgetHours == null ? null : Number(budgetHours)
  );
  return findWom(code);
}

function setWomStatus(code, status) {
  if (!findWom(code)) return null;
  db.prepare("UPDATE woms SET status = ? WHERE code = ?").run(status, code);
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

// ---- Weekly allocation records ----

function getWeek(techId, weekMonday) {
  const row = db
    .prepare("SELECT status, submitted_at, reviewed_at, reviewed_by, note FROM weeks WHERE tech_id = ? AND week_monday = ?")
    .get(techId, weekMonday);
  const allocations = db
    .prepare(
      `SELECT day, type, location_code AS locationCode, wom_code AS womCode, hours
       FROM allocations WHERE tech_id = ? AND week_monday = ? ORDER BY id`
    )
    .all(techId, weekMonday);

  if (!row) {
    return { status: "draft", allocations, submittedAt: null, reviewedAt: null, reviewedBy: null, note: "" };
  }
  return {
    status: row.status,
    allocations,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    note: row.note || "",
  };
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
  listLocations,
  findLocation,
  createLocation,
  listWoms,
  findWom,
  createWom,
  setWomStatus,
  getUkgHoursByDay,
  setUkgHours,
  getWeek,
  saveAllocations,
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
