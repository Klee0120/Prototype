const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const db = require("../data/db");
const fileEncryption = require("../utils/fileEncryption");
const { requireVendorAuth } = require("../middleware/vendorAuth");
const { createLoginThrottle } = require("../utils/loginThrottle");
const { extractCoiDocumentText, buildCoiRequirementChecklist, coiExtractionHints, extractCoiStructuredFields } = require("../utils/coiDocumentReview");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Same shape as the internal login's own throttle (server/routes/auth.js)
// -- a wholly separate Map, though, so a vendor hammering their own
// passcode never counts against (or gets locked out by) an internal
// technician/admin's own login attempts, and vice versa.
const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const loginThrottle = createLoginThrottle(MAX_ATTEMPTS, LOCK_DURATION_MS);

router.post("/login", (req, res) => {
  const { taxId, passcode } = req.body || {};
  if (!taxId || !passcode) return res.status(400).json({ error: "Tax ID and passcode are required" });

  const key = String(taxId).trim().toUpperCase();
  if (loginThrottle.isLocked(key)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const vendor = db.verifyVendorLogin(taxId, passcode);
  if (!vendor) {
    loginThrottle.recordFailure(key);
    return res.status(401).json({ error: "Invalid Tax ID or passcode" });
  }

  loginThrottle.clearFailures(key);
  const token = db.createVendorSession(vendor.id);
  db.addAudit(`vendor:${vendor.id}`, "VENDOR_PORTAL_LOGIN", `${vendor.name} logged into the vendor portal`, vendor.id);

  res.json({ token, id: vendor.id, name: vendor.name });
});

router.post("/logout", requireVendorAuth, (req, res) => {
  db.deleteVendorSession(req.vendorSessionToken);
  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_LOGOUT", `${req.vendor.name} logged out of the vendor portal`, req.vendor.id);
  res.json({ ok: true });
});

// The portal's own landing view -- name + the same approved/total
// checklist the admin Onboarding board shows for this vendor, nothing
// else. See db.getVendorPortalChecklist's own comment on why that math is
// computed once, server-side, rather than duplicated here.
router.get("/me", requireVendorAuth, (req, res) => {
  const checklist = db.getVendorPortalChecklist(req.vendor.id);
  if (!checklist) return res.status(404).json({ error: "Vendor not found" });
  res.json(checklist);
});

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// A vendor filling in their own Contact phone / Email / PO email --
// fields that already exist on the vendor record and show on the admin
// Overview tab, but previously only an admin could set (via "Edit
// vendor"). Deliberately its own narrow route rather than routing a
// vendor session through the admin PATCH /api/admin/vendors/:id, which
// accepts (and requires) every vendor column -- name, onboarding stage,
// JDE #, etc. -- none of which a vendor should ever be able to touch.
// db.updateVendorContactInfo only ever writes these three columns, and
// only ever for req.vendor.id, same hardcoded-to-self pattern the
// document upload route above already uses.
router.patch("/contact-info", requireVendorAuth, (req, res) => {
  const { phone, email, poEmail } = req.body || {};
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "That doesn't look like a valid email address" });
  if (poEmail && !EMAIL_RE.test(poEmail)) return res.status(400).json({ error: "That doesn't look like a valid PO email address" });

  const updated = db.updateVendorContactInfo(req.vendor.id, { phone, email, poEmail });
  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_CONTACT_INFO_UPDATED", `${req.vendor.name} updated their contact info via the vendor portal`, req.vendor.id);
  res.json({ phone: updated.phone, email: updated.email, poEmail: updated.poEmail });
});

// The categories a vendor is allowed to submit themselves -- the same
// vendor-document vocabulary server/routes/files.js already defines for
// relatedType "vendor", minus the two an admin alone ever creates
// (vpo_waiver is a waiver decision, not something a vendor submits;
// vendor_other is a catch-all an admin uses when filing something that
// doesn't fit elsewhere, not a category a vendor would pick for
// themselves).
const VENDOR_UPLOAD_CATEGORIES = new Set(["coi", "w9", "ach", "check", "blank_invoice", "hold_harmless"]);

