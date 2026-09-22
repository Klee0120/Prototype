const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES, datesForWeek, classifyWeekForTech, getOpenWeekMonday, currentWeekMonday } = require("../utils/week");
const { presentAllocation } = require("../utils/allocation");

const router = express.Router();

const TIME_OFF_TYPES = ["vacation", "sick", "bereavement", "holiday"];

// Sat/Sun are exempt from the submit-time UKG-match check -- see the
// mismatches loop in the submit route below.
const WEEKDAY_NAMES = DAY_NAMES.filter((d) => d !== "Sat" && d !== "Sun");

function canView(req, techId) {
  return req.user.role === "admin" || req.user.id === techId;
}

function isLocked(status) {
  return status === "submitted" || status === "approved";
}

// What a technician (or admin) is allowed to do with a given week right now:
// - "full": normal editing, all split types, can submit
// - "timeoff-only": the week's edit window hasn't opened yet -- only time
//   off can be pre-entered, no submit (nothing to balance against yet)
// - "locked": already submitted/approved, or the edit window has closed
// Admin is never restricted by the window -- only by the submitted/approved lock,
// same as before this feature existed. A rejected week is always "full" for the
// technician regardless of the window, so a late rejection never strands them.
function getEditMode(req, week, weekMonday) {
  if (req.user.role === "admin") return isLocked(week.status) ? "locked" : "full";
  if (isLocked(week.status)) return "locked";
  if (week.status === "rejected") return "full";
  const cls = classifyWeekForTech(weekMonday);
  if (cls === "open") return "full";
  if (cls === "past") return "locked";
  return "timeoff-only";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sumByDay(allocations) {
  const totals = Object.fromEntries(DAY_NAMES.map((d) => [d, 0]));
  for (const a of allocations) totals[a.day] = round2((totals[a.day] || 0) + Number(a.hours || 0));
  return totals;
}

// Which week a technician should land on by default: the currently-open
// week if there is one, otherwise this calendar week (which will render in
// "timeoff-only" mode until its own window opens -- see getEditMode).
router.get("/:id/open-week", requireAuth, (req, res) => {
  const { id } = req.params;
  if (!canView(req, id)) return res.status(403).json({ error: "Not authorized" });

  const openWeekMonday = getOpenWeekMonday();
  res.json({ weekMonday: openWeekMonday || currentWeekMonday(), isOpen: openWeekMonday !== null });
});

router.get("/:id/weeks/:weekMonday", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  if (!canView(req, tech.id)) return res.status(403).json({ error: "Not authorized" });

  const week = db.getWeek(tech.id, weekMonday);
  const ukgByDay = db.getUkgHoursByDay(tech.id, weekMonday);
  const ukgHoursByDay = Object.fromEntries(DAY_NAMES.map((d) => [d, ukgByDay[d] || 0]));
  const pendingPunchByDay = db.getPendingPunchByDay(tech.id, weekMonday);
  const pendingPunchDetailByDay = db.getPendingPunchDetailByDay(tech.id, weekMonday);
  const allocatedByDay = sumByDay(week.allocations);

  res.json({
    technician: {
      id: tech.id,
      name: tech.name,
      homeLocationCode: tech.home_location_code,
      email: tech.email,
      notificationPref: tech.notification_pref,
    },
    weekMonday,
    dates: datesForWeek(weekMonday),
    days: DAY_NAMES,
    ukgHoursByDay,
    pendingPunchByDay,
    pendingPunchDetailByDay,
    ukgTotal: round2(Object.values(ukgHoursByDay).reduce((s, h) => s + h, 0)),
    allocatedByDay,
    allocatedTotal: round2(Object.values(allocatedByDay).reduce((s, h) => s + h, 0)),
    status: week.status,
    locked: isLocked(week.status),
    editMode: getEditMode(req, week, weekMonday),
    allocations: week.allocations.map(presentAllocation),
    submittedAt: week.submittedAt,
    reviewedAt: week.reviewedAt,
    reviewedBy: week.reviewedBy,
    note: week.note,
    weekendAddendumAt: week.weekendAddendumAt,
  });
});

