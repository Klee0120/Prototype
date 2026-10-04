const express = require("express");
const db = require("../data/db");
const mailer = require("../utils/mailer");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const EXPIRED_DOC_LABELS = { coi: "Certificate of Insurance (COI)", w9: "W-9", ach: "ACH / banking details" };

function validateVendorBody(body) {
  const { name, cwStatus, toyotaStatus, formsStatus, successfulInvoiceRecords, onboardingStage } = body || {};
  if (!name || !String(name).trim()) return "name is required";
  if (cwStatus && !db.CW_STATUSES.includes(cwStatus)) return `cwStatus must be one of: ${db.CW_STATUSES.join(", ")}`;
  if (toyotaStatus && !db.TOYOTA_STATUSES.includes(toyotaStatus)) {
    return `toyotaStatus must be one of: ${db.TOYOTA_STATUSES.join(", ")}`;
  }
  if (formsStatus && !db.FORMS_STATUSES.includes(formsStatus)) {
    return `formsStatus must be one of: ${db.FORMS_STATUSES.join(", ")}`;
  }
  if (onboardingStage && !db.ONBOARDING_STAGES.includes(onboardingStage)) {
    return `onboardingStage must be one of: ${db.ONBOARDING_STAGES.join(", ")}`;
  }
  if (successfulInvoiceRecords != null && successfulInvoiceRecords !== "") {
    const n = Number(successfulInvoiceRecords);
    if (!Number.isFinite(n) || n < 0) return "successfulInvoiceRecords must be a non-negative number";
  }
  return null;
}

router.get("/", (req, res) => {
  res.json(db.listVendors());
});

// Bulk read behind the Onboarding board: the latest case of each canonical
// type (COI, W-9, Payment, Request) for every vendor that has any case
// activity, in one round trip instead of one call per vendor shown.
router.get("/onboarding/case-summary", (req, res) => {
  res.json({ caseTypes: db.ONBOARDING_CASE_TYPES, summaries: db.listOnboardingCaseSummaries() });
});

// Vendors showing up on a Budget PO (name + JDE Vendor #) with no vendor
// profile on file at all -- the Vendor Directory's own "needs attention"
// banner, same pattern as the outdated-forms one.
router.get("/unregistered-po-vendors", (req, res) => {
  res.json(db.listUnregisteredPoVendors());
});

router.post("/", (req, res) => {
  const error = validateVendorBody(req.body);
  if (error) return res.status(400).json({ error });

  const vendor = db.createVendor({ ...req.body, name: String(req.body.name).trim() });
  db.addAudit(req.user.id, "VENDOR_CREATED", `${req.user.name} added vendor ${vendor.name}`);
  res.status(201).json(vendor);
});

router.patch("/:id", (req, res) => {
  const existing = db.findVendor(req.params.id);
  if (!existing) return res.status(404).json({ error: "Vendor not found" });

  const error = validateVendorBody(req.body);
  if (error) return res.status(400).json({ error });

  const vendor = db.updateVendor(req.params.id, { ...req.body, name: String(req.body.name).trim() });
  if (vendor.onboardingStage !== existing.onboardingStage) {
    db.addAudit(
      req.user.id,
      "VENDOR_ONBOARDING_STAGE_CHANGED",
      `${req.user.name} moved ${vendor.name} to ${vendor.onboardingStage}${vendor.onboardingStage === "denied" && vendor.deniedReason ? ` (${vendor.deniedReason})` : ""}`
    );
  }
  db.addAudit(req.user.id, "VENDOR_UPDATED", `${req.user.name} updated vendor ${vendor.name}`);
  res.json(vendor);
});

router.delete("/:id", (req, res) => {
  const result = db.deleteVendor(req.params.id);
  if (result.error === "not_found") return res.status(404).json({ error: "Vendor not found" });
  if (result.error === "in_use") {
    const parts = [];
    if (result.womCount > 0) parts.push(`${result.womCount} WOM${result.womCount === 1 ? "" : "s"}`);
    if (result.poCount > 0) parts.push(`${result.poCount} Budget PO${result.poCount === 1 ? "" : "s"}`);
    return res.status(409).json({
      womCount: result.womCount,
      poCount: result.poCount,
      error: `Still in use by ${parts.join(", ")} -- reassign or unlink those first`,
    });
  }

  db.addAudit(req.user.id, "VENDOR_DELETED", `${req.user.name} removed vendor ${result.vendor.name}`);
  res.json({ ok: true });
});

