const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// A deliberately narrow, read-only view for technicians: enough to look up
// "is this vendor good to use / how do I reach them," nothing about forms,
// COI limits, onboarding cases, or any other admin/compliance detail.
//
// Only a vendor that's actually cleared to use is returned at all -- a
// vendor merely *appearing* on a list a technician looks at reads as
// "this is fine to use," so the list itself has to be the filter rather
// than a badge on an otherwise-visible row.
//
// Gated on cwStatus/toyotaStatus/formsStatus -- the real-world fields
// already imported for all 292 existing vendors -- not on the newer
// case-based onboardingStage tracker. That tracker defaults every
// pre-existing vendor to "not_started" (it predates the tracker) and
// document-check confirmation (formChecksComplete) is still incomplete
// for most of them, so gating on either would hide the vendor base
// techs already legitimately use today. onboardingStage is only
// consulted to catch the one case it's authoritative for: a vendor
// actively flagged "denied" during (re-)verification is excluded even if
// its older status fields still say active/approved.
function isReadyForTechs(v) {
  return v.cwStatus === "active" && v.toyotaStatus === "approved" && v.formsStatus !== "outdated" && v.onboardingStage !== "denied";
}

function presentVendorForLookup(v) {
  return {
    id: v.id,
    name: v.name,
    phone: v.phone,
    email: v.email,
    services: v.services,
    onlineSourceUrl: v.onlineSourceUrl,
    lastInvoicedAt: v.lastInvoicedAt,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listVendors().filter(isReadyForTechs).map(presentVendorForLookup));
});

module.exports = router;
