const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Exact header names from Krista's real monthly "GL Report" extract. Only
// the "GL Report" sheet is read -- a Findings-style workbook also carries
// one filtered sheet per reviewer (named after each person), which are
// slices of this same data for manual review, not independent source data.
const COLUMN_MAP = {
  "Period Number - General Ledger": "periodNumber",
  "Fiscal Year": "fiscalYear",
  "GL Date": "glDate",
  "Document Type": "documentType",
  "Document Number": "documentNumber",
  "Journal Entry Line Number": "journalEntryLineNumber",
  "Business Unit": "businessUnit",
  "Object Account": "objectAccount",
  Subsidiary: "subsidiary",
  Amount: "amount",
  "Batch Number": "batchNumber",
  "Supplier Invoice Number": "supplierInvoiceNumber",
  "Invoice Date": "invoiceDate",
  "Location Code": "locationCode",
  "Name - Remark Explanation": "remark",
  "Purchase Order": "purchaseOrder",
};

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function toCleanString(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return String(Math.trunc(value));
  return String(value).trim() || null;
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames.find((n) => n.trim().toLowerCase() === "gl report") || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw Object.assign(new Error('No "GL Report" sheet found in this workbook'), { status: 400 });

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (raw.length > 0) {
    const firstRowKeys = new Set(Object.keys(raw[0]));
    const missingColumns = Object.keys(COLUMN_MAP).filter((h) => !firstRowKeys.has(h));
    if (missingColumns.length > 0) {
      throw Object.assign(new Error(`GL Report sheet is missing expected column(s): ${missingColumns.join(", ")}`), { status: 400 });
    }
  }

  const rows = [];
  let periodNumber = null;
  let fiscalYear = null;
  for (const raw0 of raw) {
    // Every real GL line has a period number -- a trailing blank row (or a
    // totals row with no GL detail) doesn't, and isn't a transaction.
    if (raw0["Period Number - General Ledger"] == null) continue;
    const mapped = {};
    for (const [header, field] of Object.entries(COLUMN_MAP)) {
      mapped[field] = raw0[header];
    }
    if (periodNumber == null) periodNumber = Number(mapped.periodNumber);
    if (fiscalYear == null) fiscalYear = Number(mapped.fiscalYear);
    rows.push({
      glDate: toIsoDate(mapped.glDate),
      documentType: mapped.documentType != null ? String(mapped.documentType).trim() : null,
      documentNumber: toCleanString(mapped.documentNumber),
      journalEntryLineNumber: mapped.journalEntryLineNumber != null ? Number(mapped.journalEntryLineNumber) : null,
      businessUnit: toCleanString(mapped.businessUnit),
      objectAccount: mapped.objectAccount != null ? String(mapped.objectAccount).trim() : null,
      subsidiary: toCleanString(mapped.subsidiary),
      amount: typeof mapped.amount === "number" ? mapped.amount : mapped.amount != null ? Number(mapped.amount) : null,
      batchNumber: toCleanString(mapped.batchNumber),
      supplierInvoiceNumber: mapped.supplierInvoiceNumber != null ? String(mapped.supplierInvoiceNumber).trim() : null,
      invoiceDate: toIsoDate(mapped.invoiceDate),
      locationCode: mapped.locationCode != null ? String(mapped.locationCode).trim() : null,
      remark: mapped.remark != null ? String(mapped.remark).trim() : null,
      purchaseOrder: mapped.purchaseOrder,
    });
  }

  if (rows.length === 0) {
    throw Object.assign(new Error('No GL transaction rows found in that file\'s "GL Report" sheet'), { status: 400 });
  }
  if (periodNumber == null || Number.isNaN(periodNumber) || fiscalYear == null || Number.isNaN(fiscalYear)) {
    throw Object.assign(new Error("Couldn't read a Period Number / Fiscal Year off this GL Report -- check those columns are populated"), {
      status: 400,
    });
  }

  return { rows, periodNumber, fiscalYear };
}

router.post("/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const glImport = db.importGlEntries(parsed.rows, parsed.periodNumber, parsed.fiscalYear, req.user.id, req.file.originalname);
  db.addAudit(
    req.user.id,
    "GL_IMPORTED",
    `${req.user.name} imported the GL report for Period ${parsed.periodNumber}/FY${parsed.fiscalYear} ` +
      `(${glImport.rowCount} lines, ${glImport.matchedCount} matched to a PO, ${glImport.unmatchedCount} with a PO # not on file)`
  );
  res.status(201).json(glImport);
});

router.get("/imports", (req, res) => {
  res.json(db.listGlImports());
});

router.get("/reconciliation", (req, res) => {
  res.json(db.getPoReconciliation());
});

module.exports = router;
