const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin, requireFinancialsAccess } = require("../middleware/auth");
const smartsheet = require("../utils/smartsheet");

const router = express.Router();

// A real invoice number on file (or the full billing checklist completed)
// is the only thing this app treats as evidence of invoicing -- never
// Status/Work Completed/Billing free text (see db.sourceImpliesInvoiced,
// the same predicate used here, and its comment for the real bug that
// caused -- a WOM still mid-billing got marked Invoiced purely because its
// Status cell said something unrelated). syncWomsFromSheetRows (db.js)
// already auto-promotes a pending/requested/open WOM straight to "invoiced"
// the moment that evidence appears. This banner only remains for what that
// auto-promotion deliberately doesn't touch: a cancelled WOM the sheet now
// shows invoice evidence for -- a real contradiction (cancelled means never
// billed), so cancelled is deliberately *not* treated as "already done"
// here the way invoiced/closed are; sync still never auto-changes a
// cancelled WOM's status itself, but this still flags the disagreement for
// an admin to look at.
const APP_DONE_STATUSES = ["invoiced", "closed"];
function computeWomStatusConflict(w) {
  const appAlreadyDone = APP_DONE_STATUSES.includes(w.status);
  return Boolean(db.sourceImpliesInvoiced(w) && !appAlreadyDone);
}

// "Reclass to" on the real tracker is loose free text, not a clean enum --
// confirmed against the actual sheet (16 of 228 rows populated): 10 say
// "GMP" (Krista's shorthand for "sent to the location's default E&F
// coding, not kept on this WOM"), 3 are bare WOM #s, 1 says "WOM", and 2
// are one-off notes ("Add WOM Reclass - Done April", "NEW WOM"). Classified
// for display, never forced into a stricter shape than the data supports.
function summarizeReclassTarget(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === "-") return null;
  if (/^gmp$/i.test(trimmed)) {
    return { type: "ef_default", label: "Sent to default E&F coding (not kept on this WOM)" };
  }
  const normalized = trimmed.replace(/\.0$/, "");
  if (/^\d{6,}$/.test(normalized)) {
    const target = db.findWom(normalized);
    return {
      type: "wom",
      womCode: normalized,
      label: target ? `Reclassed to WOM #${normalized}` : `Reclassed to WOM #${normalized} (not found in this app)`,
    };
  }
  return { type: "note", label: trimmed };
}

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
    // The remaining four cost categories the tracker itemizes alongside
    // labor and contracted services -- all six estimate-side figures sum to
    // estimatedPrice (same for applied/appliedPrice).
    estimatedMaterials: w.estimated_materials,
    appliedMaterials: w.applied_materials,
    estimatedOtherDirect: w.estimated_other_direct,
    appliedOtherDirect: w.applied_other_direct,
    estimatedTax: w.estimated_tax,
    appliedTax: w.applied_tax,
    estimatedContingency: w.estimated_contingency,
    appliedContingency: w.applied_contingency,
    // The actual dollar amount on the real Toyota-approved PO ("TOY Value"
    // in the tracker) -- separate from estimatedPrice (what the PSE asked
    // for) and appliedPrice (what's actually been posted), so Cost Analysis
    // can compare applied cost against what Toyota actually approved.
    toyotaPoValue: w.toyota_po_value,
    // The Toyota PO document itself (number/contact/open-closed status),
    // as opposed to toyotaPoValue above which is just the dollar amount --
    // see the woms.toyota_po_number migration comment in db.js. changeOrder
    // mirrors the same condition that drives this WOM's lifecycle task's
    // change-order flag (db.computeWomChangeOrder) -- when true, the
    // profile shows the Applied total in red instead of a leftover balance,
    // since Toyota's approved amount needs a new value.
    toyotaPoNumber: w.toyota_po_number,
    toyotaRep: w.toyota_rep,
    toyotaPoStatus: w.toyota_po_status,
    changeOrder: db.computeWomChangeOrder(w),
    // The linked C&W PO # from the Budget PO Tracker (pos.wom_number), for
    // the WOM grid view -- null if this WOM has no PO on file yet.
    poNumber: w.poNumber || null,
    vendorId: w.vendor_id,
    vendorName: w.vendor_id ? (db.findVendor(w.vendor_id) || {}).name || null : null,
    // The WOM lifecycle checklist -- every step, in order, with its
    // completion state. Empty until the WOM has actually entered the
    // checklist (see db.checkWomLifecycleAutoSteps, called on every sync).
    lifecycleSteps: db.getWomLifecycleSteps(w.code),
    // Verbatim Status/Work Completed/Billing/Requested-By values straight
    // from the Smartsheet tracker -- see the woms.source_status_raw
    // migration comment in db.js for why these are separate from `status`.
    // null until a sync with those columns has touched this WOM.
    sourceStatusRaw: w.source_status_raw,
    sourceWorkCompletedRaw: w.source_work_completed_raw,
    sourceWorkCompleted: w.source_work_completed,
    sourceBillingRaw: w.source_billing_raw,
    sourceRequestedBy: w.source_requested_by,
    // A verbatim reference # (e.g. a RITM#) Krista enters by hand once a
    // batch is billed -- display-only, never evidence of invoicing by
    // itself (the "Batch Posted Confirmed" billing-checklist item below is).
    billingRefNumber: w.source_billing_ref_number,
    // Verbatim dates from the tracker -- when work actually wrapped and
    // when the batch posted, shown alongside Billing progress.
    workCompletedDate: w.source_work_completed_date,
    batchDate: w.source_batch_date,
    // The tracker's reclass note -- see db.js's migration comment for why
    // only these 3 columns are pulled (the rest are essentially unused on
    // the real sheet). reclassAmountRequested routinely lines up with this
    // WOM's own "applied over Toyota PO" overage, so it's effectively the
    // remediation record for that. reclassTarget classifies the free-text
    // "Reclass to" cell for display -- see summarizeReclassTarget below.
    reclassAmountRequested: w.source_reclass_amount_requested,
    reclassSubmitted: w.source_reclass_submitted,
    reclassToRaw: w.source_reclass_to_raw,
    reclassTarget: summarizeReclassTarget(w.source_reclass_to_raw),
    // Work completion and billing are two different facts the tracker
    // reports separately -- never collapsed into one combined status. Work
    // Completed says the job itself is done; the billing checklist (plus a
    // real invoice #) says where it stands on actually getting invoiced.
    // null until a sync with that column has touched this WOM.
    workCompleted: w.source_work_completed,
    billingChecklist: db.WOM_BILLING_CHECKLIST_FIELDS.map((f) => ({
      key: f.jsField,
      label: f.label,
      done: w[f.dbColumn] === 1,
      raw: w[`${f.dbColumn}_raw`],
    })),
    billingChecklistComplete: db.isWomBillingChecklistComplete(w),
    // True only when the sheet shows real invoice evidence (a real invoice
    // #, or the full billing checklist complete) while the app's own status
    // still shows it open or earlier -- see computeWomStatusConflict above.
    statusConflict: computeWomStatusConflict(w),
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listWoms().map(presentWom));
});

