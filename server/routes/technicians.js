const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES, datesForWeek, classifyWeekForTech, getOpenWeekMonday, currentWeekMonday } = require("../utils/week");
const { presentAllocation } = require("../utils/allocation");

const router = express.Router();

const TIME_OFF_TYPES = ["vacation", "sick", "bereavement", "holiday"];

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

  const normalized = [];
  for (const a of allocations) {
    if (!DAY_NAMES.includes(a.day)) return res.status(400).json({ error: `Invalid day: ${a.day}` });
    if (!["ef", "wom", "timeoff"].includes(a.type)) {
      return res.status(400).json({ error: `Invalid split type: ${a.type}` });
    }
    const hours = Number(a.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ error: `Invalid hours on ${a.day}` });
    }

    if (a.type === "timeoff") {
      if (!TIME_OFF_TYPES.includes(a.timeOffType)) {
        return res.status(400).json({ error: `Invalid time off type: ${a.timeOffType}` });
      }
      normalized.push({ day: a.day, type: "timeoff", locationCode: null, womCode: a.timeOffType, hours: round2(hours) });
      continue;
    }

    if (!a.locationCode || !db.findLocation(a.locationCode)) {
      return res.status(400).json({ error: `Unknown location: ${a.locationCode}` });
    }

    if (a.type === "wom") {
      const wom = db.findWom(a.womCode);
      if (!wom) return res.status(400).json({ error: `Unknown WOM: ${a.womCode}` });
      if (wom.status !== "open") return res.status(400).json({ error: `WOM ${a.womCode} is not open` });
      if (wom.location_code !== a.locationCode) {
        return res.status(400).json({ error: `WOM ${a.womCode} does not belong to location ${a.locationCode}` });
      }
      normalized.push({ day: a.day, type: "wom", locationCode: a.locationCode, womCode: a.womCode, hours: round2(hours) });
    } else {
      normalized.push({ day: a.day, type: "ef", locationCode: a.locationCode, womCode: null, hours: round2(hours) });
    }
  }

  db.saveAllocations(id, weekMonday, normalized);
  const onBehalf = req.user.role === "admin" && req.user.id !== id ? ` for ${id}` : "";
  db.addAudit(req.user.id, "ALLOCATIONS_SAVED", `${req.user.name} saved allocations${onBehalf} for week ${weekMonday}`);

  res.json({ ok: true });
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

  const mismatches = [];
  for (const day of DAY_NAMES) {
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
    if (!wom || wom.status !== "open") {
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
