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

  // A real monthly extract is always a single period, but some exports (e.g.
  // a rolling "open WOM backlog" report pulled across several months) carry
  // rows from more than one Period/Fiscal Year. Group by each row's own
  // period instead of assuming the whole file is one, so every period lands
  // under its own gl_imports/gl_entries rows instead of getting mislabeled
  // under whichever period the first row happens to be.
  const groups = new Map(); // "period|fy" -> { periodNumber, fiscalYear, rows }
  for (const raw0 of raw) {
    // Every real GL line has a period number -- a trailing blank row (or a
    // totals row with no GL detail) doesn't, and isn't a transaction.
    if (raw0["Period Number - General Ledger"] == null) continue;
    const mapped = {};
    for (const [header, field] of Object.entries(COLUMN_MAP)) {
      mapped[field] = raw0[header];
    }
    const periodNumber = Number(mapped.periodNumber);
    const fiscalYear = Number(mapped.fiscalYear);
    if (Number.isNaN(periodNumber) || Number.isNaN(fiscalYear)) continue;
    const key = `${periodNumber}|${fiscalYear}`;
    if (!groups.has(key)) groups.set(key, { periodNumber, fiscalYear, rows: [] });
    groups.get(key).rows.push({
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

  const periods = [...groups.values()].sort((a, b) => a.fiscalYear - b.fiscalYear || a.periodNumber - b.periodNumber);

  if (periods.length === 0) {
    throw Object.assign(
      new Error('No GL transaction rows with a readable Period Number / Fiscal Year were found in that file\'s "GL Report" sheet'),
      { status: 400 }
    );
  }

  return { periods };
}

// Parses the file and reports what period(s) it covers, without committing
// anything -- lets the frontend show "this looks like Period 8/FY26, 1,204
// rows" (or a breakdown across several periods for a multi-period file) and
// have the admin confirm that's actually the report they meant to drop in
// before it overwrites anything for those periods.
router.post("/preview", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const periods = parsed.periods.map((p) => ({
    periodNumber: p.periodNumber,
    fiscalYear: p.fiscalYear,
    rowCount: p.rows.length,
    existingImport: db.findGlImportByPeriod(p.periodNumber, p.fiscalYear),
  }));
  res.json({
    periods,
    totalRowCount: periods.reduce((s, p) => s + p.rowCount, 0),
  });
});

// A plain "YYYY-MM" the admin typed/picked for what calendar month they
// mean this report to be for -- their own stated intent, recorded
// alongside the file's own Period/Fiscal Year columns (which may cover
// several periods at once) so there's always a visible, ordered record of
// what was imported when. Not required to match the file's own period(s)
// -- the frontend's confirm step already shows both side by side -- just
// required to be present and shaped like a month.
function validateCalendarMonth(raw) {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  return raw;
}

router.post("/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const calendarMonth = validateCalendarMonth(req.body.calendarMonth);
  if (!calendarMonth) return res.status(400).json({ error: "calendarMonth is required (YYYY-MM)" });
  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  // One importGlEntries call per period -- each only deletes/replaces its
  // own period's gl_entries rows, so a 14-period file doesn't touch any
  // period's data it doesn't itself carry rows for.
  const results = parsed.periods.map((p) =>
    db.importGlEntries(p.rows, p.periodNumber, p.fiscalYear, req.user.id, req.file.originalname, calendarMonth)
  );

  // File the source document into the Reports tab the same way a labor
  // report upload is filed, so it shows up there automatically -- only for
  // a single-period file, which has one obvious "YYYY-MM" slot to file it
  // under. A multi-period file (e.g. a rolling open-WOM-backlog export
  // spanning several months) has no single correct period slot for the
  // source document itself -- the GL data still lands correctly per period
  // above either way, it's just not also filed as a Reports-tab document.
  if (results.length === 1) {
    const only = results[0];
    const relatedId = `20${only.fiscalYear}-${String(only.periodNumber).padStart(2, "0")}`;
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
  }

  const totals = results.reduce(
    (acc, r) => ({
      rowCount: acc.rowCount + r.rowCount,
      matchedCount: acc.matchedCount + r.matchedCount,
      unmatchedCount: acc.unmatchedCount + r.unmatchedCount,
      noPoReferenceCount: acc.noPoReferenceCount + (r.noPoReferenceCount ?? 0),
    }),
    { rowCount: 0, matchedCount: 0, unmatchedCount: 0, noPoReferenceCount: 0 }
  );

  const periodsSummary = results.map((r) => `Period ${r.periodNumber}/FY${r.fiscalYear} (${r.rowCount} lines)`).join(", ");
  db.addAudit(
    req.user.id,
    "GL_IMPORTED",
    `${req.user.name} imported the GL report covering ${periodsSummary} ` +
      `(${totals.rowCount} lines total, ${totals.matchedCount} matched to a PO, ${totals.unmatchedCount} with a PO # not on file)`
  );
  res.status(201).json({ periods: results, ...totals });
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
  const { territory, location, periodNumber, fiscalYear, periodFrom, periodTo, noPoReferenceOnly, noWomReferenceOnly, includePoRemaining, excludeBurden } =
    req.query || {};
  res.json(
    db.getGlSpendBreakdown({
      territory: territory || null,
      location: location || null,
      periodNumber: periodNumber ? Number(periodNumber) : null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
      periodFrom: periodFrom ? Number(periodFrom) : null,
      periodTo: periodTo ? Number(periodTo) : null,
      noPoReferenceOnly: noPoReferenceOnly == null ? true : noPoReferenceOnly !== "false",
      noWomReferenceOnly: noWomReferenceOnly == null ? true : noWomReferenceOnly !== "false",
      includePoRemaining: includePoRemaining === "true",
      excludeBurden: excludeBurden === "true",
    })
  );
});

