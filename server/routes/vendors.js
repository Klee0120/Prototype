const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

function validateVendorBody(body) {
  const { name, cwStatus, toyotaStatus, formsStatus, successfulInvoiceRecords } = body || {};
  if (!name || !String(name).trim()) return "name is required";
  if (cwStatus && !db.CW_STATUSES.includes(cwStatus)) return `cwStatus must be one of: ${db.CW_STATUSES.join(", ")}`;
  if (toyotaStatus && !db.TOYOTA_STATUSES.includes(toyotaStatus)) {
    return `toyotaStatus must be one of: ${db.TOYOTA_STATUSES.join(", ")}`;
  }
  if (formsStatus && !db.FORMS_STATUSES.includes(formsStatus)) {
    return `formsStatus must be one of: ${db.FORMS_STATUSES.join(", ")}`;
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
  db.addAudit(req.user.id, "VENDOR_UPDATED", `${req.user.name} updated vendor ${vendor.name}`);
  res.json(vendor);
});

router.delete("/:id", (req, res) => {
  const vendor = db.deleteVendor(req.params.id);
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  db.addAudit(req.user.id, "VENDOR_DELETED", `${req.user.name} removed vendor ${vendor.name}`);
  res.json({ ok: true });
});

module.exports = router;
