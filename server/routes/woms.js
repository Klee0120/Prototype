const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const smartsheet = require("../utils/smartsheet");

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
    dateRequested: w.date_requested,
    // Every column from the tracker's own row, verbatim -- every estimate/
    // applied line item, PO numbers, invoice/batch tracking, RFM/PSE
    // approval flags, whatever else the sheet has -- not just the handful
    // of fields this app's own logic reads directly. null for a WOM a sync
    // has never touched.
    smartsheetData,
    // The Smartsheet grid's own row number (e.g. "Line 42") and a direct
    // link to that row in the Smartsheet web app -- for identifying a
    // request whose description didn't come through cleanly, without
    // having to hunt for it by eye in the sheet. null for a WOM that
    // isn't synced from Smartsheet, or before this field existed (fills
    // in on the next sync that touches it).
    smartsheetLineNumber: w.smartsheet_row_number,
    smartsheetLink: smartsheet.rowLink(w.smartsheet_row_id),
    pseToyotaEmail: w.pse_toyota_email,
    pseToyotaSentAt: w.pse_toyota_sent_at,
    batchNumber: w.batch_number,
    invoiceNumber: w.invoice_number,
    // The estimate/applied breakdown by category, and the vendor the
    // tracker's own "Vendor(s) Name/#/Phone" column matched to (see
    // db.matchVendorIdByName) -- null for either until a sync with those
    // columns has touched this WOM, or if this app has no vendor record by
    // that name yet.
    estimatedLabor: w.estimated_labor,
    estimatedContracted: w.estimated_contracted,
    appliedLabor: w.applied_labor,
    appliedContracted: w.applied_contracted,
    vendorId: w.vendor_id,
    vendorName: w.vendor_id ? (db.findVendor(w.vendor_id) || {}).name || null : null,
    // The WOM lifecycle checklist -- every step, in order, with its
    // completion state. Empty until the WOM has actually entered the
    // checklist (see db.checkWomLifecycleAutoSteps, called on every sync).
    lifecycleSteps: db.getWomLifecycleSteps(w.code),
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listWoms().map(presentWom));
});

// "WOM Lookup" -- everything about one WOM in one place for a technician
// or RFM/admin to check: its own status/budget/pricing (already in
// presentWom), plus who's logged time against it and how much, all-time
// across every week it's ever appeared on, not just the current month.
router.get("/:code/lookup", requireAuth, (req, res) => {
  const wom = db.findWom(req.params.code);
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  res.json({
    ...presentWom(wom),
    totalHours: db.countWomAllocatedHours(wom.code),
    hoursByTechnician: db.womHoursByTechnician(wom.code),
  });
});

// Every recorded field change for a WOM (status, pse_stage), oldest first --
// the raw material for later lifecycle/bottleneck analytics, and useful on
// its own right now for seeing how a WOM actually got where it is.
router.get("/:code/history", requireAuth, requireAdmin, (req, res) => {
  if (!db.findWom(req.params.code)) return res.status(404).json({ error: "WOM not found" });
  res.json(db.listWomStatusHistory(req.params.code));
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

  const wom = db.setWomStatus(req.params.code, status, { changedBy: req.user.id, source: "manual" });
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
  // A hand-entered Maximo/PO # completes the checklist's "Create WOM & PO"
  // step the same as one arriving via sync.
  db.checkWomLifecycleAutoSteps(wom.code);
  db.addAudit(req.user.id, "WOM_UPDATED", `${req.user.name} updated WOM ${wom.code}`);
  res.json(presentWom(db.findWom(wom.code)));
});

// Hand-entering pricing for a WOM without a Smartsheet match yet -- a later
// sync overwrites both fields once that WOM code is found there.
router.patch("/:code/pricing", requireAuth, requireAdmin, (req, res) => {
  const { estimatedPrice, appliedPrice } = req.body || {};
  const wom = db.setWomPricing(req.params.code, { estimatedPrice, appliedPrice });
  if (!wom) return res.status(404).json({ error: "WOM not found" });
  // A hand-entered applied cost completes the checklist's "Post applied
  // cost" step the same as one arriving via sync.
  db.checkWomLifecycleAutoSteps(wom.code);

  db.addAudit(req.user.id, "WOM_PRICING_UPDATED", `${req.user.name} updated pricing for WOM ${wom.code}`);
  res.json(presentWom(db.findWom(wom.code)));
});

// Lets a technician mark a job done from their own allocation screen
// without giving them the ability to reopen/close WOMs at will the way
// the admin-only PATCH above does.
router.post("/:code/complete", requireAuth, (req, res) => {
  const wom = db.setWomStatus(req.params.code, "closed", { changedBy: req.user.id, source: "tech_complete" });
  if (!wom) return res.status(404).json({ error: "WOM not found" });
  // Re-checks every lifecycle step, not just "work complete" -- a no-op for
  // a WOM outside the checklist entirely.
  db.checkWomLifecycleAutoSteps(wom.code);

  db.addAudit(req.user.id, "WOM_MARKED_COMPLETE", `${req.user.name} marked ${wom.code} complete`);
  res.json(presentWom(db.findWom(wom.code)));
});

// The WOM lifecycle checklist: the Financials-wide list of WOMs still
// mid-checklist, split by role the same way the task board's Unassigned
// queue is, plus the two manual steps a person actually clicks through.
router.get("/lifecycle/tasks", requireAuth, requireAdmin, (req, res) => {
  res.json({
    reviewerAdminId: db.getPseReviewerId(),
    steps: db.WOM_LIFECYCLE_STEPS,
    tasks: db.listWomLifecycleTasks(req.user).map(presentWom),
  });
});

router.post("/:code/lifecycle/:stepKey", requireAuth, requireAdmin, (req, res) => {
  const { toyotaEmail, sentAt, batchNumber, invoiceNumber } = req.body || {};
  const result = db.completeWomLifecycleStep(req.params.code, req.params.stepKey, req.user, { toyotaEmail, sentAt, batchNumber, invoiceNumber });
  if (result.error === "not_found") return res.status(404).json({ error: "WOM not found" });
  if (result.error === "unknown_step") return res.status(400).json({ error: `Unknown step: ${req.params.stepKey}` });
  if (result.error === "not_manual") return res.status(400).json({ error: "That step completes on its own once its data syncs in -- it's not a button to click" });
  if (result.error === "already_done") return res.status(409).json({ error: `${req.params.stepKey} is already done` });
  if (result.error === "wrong_role") return res.status(403).json({ error: "This step isn't yours to take" });
  if (result.error === "email_required") return res.status(400).json({ error: "toyotaEmail is required" });
  if (result.error === "batch_and_invoice_required") return res.status(400).json({ error: "batchNumber and invoiceNumber are both required" });

  const step = db.WOM_LIFECYCLE_STEPS.find((s) => s.key === req.params.stepKey);
  db.addAudit(req.user.id, "WOM_LIFECYCLE_STEP_COMPLETED", `${req.user.name} completed "${step.label}" for ${req.params.code}`);
  res.json(presentWom(result.wom));
});

// Financials-wide estimated-vs-applied summary -- every non-cancelled WOM,
// not just the ones currently mid-checklist.
router.get("/cost-summary", requireAuth, requireAdmin, (req, res) => {
  res.json(db.getWomCostSummary());
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