// Krista's own "go to this vendor first" flag -- separate from C&W/Toyota
// approval status, which is about whether a vendor's allowed to work at
// all, not whether they're preferred.
router.patch("/:id/preferred", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const preferred = Boolean((req.body || {}).preferred);
  const updated = db.setVendorPreferred(vendor.id, preferred);
  db.addAudit(
    req.user.id,
    "VENDOR_PREFERRED_CHANGED",
    `${req.user.name} ${preferred ? "marked" : "unmarked"} ${vendor.name} as a preferred vendor`
  );
  res.json(updated);
});

router.get("/denial-reasons", (req, res) => {
  res.json(db.VENDOR_DENIAL_REASONS);
});

// Explicit, admin-triggered -- not an automatic background check, since
// there's no scheduler for compliance the way there is for Smartsheet sync.
// Sending it is a real action worth a confirm click and its own audit line,
// same as "Mark sent" elsewhere in onboarding.
router.post("/:id/notify-expired-docs", async (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const expiredCategories = db.listExpiredVendorComplianceCategories(vendor.id);
  if (expiredCategories.length === 0) {
    return res.status(400).json({ error: "No expired COI/W-9/ACH document on file for this vendor" });
  }
  if (!vendor.email) {
    return res.status(400).json({ error: "This vendor has no email on file" });
  }
  const labels = expiredCategories.map((c) => EXPIRED_DOC_LABELS[c] || c);
  const result = await mailer.sendMail({
    to: vendor.email,
    subject: "Document renewal needed on file",
    text: `Hi ${vendor.name},\n\nThe following document${labels.length === 1 ? " has" : "s have"} expired on file with us and need${
      labels.length === 1 ? "s" : ""
    } to be renewed before new work can be scheduled:\n\n- ${labels.join("\n- ")}\n\nPlease send an updated copy at your earliest convenience.\n`,
  });
  db.addAudit(
    req.user.id,
    "VENDOR_NOTIFIED_EXPIRED_DOCS",
    `${req.user.name} notified ${vendor.name} (${vendor.email}) about expired ${labels.join(", ")}${result.sent ? "" : " (SMTP not configured -- not actually delivered)"}`
  );
  res.json({ ok: true, sent: result.sent, categories: expiredCategories });
});

