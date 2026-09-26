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
    // Where this WOM sits in the PSE-to-invoice pipeline (see PSE_STAGES in
    // server/data/db.js) -- null if it was never entered into the pipeline
    // (created by hand rather than synced from Smartsheet).
    pseStage: w.pse_stage,
    pseStageLabel: w.pse_stage ? (db.PSE_STAGES[w.pse_stage] || {}).label || w.pse_stage : null,
    pseHoldReason: w.pse_hold_reason,
    pseHoldNote: w.pse_hold_note,
    pseScheduleBlock: Boolean(w.pse_schedule_block),
    pseFollowupAt: w.pse_followup_at,
    pseStageUpdatedAt: w.pse_stage_updated_at,
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
  const wom = db.setWomStatus(req.params.code, "closed", { changedBy: req.user.id, source: "tech_complete" });
  if (!wom) return res.status(404).json({ error: "WOM not found" });
  // Only actually moves anything if this WOM was in the PSE pipeline and
  // waiting to be worked -- a no-op otherwise (see advancePseOnComplete).
  db.advancePseOnComplete(wom.code);

  db.addAudit(req.user.id, "WOM_MARKED_COMPLETE", `${req.user.name} marked ${wom.code} complete`);
  res.json(presentWom(db.findWom(wom.code)));
});

// PSE pipeline: everything an admin can do to move a WOM through it. See
// PSE_STAGES/PSE_ACTIONS in server/data/db.js for the full state machine.
router.get("/pse/tasks", requireAuth, requireAdmin, (req, res) => {
  res.json({
    reviewerAdminId: db.getPseReviewerId(),
    stages: db.PSE_STAGES,
    tasks: db.listPseTasks(req.user).map(presentWom),
  });
});

router.post("/:code/pse/actions/:action", requireAuth, requireAdmin, (req, res) => {
  const result = db.applyPseAction(req.params.code, req.params.action, req.user);
  if (result.error === "not_found") return res.status(404).json({ error: "WOM not found" });
  if (result.error === "unknown_action") return res.status(400).json({ error: `Unknown action: ${req.params.action}` });
  if (result.error === "wrong_stage") {
    const stageLabel = result.currentStage ? (db.PSE_STAGES[result.currentStage] || {}).label || result.currentStage : "not in the PSE pipeline";
    return res.status(409).json({ error: `That step doesn't apply here -- ${req.params.code} is currently at: ${stageLabel}` });
  }
  if (result.error === "wrong_role") return res.status(403).json({ error: "This step isn't yours to take" });

  db.addAudit(
    req.user.id,
    "PSE_STAGE_ADVANCED",
    `${req.user.name} advanced ${req.params.code} (${req.params.action}) to: ${(db.PSE_STAGES[result.wom.pse_stage] || {}).label || result.wom.pse_stage}`
  );
  res.json(presentWom(result.wom));
});

// The two "holding" states (waiting on the vendor invoice, waiting on
// labor allocations to post) plus an "other" free-text reason -- just an
// annotation, doesn't change pse_stage, so the task stays on the same
// list, visibly flagged as blocked rather than actionable right now.
router.post("/:code/pse/hold", requireAuth, requireAdmin, (req, res) => {
  const { holdReason, holdNote } = req.body || {};
  const result = db.setPseHold(req.params.code, { holdReason: holdReason || null, holdNote });
  if (!result) return res.status(404).json({ error: "WOM not found" });
  if (result.error === "invalid_reason") {
    return res.status(400).json({ error: `holdReason must be one of: ${db.PSE_HOLD_REASONS.join(", ")}` });
  }

  db.addAudit(
    req.user.id,
    "PSE_HOLD_SET",
    holdReason
      ? `${req.user.name} put ${req.params.code} on hold (${holdReason})`
      : `${req.user.name} cleared the hold on ${req.params.code}`
  );
  res.json(presentWom(result.wom));
});

// The "don't schedule until Toyota PO" flag -- while set, generating the
// WOM/PO routes back to the reviewer instead of prompting a technician to
// schedule work against a PO that isn't confirmed yet.
router.post("/:code/pse/schedule-block", requireAuth, requireAdmin, (req, res) => {
  const blocked = Boolean((req.body || {}).blocked);
  const wom = db.setPseScheduleBlock(req.params.code, blocked);
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(
    req.user.id,
    "PSE_SCHEDULE_BLOCK_SET",
    `${req.user.name} ${blocked ? "blocked" : "cleared the block on"} scheduling for ${req.params.code} pending Toyota PO`
  );
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
