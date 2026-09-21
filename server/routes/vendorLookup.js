const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// A deliberately narrow, read-only view for technicians: enough to look up
// "is this vendor good to use / how do I reach them," nothing about forms,
// COI limits, onboarding cases, or any other admin/compliance detail.
function presentVendorForLookup(v) {
  let overallStatus = "onboarding";
  if (v.cwStatus === "active" && v.toyotaStatus === "approved") overallStatus = "active";
  else if (v.cwStatus === "inactive" || v.toyotaStatus === "not_approved") overallStatus = "inactive";

  return {
    id: v.id,
    name: v.name,
    cwStatus: v.cwStatus,
    toyotaStatus: v.toyotaStatus,
    overallStatus,
    phone: v.phone,
    email: v.email,
    services: v.services,
    onlineSourceUrl: v.onlineSourceUrl,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listVendors().map(presentVendorForLookup));
});

module.exports = router;
