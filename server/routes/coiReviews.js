// The COI Reviews queue -- cross-vendor visibility the per-vendor routes in
// vendors.js don't give: a pooled COI with no vendor match yet, and every
// still-open review across every vendor, in one place, instead of an admin
// having to already be on the right vendor's profile to know a review
// exists at all.
const express = require("express");
const path = require("path");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { buildCoiRequirementChecklist, extractCoiDocumentText } = require("../utils/coiDocumentReview");

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get("/queue", (req, res) => {
  res.json({
    pool: db.listCoiPoolFiles(),
    pendingReviews: db.listPendingCoiReviewsAcrossVendors(),
  });
});

// Moves a pooled file onto a real vendor (same row -- see db.reassignFile)
// and immediately starts its review, same as the per-vendor Review COI
// action, so picking a vendor here lands the admin straight in the review
// rather than a second trip back through the vendor's own Documents tab.
router.post("/pool/:fileId/assign-vendor", async (req, res) => {
  const file = db.getFile(req.params.fileId);
  if (!file || file.relatedType !== "coi_pool") return res.status(404).json({ error: "Pooled file not found" });

  const vendorId = (req.body || {}).vendorId;
  const vendor = vendorId ? db.findVendor(vendorId) : null;
  if (!vendor) return res.status(400).json({ error: "A valid vendorId is required" });

  const updated = db.reassignFile(file.id, { relatedType: "vendor", relatedId: vendor.id });
  db.addAudit(req.user.id, "COI_POOL_FILE_ASSIGNED", `${req.user.name} assigned pooled COI "${file.originalName}" to ${vendor.name}`);

  // Mirrors POST /api/admin/vendors/:id/files/:fileId/coi-review -- a
  // pooled file is always still "pending" review by definition, so this
  // never hits the "already has a pending review" branch that route
  // guards against.
  const extractedText = await extractCoiDocumentText(path.join(db.UPLOADS_DIR, updated.storedName));
  const checklist = await buildCoiRequirementChecklist(vendor.services);
  const review = db.createCoiDocumentReview({ fileId: updated.id, vendorId: vendor.id, extractedText, checklist });

  res.json({ file: updated, review });
});

module.exports = router;
