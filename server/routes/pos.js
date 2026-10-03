const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Exact header names from the Operations PO Request Tracking export.
// Question 1/Question 2 (the original request's intake-form answers) are
// read from the sheet but not stored -- they're about how the request was
// submitted, not about the PO/vendor/cost record itself.
const COLUMN_MAP = {
  "Date Requested": "dateRequested",
  Description: "description",
  Requestor: "requestor",
  "PO Number": "poNumber",
  "E&F Contract Job #": "efJobNumberRaw",
  "PO Amount": "poAmount",
  "Change Order": "changeOrder",
  Status: "status",
  "Vendor Name": "vendorName",
  "Vendor Number": "vendorNumber",
  "PPS Job Number": "ppsJobNumber",
  "E1 WOM Job #": "e1WomJobNumber",
  "WOM Number": "womNumber",
  "Asset Number": "assetNumber",
  "Maximo WO#": "maximoWo",
  "Object Code": "objectCode",
  Subsidiary: "subsidiary",
  "PPS Subsidiary": "ppsSubsidiary",
  Admin: "adminName",
  Urgent: "urgent",
  "Urgent Reason/Notes": "urgentNotes",
};

// "PPS Subsidiary" is a newer column on the real sheet -- a form-side
// guardrail that keeps certain requestors (e.g. janitorial) from picking a
// bad subsidiary code. A given row only ever has one of "Subsidiary" /
// "PPS Subsidiary" filled in, never both, but they mean the exact same
// thing (confirmed directly) -- coalesced into the one `subsidiary` field
// everywhere else in the app already reads. Optional in the missing-column
// check since older exports won't have this column at all.
const OPTIONAL_COLUMNS = new Set(["PPS Subsidiary"]);

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

// Vendor/PO numbers come back from the sheet as either a string or a float
// (Excel stores plain numbers as numbers) -- normalize both to a clean
// integer-looking string so "5174341" and 5174341.0 match the same vendor.
function toCleanNumberString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return String(Math.trunc(value));
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

// A row only ever has one of "Subsidiary" / "PPS Subsidiary" filled in, not
// both -- whichever is present is the real value.
function coalesceSubsidiary(subsidiary, ppsSubsidiary) {
  const primary = subsidiary == null || subsidiary === "" ? null : String(subsidiary).trim();
  if (primary) return primary;
  const fallback = ppsSubsidiary == null || ppsSubsidiary === "" ? null : String(ppsSubsidiary).trim();
  return fallback;
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames.find((n) => /po.*track/i.test(n)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw Object.assign(new Error("No sheet found in the uploaded file"), { status: 400 });

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const missingColumns = [];
  if (raw.length > 0) {
    const firstRowKeys = new Set(Object.keys(raw[0]));
    for (const header of Object.keys(COLUMN_MAP)) {
      if (OPTIONAL_COLUMNS.has(header)) continue;
      if (!firstRowKeys.has(header)) missingColumns.push(header);
    }
  }

  const rows = raw.map((r) => {
    const row = {};
    for (const [header, field] of Object.entries(COLUMN_MAP)) {
      row[field] = r[header];
    }
    return {
      ...row,
      // sheet_to_json's non-enumerable __rowNum__ is 0-indexed with the
      // header counted as row 0, so +1 gives the row number as Excel itself
      // displays it -- used to re-identify a record across re-imports when
      // its own text has changed (see computePoMatchKeys / runPoImport).
      lineNumber: r.__rowNum__ + 1,
      dateRequested: toIsoDate(row.dateRequested),
      poAmount: row.poAmount == null || row.poAmount === "" ? null : Number(row.poAmount),
      vendorNumber: toCleanNumberString(row.vendorNumber),
      poNumber: row.poNumber == null ? null : String(row.poNumber).trim(),
      urgent: Boolean(row.urgent),
      description: row.description == null ? null : String(row.description).trim(),
      requestor: row.requestor == null ? null : String(row.requestor).trim(),
      vendorName: row.vendorName == null ? null : String(row.vendorName).trim(),
      status: row.status == null ? null : String(row.status).trim(),
      subsidiary: coalesceSubsidiary(row.subsidiary, row.ppsSubsidiary),
    };
  });

  return { rows, sheetName, missingColumns };
}

router.get("/", (req, res) => {
  res.json(
    db.listPos({
      lifecycleStatus: req.query.lifecycleStatus,
      vendorId: req.query.vendorId,
      locationCode: req.query.locationCode,
      status: req.query.status,
      vendorUnmatched: req.query.vendorUnmatched === "true",
      regionUnassigned: req.query.regionUnassigned === "true",
      adminUnmatched: req.query.adminUnmatched === "true",
      womLinkMissing: req.query.womLinkMissing === "true",
      womNumber: req.query.womNumber,
      search: req.query.search,
    })
  );
});

router.get("/last-import", (req, res) => {
  res.json(db.getLastPoImport());
});

router.get("/:id", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  res.json(po);
});

