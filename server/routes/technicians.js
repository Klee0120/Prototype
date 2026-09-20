const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES, datesForWeek } = require("../utils/week");

const router = express.Router();

function canView(req, techId) {
  return req.user.role === "admin" || req.user.id === techId;
}

function isLocked(status) {
  return status === "submitted" || status === "approved";
}

router.get("/:id/weeks/:weekMonday", requireAuth, (req, res) => {
  const { id, weekMonday } = req.params;
  const tech = db.findTechnician(id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });
  if (!canView(req, tech.id)) return res.status(403).json({ error: "Not authorized" });

  const week = db.getWeek(tech.id, weekMonday);
  const ukgHours = db.getUkgHours(tech.id, weekMonday);

  res.json({
    technician: { id: tech.id, name: tech.name },
    weekMonday,
    dates: datesForWeek(weekMonday),
    days: DAY_NAMES,
    ukgHours,
    allocatedHours: round2(week.allocations.reduce((sum, a) => sum + Number(a.hours || 0), 0)),
    status: week.status,
    locked: isLocked(week.status),
    allocations: week.allocations,
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

  for (const a of allocations) {
    if (!DAY_NAMES.includes(a.day)) return res.status(400).json({ error: `Invalid day: ${a.day}` });
    const wom = db.findWom(a.womCode);
    if (!wom) return res.status(400).json({ error: `Unknown WOM: ${a.womCode}` });
    if (wom.status !== "open") return res.status(400).json({ error: `WOM ${a.womCode} is not open` });
    const hours = Number(a.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ error: `Invalid hours for ${a.womCode} on ${a.day}` });
    }
  }

  const normalized = allocations.map((a) => ({ day: a.day, womCode: a.womCode, hours: round2(Number(a.hours)) }));
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

  const ukgHours = db.getUkgHours(id, weekMonday);
  const allocatedHours = round2(week.allocations.reduce((sum, a) => sum + Number(a.hours || 0), 0));

  if (Math.abs(allocatedHours - ukgHours) > 0.01) {
    return res.status(400).json({
      error: `Allocated hours (${allocatedHours}) must equal UKG hours (${ukgHours}) before submitting`,
      allocatedHours,
      ukgHours,
    });
  }

  for (const a of week.allocations) {
    const wom = db.findWom(a.womCode);
    if (!wom || wom.status !== "open") {
      return res.status(400).json({ error: `WOM ${a.womCode} is no longer open; update allocation before submitting` });
    }
  }

  db.submitWeek(id, weekMonday);
  db.addAudit(req.user.id, "WEEK_SUBMITTED", `${req.user.name} submitted week ${weekMonday} (${allocatedHours}h)`);

  res.json({ ok: true, status: "submitted" });
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