// The WOM lifecycle checklist: the Financials-wide list of WOMs still
// mid-checklist, split by role the same way the task board's Unassigned
// queue is, plus the two manual steps a person actually clicks through.
// Declared here, before every /:code/... route below, so a later one (e.g.
// GET /:code/tasks) can never shadow this literal path by matching
// "lifecycle" as :code first -- Express matches routes in declaration
// order, and this bit the app for real: adding GET /:code/tasks after this
// route used to live further down silently 404'd this route with "WOM not
// found" (code="lifecycle"), which breaks Task Manager's filters panel
// (loadStaff in tasks.js fetches this unguarded) on every single page load.
router.get("/lifecycle/tasks", requireAuth, requireAdmin, (req, res) => {
  res.json({
    reviewerAdminId: db.getPseReviewerId(),
    steps: db.WOM_LIFECYCLE_STEPS,
    tasks: db.listWomLifecycleTasks(req.user).map(presentWom),
  });
});

// "WOM Lookup" -- everything about one WOM in one place for a technician
// or RFM/admin to check: its own status/budget/pricing (already in
// presentWom), plus who's logged time against it and how much, all-time
// across every week it's ever appeared on, not just the current month.
router.get("/:code/lookup", requireAuth, (req, res) => {
  const wom = db.findWom(req.params.code);
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  const presented = presentWom(wom);
  const hasInvoiceDocument = db.hasWomInvoiceDocument(wom.code);
  const missingRequirements = [];
  if (!presented.invoiceNumber) missingRequirements.push("Invoice #");
  if (!presented.batchNumber) missingRequirements.push("Batch #");
  if (!hasInvoiceDocument) missingRequirements.push("Invoice document");

  res.json({
    ...presented,
    totalHours: db.countWomAllocatedHours(wom.code),
    hoursByTechnician: db.womHoursByTechnician(wom.code),
    hasInvoiceDocument,
    missingRequirements,
  });
});

