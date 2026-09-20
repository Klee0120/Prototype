const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

function round2(n) {
  return Math.round(n * 100) / 100;
}

router.get("/weeks/:weekMonday", (req, res) => {
  const { weekMonday } = req.params;
  const rows = db.listTechnicians().map((tech) => {
    const week = db.getWeek(tech.id, weekMonday);
    const ukgHours = db.getUkgHours(tech.id, weekMonday);
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
