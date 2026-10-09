const { runSmartsheetSync } = require("./utils/smartsheetSync");

// Krista: sync 3x on business days (Mon-Fri), 8am/12pm/4pm Eastern --
// instead of relying on someone remembering to click "Sync WOMs." Business
// day here just means weekday; this doesn't know about actual holidays
// (the uploaded Close Calendar's own Holidays sheet isn't wired in) -- a
// sync on a holiday is harmless, it just runs against whatever Smartsheet
// already has, same as any other day.
const SYNC_TIMES = ["08:00", "12:00", "16:00"];
const TIMEZONE = "America/New_York";

// Minute-granularity, not a real cron library -- three fixed times a day
// doesn't need one, and this avoids adding a dependency for it. Checks the
// wall clock in TIMEZONE (not the server's own timezone, which may differ)
// once a minute and fires once per matching minute.
function currentPartsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    weekday: get("weekday"), // "Mon".."Sun"
    hhmm: `${get("hour")}:${get("minute")}`,
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

const BUSINESS_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

// Pure decision, pulled out of the timer loop so it's testable without
// mocking setInterval or real wall-clock time: should a sync fire for this
// exact instant, and if so, what's its dedupe key ("YYYY-MM-DD HH:mm")?
// null means no, not a matching business-day/time slot right now.
function fireKeyFor(date) {
  const { weekday, hhmm, dateKey } = currentPartsInTimezone(date, TIMEZONE);
  if (!BUSINESS_DAYS.has(weekday) || !SYNC_TIMES.includes(hhmm)) return null;
  return `${dateKey} ${hhmm}`;
}

function startSmartsheetAutoSync() {
  let isRunning = false;
  let lastFiredKey = null; // guards against firing twice in the same matching minute

  async function tick() {
    const key = fireKeyFor(new Date());
    if (!key || key === lastFiredKey || isRunning) return;
    lastFiredKey = key;
    isRunning = true;
    try {
      const result = await runSmartsheetSync({ actorId: "scheduled", actorName: "Scheduled Sync" });
      console.log(
        `[scheduled sync] ${key} ${TIMEZONE}: ${result.created} created, ${result.promoted} promoted, ${result.updated} updated`
      );
    } catch (err) {
      console.error(`[scheduled sync] ${key} ${TIMEZONE} failed:`, err.message);
    } finally {
      isRunning = false;
    }
  }

  const interval = setInterval(tick, 60 * 1000);
  // Unref so this timer alone never keeps the process alive (tests that
  // spin up a server via createApp() never call this function at all, but
  // this keeps the same safety property any long-lived timer in this app
  // should have).
  interval.unref();
  return interval;
}

module.exports = { startSmartsheetAutoSync, fireKeyFor, currentPartsInTimezone, SYNC_TIMES, TIMEZONE };
