const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function presentWom(w) {
  return {
    code: w.code,
    description: w.description,
    status: w.status,
    locationCode: w.location_code,
    budgetHours: w.budget_hours,
    usedHours: w.usedHours,
    remainingHours: w.remainingHours,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listWoms().map(presentWom));
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  const { code, description, locationCode, budgetHours } = req.body || {};
  if (!code || !description) return res.status(400).json({ error: "code and description are required" });
  if (db.findWom(code)) return res.status(409).json({ error: "WOM code already exists" });
  if (locationCode && !db.findLocation(locationCode)) {
    return res.status(400).json({ error: `Unknown location: ${locationCode}` });
  }

  db.createWom(code, description, locationCode || null, budgetHours === "" ? null : budgetHours);
  db.addAudit(req.user.id, "WOM_CREATED", `${req.user.name} created WOM ${code}: ${description}`);
  res.status(201).json({ ok: true });
});

router.patch("/:code", requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!["open", "closed"].includes(status)) return res.status(400).json({ error: "status must be open or closed" });

  const wom = db.setWomStatus(req.params.code, status);
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_STATUS_CHANGED", `${req.user.name} set ${wom.code} to ${status}`);
  res.json(presentWom(wom));
});

// Lets a technician mark a job done from their own allocation screen
// without giving them the ability to reopen/close WOMs at will the way
// the admin-only PATCH above does.
router.post("/:code/complete", requireAuth, (req, res) => {
  const wom = db.setWomStatus(req.params.code, "closed");
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_MARKED_COMPLETE", `${req.user.name} marked ${wom.code} complete`);
  res.json(presentWom(wom));
});

module.exports = router;