// A technician's own choice of how they want to hear "your hours are ready
// to allocate" -- in-app is always shown regardless, this only controls
// whether an email additionally goes out (see server/utils/mailer.js).
router.patch("/:id/notification-pref", requireAuth, (req, res) => {
  const { id } = req.params;
  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  if (!canView(req, id)) return res.status(403).json({ error: "Not authorized" });

  const { notificationPref } = req.body || {};
  if (!db.NOTIFICATION_PREFS.includes(notificationPref)) {
    return res.status(400).json({ error: `notificationPref must be one of: ${db.NOTIFICATION_PREFS.join(", ")}` });
  }
  if (notificationPref === "email" && !tech.email) {
    return res.status(400).json({ error: "Add an email address (Basic Info) before choosing email notifications" });
  }

  const updated = db.setNotificationPref(id, notificationPref);
  db.addAudit(req.user.id, "NOTIFICATION_PREF_CHANGED", `${req.user.name} set ${tech.name}'s notification preference to ${notificationPref}`);
  res.json({ notificationPref: updated.notification_pref });
});

// Shared by the normal PUT allocations route and the weekend-addendum
// route below -- validates and reshapes a raw allocations array into the
// { day, type, locationCode, womCode, hours } rows db.saveAllocations (or
// db.saveWeekendAllocations) expects. Returns { error } on the first
// problem found, or { normalized } on success.
function normalizeAllocations(allocations) {
  const normalized = [];
  for (const a of allocations) {
    if (!DAY_NAMES.includes(a.day)) return { error: `Invalid day: ${a.day}` };
    if (!["ef", "wom", "timeoff"].includes(a.type)) {
      return { error: `Invalid split type: ${a.type}` };
    }
    const hours = Number(a.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      return { error: `Invalid hours on ${a.day}` };
    }

    if (a.type === "timeoff") {
      if (!TIME_OFF_TYPES.includes(a.timeOffType)) {
        return { error: `Invalid time off type: ${a.timeOffType}` };
      }
      normalized.push({ day: a.day, type: "timeoff", locationCode: null, womCode: a.timeOffType, hours: round2(hours) });
      continue;
    }

    if (!a.locationCode || !db.findLocation(a.locationCode)) {
      return { error: `Unknown location: ${a.locationCode}` };
    }

    if (a.type === "wom") {
      const wom = db.findWom(a.womCode);
      if (!wom) return { error: `Unknown WOM: ${a.womCode}` };
      if (!db.WOM_ALLOCATABLE_STATUSES.includes(wom.status)) return { error: `WOM ${a.womCode} is not open` };
      if (wom.location_code !== a.locationCode) {
        return { error: `WOM ${a.womCode} does not belong to location ${a.locationCode}` };
      }
      normalized.push({ day: a.day, type: "wom", locationCode: a.locationCode, womCode: a.womCode, hours: round2(hours) });
    } else {
      normalized.push({ day: a.day, type: "ef", locationCode: a.locationCode, womCode: null, hours: round2(hours) });
    }
  }
  return { normalized };
}

router.put("/:id/weeks/:weekMonday/allocations", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (!canView(req, id)) {
    return res.status(403).json({ error: "Only the technician or an admin can edit these allocations" });
  }

  const week = db.getWeek(id, weekMonday);
  const editMode = getEditMode(req, week, weekMonday);
  if (editMode === "locked") {
    const reason = isLocked(week.status) ? `Week is ${week.status} and cannot be edited` : "This week is closed for edits";
    return res.status(409).json({ error: reason });
  }

  const allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : null;
  if (!allocations) return res.status(400).json({ error: "allocations array is required" });

  if (editMode === "timeoff-only" && allocations.some((a) => a.type !== "timeoff")) {
    return res.status(400).json({ error: "This week isn't open yet -- only time off can be entered in advance" });
  }

  const { error, normalized } = normalizeAllocations(allocations);
  if (error) return res.status(400).json({ error });

  db.saveAllocations(id, weekMonday, normalized);
  const onBehalf = req.user.role === "admin" && req.user.id !== id ? ` for ${id}` : "";
  db.addAudit(req.user.id, "ALLOCATIONS_SAVED", `${req.user.name} saved allocations${onBehalf} for week ${weekMonday}`);

  res.json({ ok: true });
});

