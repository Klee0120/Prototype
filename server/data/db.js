const fs = require("fs");
const path = require("path");
const { seed } = require("./seed");

const STORE_PATH = path.join(__dirname, "store.json");

let data;
if (fs.existsSync(STORE_PATH)) {
  data = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
} else {
  data = seed();
  persist();
}

function persist() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function weekKey(techId, weekMonday) {
  return `${techId}|${weekMonday}`;
}

// ---- Technicians ----

function findTechnician(id) {
  return data.technicians.find((t) => t.id.toUpperCase() === String(id).toUpperCase());
}

function listTechnicians() {
  return data.technicians.filter((t) => t.role === "tech");
}

function verifyLogin(id, pin) {
  const tech = findTechnician(id);
  if (!tech || !tech.active) return null;
  if (tech.pin !== pin) return null;
  return tech;
}

// ---- WOMs ----

function listWoms() {
  return data.woms;
}

function findWom(code) {
  return data.woms.find((w) => w.code === code);
}

function setWomStatus(code, status) {
  const wom = findWom(code);
  if (!wom) return null;
  wom.status = status;
  persist();
  return wom;
}

// ---- UKG hours (weekly source of truth) ----

function getUkgHours(techId, weekMonday) {
  const val = data.ukgHours[weekKey(techId, weekMonday)];
  return typeof val === "number" ? val : 0;
}

// ---- Weekly allocation records ----

function getWeek(techId, weekMonday) {
  const key = weekKey(techId, weekMonday);
  if (!data.weeks[key]) {
    data.weeks[key] = {
      status: "draft",
      allocations: [],
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      note: "",
    };
  }
  return data.weeks[key];
}

function saveAllocations(techId, weekMonday, allocations) {
  const week = getWeek(techId, weekMonday);
  week.allocations = allocations;
  persist();
  return week;
}

function submitWeek(techId, weekMonday) {
  const week = getWeek(techId, weekMonday);
  week.status = "submitted";
  week.submittedAt = new Date().toISOString();
  week.note = "";
  persist();
  return week;
}

function approveWeek(techId, weekMonday, adminId) {
  const week = getWeek(techId, weekMonday);
  week.status = "approved";
  week.reviewedAt = new Date().toISOString();
  week.reviewedBy = adminId;
  persist();
  return week;
}

function rejectWeek(techId, weekMonday, adminId, note) {
  const week = getWeek(techId, weekMonday);
  week.status = "rejected";
  week.reviewedAt = new Date().toISOString();
  week.reviewedBy = adminId;
  week.note = note || "";
  persist();
  return week;
}

function unlockWeek(techId, weekMonday, adminId) {
  const week = getWeek(techId, weekMonday);
  week.status = "draft";
  week.reviewedAt = new Date().toISOString();
  week.reviewedBy = adminId;
  persist();
  return week;
}

function listAllWeeks() {
  return data.weeks;
}

// ---- Audit log ----

function addAudit(actor, action, details) {
  const entry = {
    id: data.nextAuditId++,
    timestamp: new Date().toISOString(),
    actor,
    action,
    details,
  };
  data.auditLog.push(entry);
  persist();
  return entry;
}

function listAudit() {
  return [...data.auditLog].sort((a, b) => b.id - a.id);
}

module.exports = {
  findTechnician,
  listTechnicians,
  verifyLogin,
  listWoms,
  findWom,
  setWomStatus,
  getUkgHours,
  getWeek,
  saveAllocations,
  submitWeek,
  approveWeek,
  rejectWeek,
  unlockWeek,
  listAllWeeks,
  addAudit,
  listAudit,
};
