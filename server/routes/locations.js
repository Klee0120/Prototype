const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// The E&F subsidiary/service code is a single standard value JDE uses for
// general (E&F) time across every location -- unlike the E&F/WOM Contract
// Job Numbers and WOM subsidiary codes, which vary per location/project and
// are stored on the location/WOM records themselves.
const EF_SUBSIDIARY_CODE = "20920000";

function presentLocation(l) {
  return {
    code: l.code,
    name: l.name,
    efJobNumber: l.ef_job_number,
    womJobNumber: l.wom_job_number,
    region: l.region,
    efSubsidiaryCode: EF_SUBSIDIARY_CODE,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listLocations().map(presentLocation));
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  const { code, name, efJobNumber, region, womJobNumber } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "code and name are required" });
  if (db.findLocation(code)) return res.status(409).json({ error: "Location code already exists" });

  db.createLocation(code, name, efJobNumber || null, region || null, womJobNumber || null);
  db.addAudit(req.user.id, "LOCATION_CREATED", `${req.user.name} created location ${code}: ${name}`);
  res.status(201).json({ ok: true });
});

router.patch("/:code", requireAuth, requireAdmin, (req, res) => {
  const { name, efJobNumber, region, womJobNumber } = req.body || {};
  const existing = db.findLocation(req.params.code);
  if (!existing) return res.status(404).json({ error: "Location not found" });
  if (!name) return res.status(400).json({ error: "name is required" });

  const location = db.setLocationDetails(req.params.code, { name, efJobNumber, region, womJobNumber });
  db.addAudit(req.user.id, "LOCATION_UPDATED", `${req.user.name} updated location ${location.code}`);
  res.json(presentLocation(location));
});

module.exports = router;