// A vendor's own document upload -- deliberately a separate handler from
// POST /api/files rather than teaching that route a third identity type.
// That route's canRead/canWrite are built entirely around req.user.role
// (admin/technician); routing a vendor session through it would mean
// every future change there has to keep reasoning about a kind of caller
// it was never designed for. This handler instead hardcodes relatedType
// "vendor" and relatedId to the authenticated vendor's own id -- a vendor
// can never name a different vendor's record, there is no relatedId
// parameter to send -- and otherwise writes through the exact same
// db.insertFile/UPLOADS_DIR primitives files.js itself uses, so every
// existing admin-side viewer (the file list, COI review, etc.) handles a
// vendor-uploaded file identically to an admin-uploaded one.
router.post("/documents", requireVendorAuth, upload.single("file"), async (req, res) => {
  const { category } = req.body || {};
  if (!req.file) return res.status(400).json({ error: "file is required" });
  if (!category || !VENDOR_UPLOAD_CATEGORIES.has(category)) {
    return res.status(400).json({ error: `category must be one of: ${[...VENDOR_UPLOAD_CATEGORIES].join(", ")}` });
  }
  if (!fileEncryption.isConfigured()) {
    return res.status(503).json({ error: "File encryption is not configured on this server -- uploads are disabled" });
  }

  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname || "").slice(0, 10);
  const storedName = `${id}${ext}`;
  db.writeUploadBytes(storedName, req.file.buffer);

  const file = db.insertFile({
    id,
    relatedType: "vendor",
    relatedId: String(req.vendor.id),
    category,
    originalName: req.file.originalname,
    storedName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: `Vendor: ${req.vendor.name}`,
    uploadedAt: new Date().toISOString(),
  });

  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_DOCUMENT_UPLOADED", `${req.vendor.name} uploaded ${category} "${req.file.originalname}" via the vendor portal`, req.vendor.id, category);

  // A COI upload kicks off the exact same review pipeline an admin's own
  // manual upload does (see POST /api/admin/vendors/:id/files/:fileId/
  // coi-review) -- the vendor gets the same instant extraction feedback,
  // and the review shows up in the admin's existing COI Reviews queue with
  // nothing admin-side needing to change to notice it. Never blocks the
  // upload response on this: a vendor's document is saved and visible
  // either way, even if extraction itself throws on a corrupt file.
  let coiReview = null;
  if (category === "coi") {
    try {
      const vendor = db.findVendor(req.vendor.id);
      const extractedText = await extractCoiDocumentText(db.readUploadBytes(storedName));
      const checklist = await buildCoiRequirementChecklist(vendor.services);
      const created = db.createCoiDocumentReview({ fileId: file.id, vendorId: req.vendor.id, extractedText, checklist });
      // Same two fields the admin-side coi-review route returns (see
      // POST /api/admin/vendors/:id/files/:fileId/coi-review) -- the
      // vendor-facing hint message reads these directly.
      coiReview = { ...created, extractionHints: coiExtractionHints(extractedText), extractedFields: extractCoiStructuredFields(extractedText) };
    } catch (err) {
      console.error(`[vendor-portal] COI review failed to start for file ${file.id}:`, err.message);
    }
  }

  res.status(201).json({ file, coiReview });
});

// A vendor's own upload history -- just the files they're allowed to see
// about their own record, same list an admin sees on this vendor's
// Documents tab.
router.get("/documents", requireVendorAuth, (req, res) => {
  res.json(db.listFiles("vendor", String(req.vendor.id)));
});