// Lets a technician (or admin) log Saturday/Sunday hours for a week that's
// already submitted or approved -- e.g. a weekend callout that happened
// after the rest of the week was already locked in. Only Sat/Sun are
// touched (Mon-Fri stays exactly as already submitted/approved), and this
// always flags the week's weekend_addendum_at so admin has a clear signal
// something changed and needs a look, without silently reopening the
// whole week's approval.
router.put("/:id/weeks/:weekMonday/weekend-allocations", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (!canView(req, id)) {
    return res.status(403).json({ error: "Only the technician or an admin can edit these allocations" });
  }

  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : null;
  if (!allocations) return res.status(400).json({ error: "allocations array is required" });

  const weekendOnly = allocations.filter((a) => a.day !== "Sat" && a.day !== "Sun");
  if (weekendOnly.length > 0) {
    return res.status(400).json({ error: "This endpoint only accepts Saturday/Sunday allocations" });
  }

  const { error, normalized } = normalizeAllocations(allocations);
  if (error) return res.status(400).json({ error });

  // Deliberately no UKG-match check here -- unlike the normal weekly
  // submission, a tech logging a weekend callout may not know their exact
  // UKG hours yet (or UKG may not have caught up). They log what they
  // worked, it's flagged via weekend_addendum_at, and admin reviews and
  // adjusts it to match UKG's actual time before acknowledging it.
  const week = db.saveWeekendAllocations(id, weekMonday, normalized);
  const onBehalf = req.user.role === "admin" && req.user.id !== id ? ` for ${id}` : "";
  db.addAudit(
    req.user.id,
    "WEEKEND_ALLOCATIONS_SAVED",
    `${req.user.name} logged weekend hours${onBehalf} for week ${weekMonday} (flagged for review)`
  );

  res.json({ ok: true, weekendAddendumAt: week.weekendAddendumAt });
});

// Admin-only: correct the Sat/Sun hours a technician logged (if UKG's
// actual time came out different) and accept the addendum in the same
// step -- no separate "acknowledge" round trip, and never bounces back to
// the technician for their own re-approval. Whatever's sent here becomes
// the final Sat/Sun record; if admin didn't need to change anything, the
// UI just resubmits what the technician already logged.
router.post("/:id/weeks/:weekMonday/accept-weekend-hours", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(id, weekMonday);
  if (!week.weekendAddendumAt) {
    return res.status(409).json({ error: "This week has no pending weekend-hours addendum" });
  }

  const allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : null;
  if (!allocations) return res.status(400).json({ error: "allocations array is required" });

  const weekendOnly = allocations.filter((a) => a.day !== "Sat" && a.day !== "Sun");
  if (weekendOnly.length > 0) {
    return res.status(400).json({ error: "This endpoint only accepts Saturday/Sunday allocations" });
  }

  const { error, normalized } = normalizeAllocations(allocations);
  if (error) return res.status(400).json({ error });

  db.saveWeekendAllocations(id, weekMonday, normalized);

  // The hours admin just typed/confirmed here ARE this day's UKG total as
  // far as this app knows right now -- default the UKG hours field to match
  // so the row balances immediately instead of silently staying off until
  // admin remembers to separately retype the same number into UKG hours
  // (from timesheet) below. Still fully editable there afterward if the
  // real UKG punch comes out slightly different once admin keys it into
  // the actual UKG system.
  const ukgByDay = {};
  for (const a of normalized) {
    ukgByDay[a.day] = round2((ukgByDay[a.day] || 0) + a.hours);
  }
  if (Object.keys(ukgByDay).length > 0) db.setUkgHours(id, weekMonday, ukgByDay);

  const updated = db.acknowledgeWeekendAddendum(id, weekMonday);
  db.addAudit(
    req.user.id,
    "WEEKEND_HOURS_ACCEPTED",
    `${req.user.name} corrected and accepted weekend hours for ${tech.name}, week ${weekMonday}`
  );

  res.json({ ok: true, weekendAddendumAt: updated.weekendAddendumAt, allocations: updated.allocations.map(presentAllocation) });
});

// Lets a technician (or admin) flag a day's UKG punch as wrong/incomplete --
// a missed clock-out, etc. -- with an optional note, instead of the only
// path being a phone call or text to admin. Always (re-)flags with the
// given note; clearing it back is admin-only, either directly (PATCH
// .../pending-punch) or as part of resolving it with a correction below.
router.post("/:id/weeks/:weekMonday/report-punch-issue", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (!canView(req, id)) {
    return res.status(403).json({ error: "Only the technician or an admin can report this" });
  }

  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { day, note } = req.body || {};
  if (!DAY_NAMES.includes(day)) return res.status(400).json({ error: `Invalid day: ${day}` });

  const reportedBy = req.user.role === "admin" ? "admin" : "tech";
  const trimmedNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  const updated = db.setPendingPunch(id, weekMonday, day, true, trimmedNote, reportedBy);
  db.addAudit(req.user.id, "PUNCH_ISSUE_REPORTED", `${req.user.name} reported a punch issue for ${tech.name}, ${day} of week ${weekMonday}`);

  res.json({ ok: true, pendingPunchByDay: updated, pendingPunchDetailByDay: db.getPendingPunchDetailByDay(id, weekMonday) });
});