// Every recorded field change for a WOM (status, pse_stage), oldest first --
// the raw material for later lifecycle/bottleneck analytics, and useful on
// its own right now for seeing how a WOM actually got where it is.
router.get("/:code/history", requireAuth, requireAdmin, (req, res) => {
  if (!db.findWom(req.params.code)) return res.status(404).json({ error: "WOM not found" });
  const rows = db.listWomStatusHistory(req.params.code).map((r) => {
    const changer = r.changed_by ? db.findTechnician(r.changed_by) : null;
    return {
      field: r.field,
      previousValue: r.previous_value,
      newValue: r.new_value,
      changedAt: r.changed_at,
      detectedAt: r.detected_at,
      changedByName: changer ? changer.name : null,
      source: r.source,
    };
  });
  res.json(rows);
});

// Which past Smartsheet syncs actually touched this WOM, and what they
// changed each time -- pulled from every sync run's own changed_woms_json
// rather than a separate log, so "why does this keep showing as changed on
// every sync" can be answered by looking at this WOM's own history instead
// of only ever seeing the latest run's summary.
router.get("/:code/sync-history", requireAuth, requireAdmin, (req, res) => {
  if (!db.findWom(req.params.code)) return res.status(404).json({ error: "WOM not found" });
  res.json(db.getWomSyncHistory(req.params.code));
});

// GL postings actually matched to a PO linked to this WOM (by wom_number) --
// distinct from the WOM's own project-reported appliedPrice, which comes
// from the Smartsheet tracker and can lag or disagree with what's actually
// hit the general ledger.
router.get("/:code/gl-links", requireAuth, requireAdmin, (req, res) => {
  if (!db.findWom(req.params.code)) return res.status(404).json({ error: "WOM not found" });
  res.json(db.getPoGlLinksByWom(req.params.code));
});

