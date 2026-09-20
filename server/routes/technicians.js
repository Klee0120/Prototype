const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES, datesForWeek } = require("../utils/week");

const router = express.Router();

const TIME_OFF_TYPES = ["vacation", "sick", "bereavement", "holiday"];

function canView(req, techId) {
  return req.user.role === "admin" || req.user.id === techId;
}

function isLocked(status) {
  return status === "submitted" || status === "approved";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sumByDay(allocations) {
  const totals = Object.fromEntries(DAY_NAMES.map((d) => [d, 0]));
  for (const a of allocations) totals[a.day] = round2((totals[a.day] || 0) + Number(a.hours || 0));
  return totals;
}

// Time-off rows are stored using the same columns as WOM rows (womCode
// holds the time-off type instead of a WOM code) to avoid a parallel table;
// translate that back to a clearer shape for API consumers.
function presentAllocation(a) {
  if (a.type === "timeoff") {
    return { day: a.day, type: "timeoff", timeOffType: a.womCode, hours: a.hours };
  }
  return a;
}

router.get("/:id/weeks/:weekMonday", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  if (!canView(req, tech.id)) return res.status(403).json({ error: "Not authorized" });

  const week = db.getWeek(tech.id, weekMonday);
  const ukgByDay = db.getUkgHoursByDay(tech.id, weekMonday);
  const ukgHoursByDay = Object.fromEntries(DAY_NAMES.map((d) => [d, ukgByDay[d] || 0]));
  const allocatedByDay = sumByDay(week.allocations);

  res.json({
    technician: { id: tech.id, name: tech.name, homeLocationCode: tech.home_location_code },
    weekMonday,
    dates: datesForWeek(weekMonday),
    days: DAY_NAMES,
    ukgHoursByDay,
    ukgTotal: round2(Object.values(ukgHoursByDay).reduce((s, h) => s + h, 0)),
    allocatedByDay,
    allocatedTotal: round2(Object.values(allocatedByDay).reduce((s, h) => s + h, 0)),
    status: week.status,
    locked: isLocked(week.status),
    allocations: week.allocations.map(presentAllocation),
    submittedAt: week.submittedAt,
    reviewedAt: week.reviewedAt,
    reviewedBy: week.reviewedBy,
    note: week.note,
  });
});

router.put("/:id/weeks/:weekMonday/allocations", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (req.user.role !== "tech" || req.user.id !== id) {
    return res.status(403).json({ error: "Only the technician can edit their own allocations" });
  }

  const week = db.getWeek(id, weekMonday);
  if (isLocked(week.status)) {
    return res.status(409).json({ error: `Week is ${week.status} and cannot be edited` });
  }

  const allocations = Array.isArray(req.body && req.body.allocations) ? req.body.allocations : null;
  if (!allocations) return res.status(400).json({ error: "allocations array is required" });

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
  db.addAudit(req.user.id, "ALLOCATIONS_SAVED", `${req.user.name} saved allocations for week ${weekMonday}`);

  res.json({ ok: true });
});

router.post("/:id/weeks/:weekMonday/submit", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  if (req.user.role !== "tech" || req.user.id !== id) {
    return res.status(403).json({ error: "Only the technician can submit their own week" });
  }

  const week = db.getWeek(id, weekMonday);
  if (isLocked(week.status)) {
    return res.status(409).json({ error: `Week is already ${week.status}` });
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
  db.addAudit(req.user.id, "WEEK_SUBMITTED", `${req.user.name} submitted week ${weekMonday} (${total}h)`);

  res.json({ ok: true, status: "submitted" });
});

module.exports = router;