router.get("/:id/tasks", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  res.json(db.listPoTasks(po.id));
});

// A quick way to log a follow-up against a PO still being organized (e.g.
// "find out who this vendor is") without it showing up anywhere in Task
// Manager until the PO itself is moved to Active -- listTasks' own join
// handles the hiding, this route just creates the link.
router.post("/:id/tasks", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  const title = (req.body && req.body.title ? String(req.body.title) : "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });

  const task = db.createTask({
    title,
    description: req.body.description || "",
    assignedTo: req.body.assignedTo || null,
    assignedRole: req.body.assignedRole || null,
    priority: req.body.priority || "normal",
    dueAt: req.body.dueAt || null,
    category: "manual",
    relatedVendorId: po.vendorId || null,
    relatedPoId: po.id,
    source: "po_tracker",
    createdBy: req.user.id,
  });
  res.status(201).json(task);
});

router.post("/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const dryRun = req.query.dryRun === "true" || req.body.dryRun === "true";

  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file: ${err.message}` });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: "No rows found in the uploaded sheet" });
  }

  try {
    const summary = db.runPoImport(parsed.rows, req.user.id, { dryRun });
    if (!dryRun) {
      db.addAudit(
        req.user.id,
        "PO_IMPORT",
        `${req.user.name} imported the PO tracker: ${summary.createdCount} new, ${summary.updatedCount} updated, ${summary.missingCount} missing`
      );
    }
    res.json({ ...summary, dryRun, sheetName: parsed.sheetName, missingColumns: parsed.missingColumns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id/vendor", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  const { vendorId } = req.body || {};
  if (!vendorId) return res.status(400).json({ error: "vendorId is required" });
  try {
    const updated = db.confirmPoVendor(po.id, Number(vendorId));
    db.addAudit(req.user.id, "PO_VENDOR_CONFIRMED", `${req.user.name} confirmed a vendor link for PO record #${po.id}`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id/vendor", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  res.json(db.clearPoVendorMatch(po.id));
});

// Tags a Location with this PO's own E&F job # -- either an existing
// location (locationCode) or a brand new one (newLocation: {code, name,
// territory}) -- then re-resolves every PO sharing that job #. Replaces the
// old bare "assign a region" shortcut, which never actually matched the PO
// to a real location.
router.patch("/:id/location-tag", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  try {
    const updated = db.tagLocationForPo(po.id, {
      locationCode: req.body ? req.body.locationCode : null,
      newLocation: req.body ? req.body.newLocation : null,
    });
    db.addAudit(req.user.id, "PO_LOCATION_TAGGED", `${req.user.name} tagged a location for PO record #${po.id} (job # ${po.efJobNumber || "n/a"})`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/bulk/confirm-vendor", (req, res) => {
  const { ids, vendorId } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids is required" });
  if (!vendorId) return res.status(400).json({ error: "vendorId is required" });
  try {
    const updated = db.bulkConfirmPoVendor(ids.map(Number), Number(vendorId));
    db.addAudit(req.user.id, "PO_VENDOR_CONFIRMED", `${req.user.name} confirmed a vendor link for ${ids.length} PO record(s)`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:id/activate", (req, res) => {
  const po = db.findPo(req.params.id);
  if (!po) return res.status(404).json({ error: "PO not found" });
  const updated = db.movePoToActive(po.id);
  db.addAudit(req.user.id, "PO_ACTIVATED", `${req.user.name} moved PO record #${po.id} (${po.vendorName || "no vendor"}) to Active`);
  res.json(updated);
});

router.post("/bulk/activate", (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids is required" });
  const updated = db.bulkMovePoToActive(ids.map(Number));
  db.addAudit(req.user.id, "PO_ACTIVATED", `${req.user.name} moved ${ids.length} PO record(s) to Active`);
  res.json(updated);
});

module.exports = router;