// The actual GL lines behind one Spend Breakdown row -- a category, a
// territory, or a location, clicked to see what's really in it (see
// db.getGlSpendDetailPage). Same filters as /spend-breakdown, plus
// optional category/territory/location to pick the slice and page/pageSize
// to paginate it.
router.get("/spend-breakdown/detail", (req, res) => {
  const {
    category,
    territory,
    location,
    periodNumber,
    fiscalYear,
    periodFrom,
    periodTo,
    noPoReferenceOnly,
    noWomReferenceOnly,
    excludeBurden,
    search,
    page,
    pageSize,
  } = req.query || {};
  res.json(
    db.getGlSpendDetailPage({
      category: category || null,
      territory: territory || null,
      location: location || null,
      periodNumber: periodNumber ? Number(periodNumber) : null,
      fiscalYear: fiscalYear ? Number(fiscalYear) : null,
      periodFrom: periodFrom ? Number(periodFrom) : null,
      periodTo: periodTo ? Number(periodTo) : null,
      noPoReferenceOnly: noPoReferenceOnly == null ? true : noPoReferenceOnly !== "false",
      noWomReferenceOnly: noWomReferenceOnly == null ? true : noWomReferenceOnly !== "false",
      excludeBurden: excludeBurden === "true",
      search: search || null,
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

// R&M spend-vs-budget + OT-rate trend by site/fiscal year (see
// db.getBudgetReviewReport for why this exists -- it fills the gap in
// C&W's own FY27 budget deck, where some sites get a 5-year supporting
// chart and others, Kansas City included, don't). categories is a repeated
// query param (categories=R%26M&categories=Parts) narrowing the spend
// total to just those GL categories; omitted, every category counts.
router.get("/budget-review", (req, res) => {
  const { territory, location, excludeBurden } = req.query || {};
  let categories = req.query?.categories;
  if (categories == null) categories = [];
  else if (!Array.isArray(categories)) categories = [categories];
  res.json(
    db.getBudgetReviewReport({
      territory: territory || null,
      location: location || null,
      categories,
      excludeBurden: excludeBurden === "true",
    })
  );
});

router.get("/rm-budgets", (req, res) => {
  res.json(db.listRmBudgets());
});

router.put("/rm-budgets", (req, res) => {
  const { locationCode, fiscalYear, amount } = req.body || {};
  if (!locationCode || fiscalYear == null || amount == null) {
    return res.status(400).json({ error: "locationCode, fiscalYear, and amount are required" });
  }
  res.json(db.setRmBudget(locationCode, Number(fiscalYear), Number(amount), req.user.id));
});

module.exports = router;
