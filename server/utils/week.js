const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Returns the Monday (as YYYY-MM-DD) of the week containing the given date. */
function mondayOf(date) {
  const d = toDateOnly(date);
  const dow = d.getDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diffToMonday);
  return formatISO(d);
}

function formatISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Given a Monday ISO date string, returns the 7 ISO dates Mon..Sun. */
function datesForWeek(mondayIso) {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const monday = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(monday.getTime());
    dt.setDate(monday.getDate() + i);
    out.push(formatISO(dt));
  }
  return out;
}

function currentWeekMonday() {
  return mondayOf(new Date());
}

function shiftWeek(mondayIso, deltaWeeks) {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaWeeks * 7);
  return formatISO(dt);
}

// ---- Technician edit window (Thu 12am - Mon 12pm, in BUSINESS_TIMEZONE) ----
//
// Only one week is ever open for a technician's own full allocation at a
// time: the week whose Thursday-through-Monday-noon window "now" falls in.
// Outside that window there's a real gap (Mon noon - Wed night) where no
// week is fully open, by design -- nothing to enter yet for the coming
// week, and the just-finished week is already closed out for processing.
const BUSINESS_TIMEZONE = "America/New_York";

// Test-only seam: lets tests pin "now" without waiting on the real clock or
// depending on which day/time the test happens to run. Never set outside tests.
let _testNow = null;
function setTestNow(fakeBusinessNow) {
  _testNow = fakeBusinessNow;
}

// Returns a Date whose UTC getters (getUTCDay, getUTCHours, ...) reflect the
// current wall-clock date/time in BUSINESS_TIMEZONE -- a deliberate misuse of
// UTC fields as a stand-in for "business-local fields" so the rest of this
// module never has to touch the server's own local timezone.
function businessNow() {
  if (_testNow) return _testNow;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second)));
}

// Builds a businessNow()-shaped Date directly from wall-clock fields, for tests.
function businessNowFromParts(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
}

function mondayOfBusinessDate(d) {
  const dow = d.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d.getTime());
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return formatISOFromUTC(monday);
}

function formatISOFromUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The Monday (ISO) of the one week currently open for a technician's full
 * allocation, or null if we're in the gap between windows. */
function getOpenWeekMonday(now = businessNow()) {
  const dow = now.getUTCDay(); // 0=Sun..6=Sat
  const hour = now.getUTCHours();
  const thisMonday = mondayOfBusinessDate(now);

  if (dow === 4 || dow === 5 || dow === 6 || dow === 0) {
    // Thu, Fri, Sat, Sun: this week's window is open.
    return thisMonday;
  }
  if (dow === 1 && hour < 12) {
    // Monday before noon: last week's window is still open, closing today.
    return shiftWeek(thisMonday, -1);
  }
  // Monday after noon, Tue, or Wed: the gap.
  return null;
}

/** Classifies weekMonday from a technician's point of view: 'open' (fully
 * editable), 'past' (window already closed, no longer touchable), or
 * 'future' (window hasn't started -- time off only). */
function classifyWeekForTech(weekMonday, now = businessNow()) {
  const open = getOpenWeekMonday(now);
  if (open !== null) {
    if (weekMonday === open) return "open";
    return weekMonday < open ? "past" : "future";
  }
  const ref = mondayOfBusinessDate(now);
  return weekMonday < ref ? "past" : "future";
}

module.exports = {
  DAY_NAMES,
  MS_PER_DAY,
  mondayOf,
  formatISO,
  datesForWeek,
  currentWeekMonday,
  shiftWeek,
  BUSINESS_TIMEZONE,
  businessNow,
  businessNowFromParts,
  getOpenWeekMonday,
  classifyWeekForTech,
  setTestNow,
};
