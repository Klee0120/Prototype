const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

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
  const vendor = db.deleteVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  db.addAudit(req.user.id, "VENDOR_DELETED", `${req.user.name} removed vendor ${vendor.name}`);
  res.json({ ok: true });
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

  const { requestType, referenceNumber, status } = req.body || {};
  if (!requestType || !String(requestType).trim()) return res.status(400).json({ error: "requestType is required" });

  const requests = db.addVendorRequest(vendor.id, requestType.trim(), referenceNumber, status);
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

  const { requestType, referenceNumber, status } = req.body || {};
  if (!requestType || !String(requestType).trim()) return res.status(400).json({ error: "requestType is required" });

  const requests = db.updateVendorRequest(vendor.id, Number(req.params.requestId), {
    requestType: requestType.trim(),
    referenceNumber,
    status,
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
