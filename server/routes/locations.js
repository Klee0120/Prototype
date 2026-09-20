const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  res.json(db.listLocations());
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "code and name are required" });
  if (db.findLocation(code)) return res.status(409).json({ error: "Location code already exists" });

  db.createLocation(code, name);
  db.addAudit(req.user.id, "LOCATION_CREATED", `${req.user.name} created location ${code}: ${name}`);
  res.status(201).json({ ok: true });
});

module.exports = router;