// Admin-only: fix a single flagged day's UKG hours AND its allocation
// together, and clear the flag -- all without unlocking the rest of an
// otherwise-fine, already-submitted/approved week (which would reset the
// whole thing to draft and force the technician to redo everything, not
// just the one day that actually changed). Mirrors accept-weekend-hours,
// generalized from "Sat/Sun" to "whichever single day is currently
// flagged pending."
router.post("/:id/weeks/:weekMonday/resolve-punch-issue", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { day, hours, allocations } = req.body || {};
  if (!DAY_NAMES.includes(day)) return res.status(400).json({ error: `Invalid day: ${day}` });

  const pendingByDay = db.getPendingPunchByDay(id, weekMonday);
  if (!pendingByDay[day]) return res.status(409).json({ error: `${day} has no pending punch issue to resolve` });

  const ukgHours = Number(hours);
  if (!Number.isFinite(ukgHours) || ukgHours < 0) return res.status(400).json({ error: "hours must be a non-negative number" });

  if (!Array.isArray(allocations)) return res.status(400).json({ error: "allocations array is required" });
  const otherDays = allocations.filter((a) => a.day !== day);
  if (otherDays.length > 0) {
    return res.status(400).json({ error: `This endpoint only accepts allocations for ${day}` });
  }

  const { error, normalized } = normalizeAllocations(allocations);
  if (error) return res.status(400).json({ error });

  db.saveDayAllocations(id, weekMonday, day, normalized);
  db.setUkgHours(id, weekMonday, { [day]: ukgHours });
  const pendingUpdated = db.setPendingPunch(id, weekMonday, day, false);
  db.addAudit(
    req.user.id,
    "PUNCH_ISSUE_RESOLVED",
    `${req.user.name} corrected ${day}'s hours and resolved the punch issue for ${tech.name}, week ${weekMonday}`
  );

  const week = db.getWeek(id, weekMonday);
  res.json({
    ok: true,
    pendingPunchByDay: pendingUpdated,
    allocations: week.allocations.map(presentAllocation),
    ukgHoursByDay: db.getUkgHoursByDay(id, weekMonday),
  });
});

router.post("/:id/weeks/:weekMonday/submit", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (!canView(req, id)) {
    return res.status(403).json({ error: "Only the technician or an admin can submit this week" });
  }

  const week = db.getWeek(id, weekMonday);
  if (isLocked(week.status)) {
    return res.status(409).json({ error: `Week is already ${week.status}` });
  }
  const editMode = getEditMode(req, week, weekMonday);
  if (editMode !== "full") {
    const reason = editMode === "timeoff-only" ? "This week isn't open for submission yet" : "This week is closed for submission";
    return res.status(409).json({ error: reason });
  }

  const ukgByDay = db.getUkgHoursByDay(id, weekMonday);
  const allocatedByDay = sumByDay(week.allocations);

  // Sat/Sun are exempt from the match requirement -- a weekend callout is
  // often allocated before UKG has caught up (or worked in odd, non-15-min
  // punch times admin will true up later), so it shouldn't block submitting
  // the rest of an otherwise-balanced week. Same leniency as the weekend
  // addendum endpoint; admin reconciles it at approval time either way.
  const mismatches = [];
  for (const day of WEEKDAY_NAMES) {
    const target = ukgByDay[day] || 0;
    const actual = allocatedByDay[day] || 0;
    if (Math.abs(target - actual) > 0.01) {
      mismatches.push({ day, allocated: actual, ukgHours: target });
    }
  }

  if (mismatches.length > 0) {
    return res.status(400).json({
      error: `Allocated hours must equal UKG hours for every day (off on ${mismatches.map((m) => m.day).join(", ")})`,
      mismatches,
    });
  }

  for (const a of week.allocations) {
    if (a.type !== "wom") continue;
    const wom = db.findWom(a.womCode);
    if (!wom || !db.WOM_ALLOCATABLE_STATUSES.includes(wom.status)) {
      return res.status(400).json({ error: `WOM ${a.womCode} is no longer open; update allocation before submitting` });
    }
  }

  db.submitWeek(id, weekMonday);
  const total = round2(Object.values(allocatedByDay).reduce((s, h) => s + h, 0));
  const onBehalf = req.user.role === "admin" && req.user.id !== id ? ` for ${id}` : "";
  db.addAudit(req.user.id, "WEEK_SUBMITTED", `${req.user.name} submitted week${onBehalf} ${weekMonday} (${total}h)`);

  res.json({ ok: true, status: "submitted" });
});

module.exports = router;