// "Need help" -- the vendor-portal equivalent of the tech-facing "Request a
// C&W PO" button (POST /api/tasks/request-po): gives the ask a tracked task
// instead of leaving it as an email/phone call nobody else can see is
// pending. No assignedTo to pick (a vendor has no admin directory to choose
// from, unlike the tech-facing version) -- assignedRole: "admin" lets
// db.createTask's own withAutoAssignee resolve it the same way every other
// role-queued task already does.
router.post("/help-request", requireVendorAuth, (req, res) => {
  const { message } = req.body || {};
  const vendor = db.findVendor(req.vendor.id);
  db.createTask({
    title: `Vendor help request from ${vendor.name}`,
    description: message || "",
    assignedRole: "admin",
    category: "vendor_help_request",
    priority: "normal",
    relatedVendorId: vendor.id,
    source: "vendor_portal",
  });
  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_HELP_REQUESTED", `${vendor.name} requested help via the vendor portal`, vendor.id);
  res.status(201).json({ ok: true });
});

// A requirement the vendor can't meet (e.g. a coverage limit their actual
// policy doesn't carry) -- prompts for why, and routes the ask to admin as
// either a VPO waiver or a hold-harmless agreement request. Both are
// already real document categories for relatedType "vendor" (see
// server/routes/files.js's CATEGORY_BY_RELATED) -- an admin acts on this
// the same way they already handle every other compliance document, by
// filing the real waiver/hold-harmless file once they decide. This route
// only gets the request in front of them with enough context; it doesn't
// invent a new approval workflow.
const COI_WAIVER_OUTCOMES = new Set(["vpo_waiver", "hold_harmless"]);
router.post("/coi-waiver-request", requireVendorAuth, (req, res) => {
  const { requirementKey, requirementLabel, reason, outcome } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: "reason is required" });
  if (!COI_WAIVER_OUTCOMES.has(outcome)) return res.status(400).json({ error: `outcome must be one of: ${[...COI_WAIVER_OUTCOMES].join(", ")}` });

  const vendor = db.findVendor(req.vendor.id);
  const outcomeLabel = outcome === "vpo_waiver" ? "VPO waiver" : "hold harmless agreement";
  const label = requirementLabel || requirementKey || "a COI requirement";
  db.createTask({
    title: `${vendor.name} requests a ${outcomeLabel} -- ${label}`,
    description: `Requirement: ${label}\nRequested outcome: ${outcomeLabel}\nVendor's stated reason: ${reason.trim()}`,
    assignedRole: "admin",
    category: "vendor_waiver_request",
    priority: "normal",
    relatedVendorId: vendor.id,
    source: "vendor_portal",
  });
  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_WAIVER_REQUESTED", `${vendor.name} requested a ${outcomeLabel} for "${label}"`, vendor.id);
  res.status(201).json({ ok: true });
});

// "I think I'm done" -- the vendor's own signal that admin should take a
// final look and go start the real onboarding case in ServiceEdge (see the
// existing "Submit approved COI to ServiceEdge" reminder task this same
// pattern already follows, server/routes/vendors.js). Deliberately NOT a
// deriveOnboardingStage mutation -- stage stays entirely computed from the
// 4 case statuses exactly as it already is; this only ever creates/
// refreshes one task. upsertTaskBySourceKey (not createTask) so clicking
// Submit again after fixing something refreshes the same task instead of
// stacking duplicates.
router.post("/submit-for-review", requireVendorAuth, (req, res) => {
  const vendor = db.findVendor(req.vendor.id);
  const checklist = db.getVendorPortalChecklist(req.vendor.id);
  const task = db.upsertTaskBySourceKey(`VENDOR-${vendor.id}-PORTAL-SUBMIT`, {
    title: `${vendor.name} submitted their onboarding documents for review`,
    description: `${checklist.approvedCount}/${checklist.totalCount} document cases show Approved at submission time. Review everything and, once satisfied, start the onboarding case in ServiceEdge and continue local case tracking as usual.`,
    assignedRole: "admin",
    category: "vendor_submission",
    priority: "normal",
    relatedVendorId: vendor.id,
    source: "vendor_portal",
  });
  db.addAudit(`vendor:${req.vendor.id}`, "VENDOR_PORTAL_SUBMITTED_FOR_REVIEW", `${vendor.name} clicked Submit for review in the vendor portal`, vendor.id);
  res.status(201).json({ ok: true, taskId: task.id });
});

module.exports = router;
