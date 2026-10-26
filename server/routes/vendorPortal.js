const express = require("express");
const db = require("../data/db");
const { requireVendorAuth } = require("../middleware/vendorAuth");
const { createLoginThrottle } = require("../utils/loginThrottle");

const router = express.Router();

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

module.exports = router;