// Every task tied to this WOM regardless of category/status/assignee -- the
// WOM Profile's Tasks tab. The main Task Manager's own GET /api/tasks
// defaults to "my work" scoping, which would silently hide an unassigned
// task created from this tab; this route never scopes to a viewer/view, same
// reasoning as vendors.js's own :id/tasks route (and the exact same rows --
// relatedWomCode is just another filter on the one tasks table).
router.get("/:code/tasks", requireAuth, requireAdmin, (req, res) => {
  if (!db.findWom(req.params.code)) return res.status(404).json({ error: "WOM not found" });
  const tasks = db.listTasks({ relatedWomCode: req.params.code }).map((t) => {
    const assignee = t.assigned_to ? db.findTechnician(t.assigned_to) : null;
    const vendor = t.related_vendor_id ? db.findVendor(t.related_vendor_id) : null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueAt: t.due_at,
      createdAt: t.created_at,
      relatedVendorId: t.related_vendor_id,
      relatedVendorName: vendor ? vendor.name : null,
      assignedToName: assignee ? assignee.name : t.assigned_role ? `Unclaimed — ${t.assigned_role}` : "Unassigned",
    };
  });
  res.json(tasks);
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

// The Toyota PO itself -- number, contact, and open/closed status. Number
// and rep also arrive via Smartsheet sync (overwritten on the next sync
// that finds those columns); status is manual-only, never synced.
router.patch("/:code/toyota-po", requireAuth, requireAdmin, (req, res) => {
  const { toyotaPoNumber, toyotaRep, toyotaPoStatus } = req.body || {};
  if (toyotaPoStatus !== undefined && !db.TOYOTA_PO_STATUSES.includes(toyotaPoStatus)) {
    return res.status(400).json({ error: `toyotaPoStatus must be one of: ${db.TOYOTA_PO_STATUSES.join(", ")}` });
  }
  const wom = db.setWomToyotaPo(req.params.code, { toyotaPoNumber, toyotaRep, toyotaPoStatus });
  if (!wom) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_UPDATED", `${req.user.name} updated Toyota PO info for ${wom.code}`);
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

// Records an admin's review of a WOM whose contracted-services cost came in
// above its own quote (Financials -> Repeated Costs Above Quote) -- never
// touches the quote/applied figures themselves, just the review note. A
// reason is required once the review is actually marked reviewed; "needs
// review" can clear a prior reason by leaving it out.
router.patch("/:code/cost-review", requireAuth, requireAdmin, (req, res) => {
  const { reviewStatus, reviewReason, note } = req.body || {};
  if (!db.WOM_COST_REVIEW_STATUSES.includes(reviewStatus)) {
    return res.status(400).json({ error: `reviewStatus must be one of: ${db.WOM_COST_REVIEW_STATUSES.join(", ")}` });
  }
  if (reviewReason != null && !db.WOM_COST_REVIEW_REASONS.includes(reviewReason)) {
    return res.status(400).json({ error: `reviewReason must be one of: ${db.WOM_COST_REVIEW_REASONS.join(", ")}` });
  }
  if (reviewStatus === "reviewed" && !reviewReason) {
    return res.status(400).json({ error: "reviewReason is required to mark a review complete" });
  }
  const result = db.setWomCostReview(req.params.code, { reviewStatus, reviewReason: reviewReason || null, note: note || "" }, req.user.id);
  if (!result) return res.status(404).json({ error: "WOM not found" });

  db.addAudit(req.user.id, "WOM_COST_REVIEW_UPDATED", `${req.user.name} set the cost review for WOM ${req.params.code} to ${reviewStatus}`);
  res.json(result);
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
router.get("/cost-summary", requireAuth, requireAdmin, requireFinancialsAccess, (req, res) => {
  res.json(db.getWomCostSummary());
});

// WOMs whose work is done but aren't fully invoiced yet in this app's own
// bookkeeping -- Financials > Invoicing's queue. Invoice #/batch # arrive on
// their own via sync the moment Smartsheet shows them (see
// applyWomSourceEvidence in db.js); the one thing sync can never do is
// attach the actual invoice file, so that's the one requirement this route
// calls out explicitly per WOM rather than leaving it implicit.
router.get("/invoicing-queue", requireAuth, requireAdmin, requireFinancialsAccess, (req, res) => {
  const woms = db.listWomsNeedingInvoicing();
  res.json(
    woms.map((w) => {
      const presented = presentWom(w);
      const hasInvoiceDocument = db.hasWomInvoiceDocument(w.code);
      const missingRequirements = [];
      if (!presented.invoiceNumber) missingRequirements.push("Invoice #");
      if (!presented.batchNumber) missingRequirements.push("Batch #");
      if (!hasInvoiceDocument) missingRequirements.push("Invoice document");
      return { ...presented, hasInvoiceDocument, missingRequirements };
    })
  );
});

// RFM's two options once a WOM lifecycle task is flagged for a change
// order or a plain missing Toyota PO: proceed with Toyota's own paperwork,
// or (change orders only) hand it to finance to see if labor can be
// trimmed to avoid it. Both require the task to actually be in that state
// right now -- these aren't general-purpose task actions, so they live
// here rather than under /api/tasks.
router.post("/:code/change-order/request-po", requireAuth, requireAdmin, (req, res) => {
  const wom = db.findWom(req.params.code);
  if (!wom) return res.status(404).json({ error: "WOM not found" });
  const task = db.findTaskBySourceKey(db.lifecycleTaskSourceKey(req.params.code));
  if (!task || !(task.is_change_order || task.is_exception)) {
    return res.status(400).json({ error: "This WOM isn't currently flagged for a Toyota PO or change order." });
  }
  const { toyotaEmail, sentAt } = req.body || {};
  if (!toyotaEmail || !sentAt) return res.status(400).json({ error: "toyotaEmail and sentAt are required" });
  db.requestWomChangeOrderPo(req.params.code, { toyotaEmail, sentAt, userId: req.user.id, userName: req.user.name });
  db.addAudit(req.user.id, "WOM_CHANGE_ORDER_PO_REQUESTED", `${req.user.name} requested Toyota PO approval for ${req.params.code}`);
  res.json(presentWom(db.findWom(req.params.code)));
});

router.post("/:code/change-order/refer-to-admin", requireAuth, requireAdmin, (req, res) => {
  const wom = db.findWom(req.params.code);
  if (!wom) return res.status(404).json({ error: "WOM not found" });
  const task = db.findTaskBySourceKey(db.lifecycleTaskSourceKey(req.params.code));
  if (!task || !task.is_change_order) {
    return res.status(400).json({ error: "This WOM isn't currently flagged for a change order." });
  }
  const note = ((req.body || {}).note || "").trim();
  if (!note) return res.status(400).json({ error: "note is required" });
  db.referWomChangeOrderToAdmin(req.params.code, { note, userId: req.user.id, userName: req.user.name });
  db.addAudit(req.user.id, "WOM_CHANGE_ORDER_REFERRED", `${req.user.name} referred the ${req.params.code} change order to admin`);
  res.json(presentWom(db.findWom(req.params.code)));
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
