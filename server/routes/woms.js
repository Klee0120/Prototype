const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function presentWom(w) {
  let smartsheetData = null;
  if (w.smartsheet_raw_data) {
    try {
      smartsheetData = JSON.parse(w.smartsheet_raw_data);
    } catch {
      smartsheetData = null;
    }
  }
  return {
    code: w.code,
    description: w.description,
    status: w.status,
    locationCode: w.location_code,
    budgetHours: w.budget_hours,
    subsidiaryCode: w.subsidiary_code,
    maximoNumber: w.maximo_number,
    usedHours: w.usedHours,
    remainingHours: w.remainingHours,
    smartsheetReflectedAt: w.smartsheet_reflected_at,
    estimatedPrice: w.estimated_price,
    appliedPrice: w.applied_price,
    smartsheetSyncedAt: w.smartsheet_synced_at,
    // Every column from the tracker's own row, verbatim -- every estimate/
    // applied line item, PO numbers, invoice/batch tracking, RFM/PSE
    // approval flags, whatever else the sheet has -- not just the handful
    // of fields this app's own logic reads directly. null for a WOM a sync
    // has never touched.
    smartsheetData,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listWoms().map(presentWom));
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  const { code, description, locationCode, budgetHours, subsidiaryCode, maximoNumber } = req.body || {};
  if (!code || !description) return res.status(400).json({ error: "code and description are required" });
  if (db.findWom(code)) return res.status(409).json({ error: "WOM code already exists" });
  if (locationCode && !db.findLocation(locationCode)) {
    return res.status(400).json({ error: `Unknown location: ${locationCode}` });
  }

  db.createWom(code, description, locationCode || null, budgetHours === "" ? null : budgetHours, subsidiaryCode || null, maximoNumber || null);
  db.addAudit(req.user.id, "WOM_CREATED", `${req.user.name} created WOM ${code}: ${description}`);
  res.status(201).json({ ok: true });
});

// For a WOM created by mistake -- a test entry, a typo -- rather than
// leaving it sitting around under some status forever. Blocked by default
// if hours are already allocated against it (force: true removes those
// allocation rows too, so use with care -- see db.deleteWom).
router.delete("/:code", requireAuth, requireAdmin, (req, res) => {
  const force = Boolean((req.body || {}).force);
  const result = db.deleteWom(req.params.code, { force });
  if (result.error === "not_found") return res.status(404).json({ error: "WOM not found" });
  if (result.error === "has_allocations") {
    return res.status(409).json({
      error: `${result.allocatedHours}h already allocated against ${req.params.code} -- deleting it will remove those hours from technician timesheets too`,
      allocatedHours: result.allocatedHours,
    });
  }

  const note = result.allocatedHoursRemoved > 0 ? ` (removed ${result.allocatedHoursRemoved}h of allocated hours along with it)` : "";
  db.addAudit(req.user.id, "WOM_DELETED", `${req.user.name} deleted WOM ${req.params.code}${note}`);
  res.json({ ok: true });
});

router.patch("/:code", requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!db.WOM_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${db.WOM_STATUSES.join(", ")}` });
  }

  const wom = db.setWomStatus(req.params.code, status);
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_STATUS_CHANGED", `${req.user.name} set ${wom.code} to ${status}`);
  res.json(presentWom(wom));
});

router.patch("/:code/details", requireAuth, requireAdmin, (req, res) => {
  const { description, locationCode, budgetHours, subsidiaryCode, maximoNumber } = req.body || {};
  const existing = db.findWom(req.params.code);
  if (!existing) return res.status(404).json({ error: "WOM not found" });
  if (!description) return res.status(400).json({ error: "description is required" });
  if (locationCode && !db.findLocation(locationCode)) {
    return res.status(400).json({ error: `Unknown location: ${locationCode}` });
  }

  const wom = db.setWomDetails(req.params.code, {
    description,
    locationCode: locationCode || null,
    budgetHours: budgetHours === "" ? null : budgetHours,
    subsidiaryCode: subsidiaryCode || null,
    maximoNumber: maximoNumber || null,
  });
  db.addAudit(req.user.id, "WOM_UPDATED", `${req.user.name} updated WOM ${wom.code}`);
  res.json(presentWom(wom));
});

// Hand-entering pricing for a WOM without a Smartsheet match yet -- a later
// sync overwrites both fields once that WOM code is found there.
router.patch("/:code/pricing", requireAuth, requireAdmin, (req, res) => {
  const { estimatedPrice, appliedPrice } = req.body || {};
  const wom = db.setWomPricing(req.params.code, { estimatedPrice, appliedPrice });
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_PRICING_UPDATED", `${req.user.name} updated pricing for WOM ${wom.code}`);
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

// A WOM closed here doesn't close it on the external Smartsheet tracker --
// admin goes and updates that by hand, then marks it done here so it drops
// off the Priorities list instead of nagging forever.
router.post("/:code/smartsheet-reflected", requireAuth, requireAdmin, (req, res) => {
  const wom = db.markWomSmartsheetReflected(req.params.code);
  if (!wom) {
    const existing = db.findWom(req.params.code);
    if (!existing) return res.status(404).json({ error: "WOM not found" });
    return res.status(409).json({ error: `Only a closed WOM needs this (currently ${existing.status})` });
  }

  db.addAudit(req.user.id, "WOM_SMARTSHEET_REFLECTED", `${req.user.name} marked ${wom.code} as reflected closed in Smartsheet`);
  res.json(presentWom(wom));
});

module.exports = router;