// An explicit, admin-driven denial -- independent of any one onboarding
// case (COI/W-9/Payment), since "unacceptable work or service" and "cost"
// aren't document outcomes a case status can capture. Sticks (see
// deriveOnboardingStage) until reinstate below.
router.post("/:id/deny", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const { category, reason } = req.body || {};
  const validKeys = db.VENDOR_DENIAL_REASONS.map((r) => r.key);
  if (!validKeys.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${validKeys.join(", ")}` });
  }
  const updated = db.denyVendor(vendor.id, { category, reason });
  const label = db.VENDOR_DENIAL_REASONS.find((r) => r.key === category).label;
  db.addAudit(
    req.user.id,
    "VENDOR_ONBOARDING_STAGE_CHANGED",
    `${req.user.name} marked ${updated.name} denied (${label})${updated.deniedReason ? `: ${updated.deniedReason}` : ""}`
  );
  res.json(updated);
});

router.post("/:id/reinstate", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const updated = db.reinstateVendor(vendor.id);
  db.addAudit(
    req.user.id,
    "VENDOR_ONBOARDING_STAGE_CHANGED",
    `${req.user.name} reinstated ${updated.name} (now ${updated.onboardingStage})`
  );
  res.json(updated);
});

// A running, dated log of free-form remarks -- distinct from the vendor's
// single overwritable Notes field (see vendor_remarks table comment).
router.get("/:id/remarks", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  res.json(db.listVendorRemarks(vendor.id));
});

router.post("/:id/remarks", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  const body = (req.body && req.body.body ? String(req.body.body) : "").trim();
  if (!body) return res.status(400).json({ error: "body is required" });
  const remarks = db.addVendorRemark(vendor.id, req.user.id, req.user.name, body);
  res.status(201).json(remarks);
});

// Real territories this vendor has been used in, derived from its own PO/WOM
// history -- distinct from the free-text onboarding notes ("Coverage outside
// Midwest", "Midwest sites seen").
router.get("/:id/territories", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  res.json(db.getVendorTerritories(vendor.id));
});

// Onboarding/compliance case log (e.g. a ServiceEdge COI Case, Toyota
// Onboarding Case, Payment Details Case) -- same request-type +
// reference-number pattern as a technician's device IT requests, but with
// a free-text status instead of a simple complete/reopen toggle, since the
// real cases carry varied statuses ("Approved", "Waiting", "Denied - No
// Response - Start over Case") that don't reduce to a boolean.
router.get("/:id/requests", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  res.json(db.listVendorRequests(vendor.id));
});

// Every compliance follow-up task this vendor has ever had (open and
// completed), each with its own comments -- surfaced in the Onboarding &
// Compliance modal so the notes logged while following up live right next
// to the case/document-check status they're about.
router.get("/:id/compliance-tasks", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  res.json(db.listVendorComplianceTasks(vendor.id));
});

// Every task tied to this vendor regardless of category/status/assignee --
// the Vendor Profile's Tasks tab. Unlike the main Task Manager's own
// queries, this is never scoped to "my work"/a view -- it's always the
// vendor's complete task history, same underlying rows Task Manager and
// this vendor's own profile both read from.
router.get("/:id/tasks", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const tasks = db.listTasks({ relatedVendorId: vendor.id }).map((t) => {
    const assignee = t.assigned_to ? db.findTechnician(t.assigned_to) : null;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueAt: t.due_at,
      createdAt: t.created_at,
      assignedToName: assignee ? assignee.name : t.assigned_role ? `Unclaimed — ${t.assigned_role}` : "Unassigned",
    };
  });
  res.json(tasks);
});

// addVendorRequest/updateVendorRequest/deleteVendorRequest each re-derive
// the vendor's onboardingStage from the latest case of each required type
// (see db.js) -- comparing before/after here lets a stage change that
// results from logging a case get the same audit trail a direct stage
// change already gets.
function auditStageChangeIfAny(req, vendorBefore) {
  const after = db.findVendor(vendorBefore.id);
  if (after.onboardingStage !== vendorBefore.onboardingStage) {
    db.addAudit(
      req.user.id,
      "VENDOR_ONBOARDING_STAGE_CHANGED",
      `${req.user.name} moved ${after.name} to ${after.onboardingStage} (case update)`
    );
  }
}

router.post("/:id/requests", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const { requestType, referenceNumber, status, note, asOf } = req.body || {};
  if (!requestType || !String(requestType).trim()) return res.status(400).json({ error: "requestType is required" });

  const requests = db.addVendorRequest(vendor.id, requestType.trim(), referenceNumber, status, note, asOf);
  db.addAudit(
    req.user.id,
    "VENDOR_REQUEST_ADDED",
    `${req.user.name} logged a ${requestType} case${referenceNumber ? ` (#${referenceNumber})` : ""} for ${vendor.name}`
  );
  auditStageChangeIfAny(req, vendor);
  res.status(201).json(requests);
});

router.patch("/:id/requests/:requestId", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const { requestType, referenceNumber, status, note, asOf } = req.body || {};
  if (!requestType || !String(requestType).trim()) return res.status(400).json({ error: "requestType is required" });

  const requests = db.updateVendorRequest(vendor.id, Number(req.params.requestId), {
    requestType: requestType.trim(),
    referenceNumber,
    status,
    note,
    asOf,
    updatedBy: req.user.id,
  });
  db.addAudit(req.user.id, "VENDOR_REQUEST_UPDATED", `${req.user.name} updated a case for ${vendor.name}`);
  auditStageChangeIfAny(req, vendor);
  res.json(requests);
});

router.delete("/:id/requests/:requestId", (req, res) => {
  const vendor = db.findVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const requests = db.deleteVendorRequest(vendor.id, Number(req.params.requestId));
  db.addAudit(req.user.id, "VENDOR_REQUEST_REMOVED", `${req.user.name} removed a case for ${vendor.name}`);
  auditStageChangeIfAny(req, vendor);
  res.json(requests);
});

module.exports = router;
