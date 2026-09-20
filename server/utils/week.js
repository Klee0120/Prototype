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

module.exports = {
  DAY_NAMES,
  MS_PER_DAY,
  mondayOf,
  formatISO,
  datesForWeek,
  currentWeekMonday,
  shiftWeek,
};
