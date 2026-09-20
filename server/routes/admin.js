const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { DAY_NAMES } = require("../utils/week");

const router = express.Router();
router.use(requireAuth, requireAdmin);

function round2(n) {
  return Math.round(n * 100) / 100;
}

router.get("/technicians", (req, res) => {
  res.json(db.listTechnicians().map((t) => ({ id: t.id, name: t.name, homeLocationCode: t.home_location_code })));
});

router.patch("/technicians/:id/home-location", (req, res) => {
  const tech = db.findTechnician(req.params.id);
  if (!tech || tech.role !== "tech") return res.status(404).json({ error: "Technician not found" });

  const { locationCode } = req.body || {};
  if (locationCode && !db.findLocation(locationCode)) {
    return res.status(400).json({ error: `Unknown location: ${locationCode}` });
  }

  db.setHomeLocation(tech.id, locationCode || null);
  db.addAudit(req.user.id, "HOME_LOCATION_SET", `${req.user.name} set ${tech.name}'s home location to ${locationCode || "(none)"}`);
  res.json({ ok: true });
});

router.get("/weeks/:weekMonday", (req, res) => {
  const { weekMonday } = req.params;
  const rows = db.listTechnicians().map((tech) => {
    const week = db.getWeek(tech.id, weekMonday);
    const ukgByDay = db.getUkgHoursByDay(tech.id, weekMonday);
    const ukgHours = round2(DAY_NAMES.reduce((sum, d) => sum + (ukgByDay[d] || 0), 0));
    const allocatedHours = round2(week.allocations.reduce((sum, a) => sum + Number(a.hours || 0), 0));
    return {
      technician: { id: tech.id, name: tech.name },
      status: week.status,
      ukgHours,
      allocatedHours,
      submittedAt: week.submittedAt,
      reviewedAt: week.reviewedAt,
      reviewedBy: week.reviewedBy,
      note: week.note,
    };
  });
  res.json(rows);
});

router.put("/weeks/:techId/:weekMonday/ukg-hours", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const hours = req.body && req.body.hours;
  if (!hours || typeof hours !== "object") return res.status(400).json({ error: "hours object is required" });

  for (const [day, value] of Object.entries(hours)) {
    if (!DAY_NAMES.includes(day)) return res.status(400).json({ error: `Invalid day: ${day}` });
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `Invalid hours for ${day}` });
  }

  const updated = db.setUkgHours(techId, weekMonday, hours);
  const total = round2(DAY_NAMES.reduce((sum, d) => sum + (updated[d] || 0), 0));
  db.addAudit(req.user.id, "UKG_HOURS_SET", `${req.user.name} set UKG hours for ${tech.name}, week ${weekMonday} (${total}h total)`);

  res.json({ ok: true, ukgHoursByDay: updated });
});

router.post("/weeks/:techId/:weekMonday/approve", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "submitted") {
    return res.status(409).json({ error: `Week must be submitted before it can be approved (currently ${week.status})` });
  }

  db.approveWeek(techId, weekMonday, req.user.id);
  db.addAudit(req.user.id, "WEEK_APPROVED", `${req.user.name} approved week ${weekMonday} for ${tech.name}`);
  res.json({ ok: true, status: "approved" });
});

router.post("/weeks/:techId/:weekMonday/reject", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "submitted") {
    return res.status(409).json({ error: `Week must be submitted before it can be rejected (currently ${week.status})` });
  }

  const note = (req.body && req.body.note) || "";
  db.rejectWeek(techId, weekMonday, req.user.id, note);
  db.addAudit(req.user.id, "WEEK_REJECTED", `${req.user.name} rejected week ${weekMonday} for ${tech.name}${note ? `: ${note}` : ""}`);
  res.json({ ok: true, status: "rejected" });
});

router.post("/weeks/:techId/:weekMonday/unlock", (req, res) => {
  const { techId, weekMonday } = req.params;
  const tech = db.findTechnician(techId);
  if (!tech) return res.status(404).json({ error: "Technician not found" });

  const week = db.getWeek(techId, weekMonday);
  if (week.status !== "approved") {
    return res.status(409).json({ error: `Only an approved week can be unlocked (currently ${week.status})` });
  }

  db.unlockWeek(techId, weekMonday, req.user.id);
  db.addAudit(req.user.id, "WEEK_UNLOCKED", `${req.user.name} unlocked approved week ${weekMonday} for ${tech.name} for correction`);
  res.json({ ok: true, status: "draft" });
});

module.exports = router;
