const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../data/db");
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

  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname || "").slice(0, 10);
  const storedName = `${id}${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, storedName), req.file.buffer);

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
      const extractedText = await extractCoiDocumentText(path.join(db.UPLOADS_DIR, storedName));
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

module.exports = router;
