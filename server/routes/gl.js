const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin, requireFinancialsAccess } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin, requireFinancialsAccess);

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
  "Name - Alpha Explanation": "nameAlpha",
  "Name - Remark Explanation": "remark",
  "Purchase Order": "purchaseOrder",
  "Subledger - G/L": "subledgerGl",
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
      nameAlpha: mapped.nameAlpha != null ? String(mapped.nameAlpha).trim() : null,
      remark: mapped.remark != null ? String(mapped.remark).trim() : null,
      purchaseOrder: mapped.purchaseOrder,
      subledgerGl: toCleanString(mapped.subledgerGl),
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

// Parses the file and reports what period it covers, without committing
// anything -- lets the frontend show "this looks like Period 8/FY26, 1,204
// rows" and have the admin confirm that's actually the report they meant to
// drop in before it overwrites anything for that period.
router.post("/preview", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.json({
    periodNumber: parsed.periodNumber,
    fiscalYear: parsed.fiscalYear,
    rowCount: parsed.rows.length,
    existingImport: db.findGlImportByPeriod(parsed.periodNumber, parsed.fiscalYear),
  });
});

router.post("/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const glImport = db.importGlEntries(parsed.rows, parsed.periodNumber, parsed.fiscalYear, req.user.id, req.file.originalname);

  // File it the same way a Reports-tab labor report upload is filed, so it
  // shows up there automatically -- the Reports tab already has a
  // "gl_report" category slot keyed by "YYYY-MM", it's just never had
  // anything land in it from this screen before.
  const relatedId = `20${parsed.fiscalYear}-${String(parsed.periodNumber).padStart(2, "0")}`;
  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname || "").slice(0, 10);
  const storedName = `${id}${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, storedName), req.file.buffer);
  db.insertFile({
    id,
    relatedType: "labor_report",
    relatedId,
    category: "gl_report",
    originalName: req.file.originalname,
    storedName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedBy: req.user.id,
    uploadedAt: new Date().toISOString(),
    formType: null,
    expiresAt: null,
  });

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

router.get("/status", (req, res) => {
  res.json({ ...db.getGlImportStatus(), coverage: db.getGlFiscalYearCoverage() });
});

// The fiscal calendar's own period/month names for one fiscal year -- backs
// Spend Breakdown's "fiscal month to fiscal month" range filter (see
// db.getGlFiscalYearCoverage, which already has this same period list for
// GL Reconciliation's coverage strip).
router.get("/fiscal-calendar", (req, res) => {
  const fiscalYear = req.query.fiscalYear ? Number(req.query.fiscalYear) : undefined;
  res.json(db.getGlFiscalYearCoverage(fiscalYear));
});

// Every fiscal year the close calendar covers, regardless of import history
// -- backs the Timekeeping reference view (public/js/views/fiscalCalendar.js),
// which an admin can consult for a period's dates whether or not its GL has
// been imported yet.
router.get("/fiscal-calendar-years", (req, res) => {
  res.json(db.getGlFiscalCalendarYears());
});

// Cheap aggregate-only counts/totals for the summary tiles -- see
// db.getGlReconciliationSummary for why this is split out from the
// paginated lists below rather than computed alongside them.
router.get("/reconciliation/summary", (req, res) => {
  res.json(db.getGlReconciliationSummary());
});

router.get("/reconciliation/reconciled", (req, res) => {
  res.json(
    db.getReconciledPage({
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
      coding: req.query.coding,
      aboveOnly: req.query.aboveOnly === "true",
      missingLocationOnly: req.query.missingLocationOnly === "true",
    })
  );
});

router.get("/reconciliation/unmatched", (req, res) => {
  res.json(db.getUnmatchedEntriesPage({ page: req.query.page, pageSize: req.query.pageSize }));
});

router.get("/reconciliation/no-po-reference", (req, res) => {
  res.json(db.getNoPoReferenceEntriesPage({ page: req.query.page, pageSize: req.query.pageSize }));
});

// Every imported GL line grouped by its own chart-of-accounts category
// (phone, health insurance, software license, etc. -- see
// db.getGlSpendBreakdown) and by territory -- the Spend Breakdown view's
// pie chart and legend. territory is optional and matches the global
// topbar territory filter's own values. fiscalYear alone scopes to every
// period in that year combined; periodFrom/periodTo (inclusive) narrow
// that to a fiscal-month range within the year; fiscalYear + periodNumber
// scopes to one exact month. Scoped by default to GL lines with no PO
// reference and no WOM reference (see db.getGlSpendBreakdown); pass
// noPoReferenceOnly=false and/or noWomReferenceOnly=false to widen either.
router.get("/spend-breakdown", (req, res) => {
  const { territory, periodNumber, fiscalYear, periodFrom, periodTo, noPoReferenceOnly, noWomReferenceOnly, includePoRemaining } = req.query || {};
  res.json(
    db.getGlSpendBreakdown({
      territory: territory || null,
      periodNumber: periodNumber ? Number(periodNumber) : null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
      periodFrom: periodFrom ? Number(periodFrom) : null,
      periodTo: periodTo ? Number(periodTo) : null,
      noPoReferenceOnly: noPoReferenceOnly == null ? true : noPoReferenceOnly !== "false",
      noWomReferenceOnly: noWomReferenceOnly == null ? true : noWomReferenceOnly !== "false",
      includePoRemaining: includePoRemaining === "true",
    })
  );
});

// The actual GL lines behind one Spend Breakdown row -- a category or a
// territory, clicked to see what's really in it (see
// db.getGlSpendDetailPage). Same filters as /spend-breakdown, plus
// optional category/territory to pick the slice and page/pageSize to
// paginate it.
router.get("/spend-breakdown/detail", (req, res) => {
  const { category, territory, periodNumber, fiscalYear, periodFrom, periodTo, noPoReferenceOnly, noWomReferenceOnly, page, pageSize } = req.query || {};
  res.json(
    db.getGlSpendDetailPage({
      category: category || null,
      territory: territory || null,
      periodNumber: periodNumber ? Number(periodNumber) : null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
      periodFrom: periodFrom ? Number(periodFrom) : null,
      periodTo: periodTo ? Number(periodTo) : null,
      noPoReferenceOnly: noPoReferenceOnly == null ? true : noPoReferenceOnly !== "false",
      noWomReferenceOnly: noWomReferenceOnly == null ? true : noWomReferenceOnly !== "false",
      page,
      pageSize,
    })
  );
});

// Cell Phone is a Spend Breakdown category (see db.parseObjectAccountCategory)
// pulled into its own report -- which number, how much, and which month
// (see db.getCellPhoneCharges). territory optional, matches the global
// topbar territory filter's values; fiscalYear optional, scopes to one
// fiscal year (every imported period in it).
router.get("/cell-phones", (req, res) => {
  const { territory, fiscalYear } = req.query || {};
  res.json(
    db.getCellPhoneCharges({
      territory: territory || null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
    })
  );
});

// Same shape of report as /cell-phones, for the Meals Empl/Meals & Ent
// categories (see db.getMealsCharges for why this surfaces a verbatim
// "description" rather than a parsed-out name).
router.get("/meals", (req, res) => {
  const { territory, fiscalYear } = req.query || {};
  res.json(
    db.getMealsCharges({
      territory: territory || null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
    })
  );
});

module.exports = router;
