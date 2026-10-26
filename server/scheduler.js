const { runSmartsheetSync } = require("./utils/smartsheetSync");
const { runBackup } = require("./utils/backup");
const { sendVendorComplianceReminders } = require("./utils/vendorComplianceReminders");
const db = require("./data/db");

// Krista: sync 3x on business days (Mon-Fri), 8am/12pm/4pm Eastern --
// instead of relying on someone remembering to click "Sync WOMs." Business
// day here just means weekday; this doesn't know about actual holidays
// (the uploaded Close Calendar's own Holidays sheet isn't wired in) -- a
// sync on a holiday is harmless, it just runs against whatever Smartsheet
// already has, same as any other day.
const SYNC_TIMES = ["08:00", "12:00", "16:00"];
const TIMEZONE = "America/New_York";

// Once a day, every day (not just business days -- techs can allocate
// weekend hours, so data changes on weekends too), at a low-traffic hour.
const BACKUP_TIME = "02:00";

// Once a day, business days only -- a vendor getting an automated renewal
// nag at a normal business hour reads as a real process, not a 3am robot.
const COMPLIANCE_REMINDER_TIME = "09:00";

// Once a day, every day (not just business days -- an accrual or a Sick
// grant landing on a hire-date anniversary or Jan 1 doesn't care what day
// of the week it is), at a low-traffic hour -- purely an internal data
// write (no outbound email), so unlike the vendor reminders above this is
// safe to run unconditionally rather than gated behind an opt-in flag.
const TIME_OFF_ACCRUAL_TIME = "01:30";

// Minute-granularity, not a real cron library -- a handful of fixed times
// a day doesn't need one, and this avoids adding a dependency for it.
// Checks the wall clock in TIMEZONE (not the server's own timezone, which
// may differ) once a minute and fires once per matching minute.
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
// mocking setInterval or real wall-clock time: should a job on this
// schedule fire for this exact instant, and if so, what's its dedupe key
// ("YYYY-MM-DD HH:mm")? null means no, not a matching slot right now.
// The options default to the original Smartsheet-sync schedule, so every
// existing fireKeyFor(date) call site (and its tests) keeps behaving
// exactly as before -- this is a generalization of that one job's
// schedule-matching logic, not a new schedule.
function fireKeyFor(date, { times = SYNC_TIMES, timezone = TIMEZONE, businessDaysOnly = true } = {}) {
  const { weekday, hhmm, dateKey } = currentPartsInTimezone(date, timezone);
  if (businessDaysOnly && !BUSINESS_DAYS.has(weekday)) return null;
  if (!times.includes(hhmm)) return null;
  return `${dateKey} ${hhmm}`;
}

// Shared by every fixed-time scheduled job below: ticks once a minute,
// fires `run` at most once per matching minute (per fireKeyFor's dedupe
// key), and never lets a slow run overlap the next matching minute.
function startDailyTrigger({ label, run, times, timezone, businessDaysOnly }) {
  let isRunning = false;
  let lastFiredKey = null;

  async function tick() {
    const key = fireKeyFor(new Date(), { times, timezone, businessDaysOnly });
    if (!key || key === lastFiredKey || isRunning) return;
    lastFiredKey = key;
    isRunning = true;
    try {
      await run(key);
    } catch (err) {
      console.error(`[${label}] ${key} failed:`, err.message);
    } finally {
      isRunning = false;
    }
  }

  const interval = setInterval(tick, 60 * 1000);
  // Unref so this timer alone never keeps the process alive (tests that
  // spin up a server via createApp() never call any of these start*
  // functions at all, but this keeps the same safety property any
  // long-lived timer in this app should have).
  interval.unref();
  return interval;
}

function startSmartsheetAutoSync() {
  return startDailyTrigger({
    label: "scheduled sync",
    times: SYNC_TIMES,
    timezone: TIMEZONE,
    businessDaysOnly: true,
    run: async (key) => {
      const result = await runSmartsheetSync({ actorId: "scheduled", actorName: "Scheduled Sync" });
      console.log(
        `[scheduled sync] ${key} ${TIMEZONE}: ${result.created} created, ${result.promoted} promoted, ${result.updated} updated`
      );
    },
  });
}

function startNightlyBackup() {
  return startDailyTrigger({
    label: "nightly backup",
    times: [BACKUP_TIME],
    timezone: TIMEZONE,
    businessDaysOnly: false,
    run: async (key) => {
      const result = await runBackup();
      console.log(`[nightly backup] ${key} ${TIMEZONE}: db -> ${result.dbBackupPath}, uploads -> ${result.uploadsBackupDir}, pruned ${result.pruned} old`);
    },
  });
}

function startVendorComplianceReminders() {
  return startDailyTrigger({
    label: "vendor compliance reminders",
    times: [COMPLIANCE_REMINDER_TIME],
    timezone: TIMEZONE,
    businessDaysOnly: true,
    run: async (key) => {
      const result = await sendVendorComplianceReminders();
      console.log(`[vendor compliance reminders] ${key} ${TIMEZONE}: ${result.emailed}/${result.checked} emailed${result.failures.length ? `, ${result.failures.length} failed` : ""}`);
    },
  });
}

function startTimeOffAccrual() {
  return startDailyTrigger({
    label: "time-off accrual",
    times: [TIME_OFF_ACCRUAL_TIME],
    timezone: TIMEZONE,
    businessDaysOnly: false,
    run: async (key) => {
      const result = db.runTimeOffAccrual();
      console.log(`[time-off accrual] ${key} ${TIMEZONE}: ${result.posted} event(s) posted for ${result.asOf}`);
    },
  });
}

module.exports = {
  startSmartsheetAutoSync,
  startNightlyBackup,
  startVendorComplianceReminders,
  startTimeOffAccrual,
  fireKeyFor,
  currentPartsInTimezone,
  SYNC_TIMES,
  TIMEZONE,
  BACKUP_TIME,
  COMPLIANCE_REMINDER_TIME,
  TIME_OFF_ACCRUAL_TIME,
};
