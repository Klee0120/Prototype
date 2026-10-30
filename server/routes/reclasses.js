const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin, requireFinancialsAccess } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin, requireFinancialsAccess);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Label text -> metadata key, matched against Krista's real "RECLASS" sheet
// metric block (see server/data/db.js's reclass_batches table comment).
const METADATA_LABELS = {
  Region: "region",
  "Total GL Line Items for Site": "totalGlLineItems",
  "# of Reclasses for Site": "reclassCount",
  "Total Amount of Reclasses for Site": "totalAmount",
  "Original Date Published:": "originalDatePublished",
  "Revision Date:": "revisionDate",
  "Reason for Change": "reasonForChange",
  "Revision No.:": "revisionNo",
  "Produced By:": "producedBy",
};

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

// A lone "-" is the sheet's own placeholder for "blank," not a real job #/
// WOM #/object code -- confirmed directly after it caused the Linked Toyota
// PO lookup to match every other PO on file that also happened to have no
// WOM # (the Budget PO Tracker import stores the exact same placeholder
// verbatim too, see "WOM Number" in server/routes/pos.js). Trimmed and
// treated as null here before it can ever drive a lookup.
function cleanCell(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

// Merged cells leave gaps between a label and its value -- "next non-null
// cell to the right in this row" is more robust against that than a fixed
// column offset (confirmed against the real file: "Region"'s value sits 2
// columns over, "Produced By:"'s sits 1 column over).
function nextNonNull(row, fromIndex) {
  for (let i = fromIndex; i < row.length; i++) {
    if (row[i] != null && row[i] !== "") return row[i];
  }
  return null;
}

// The real checkbox-block labels -- "Automotive"/"AP"/"Other"/"Customer"
// repeats once for impacting adjustments and once for non-impacting, and
// the 5 root-cause labels follow after that. These don't match
// db.RECLASS_CAUSED_BY_OPTIONS/RECLASS_ROOT_CAUSE_OPTIONS (a different,
// unrelated taxonomy used only by the manual "+ Add finding" form's own
// dropdowns) -- captured here as the sheet's own literal text instead of
// forced into that list.
const IMPACT_CATEGORY_LABELS = ["Automotive", "AP", "Other", "Customer"];
const ROOT_CAUSE_LABELS = ["Process Failure", "Manual Mistake", "System Mistake", "Management Change", "Customer Change"];

// Parses the "RECLASS" sheet of a real submission workbook -- not the
// "Template" sheet (that's the raw JE-upload format for posting the
// correction, a different representation of the same data) and not
// REVENUE/EXPENSE (separate, unrelated JE request types).
function parseReclassWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find((n) => /^reclass$/i.test(n.trim()));
  if (!sheetName) throw Object.assign(new Error('No "RECLASS" sheet found in this workbook'), { status: 400 });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });

  // Find the header row first, then only scan rows above it for metadata --
  // "Region" (and others) double as line-item column headers at/after that
  // row, which would otherwise clobber the real metadata value.
  let headerRowIndex = -1;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r] || [];
    if (row.some((cell) => typeof cell === "string" && cell.trim() === "Job # (Cost Center or Business Unit)")) {
      headerRowIndex = r;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw Object.assign(new Error("Could not find the RECLASS sheet's line-item header row"), { status: 400 });
  }

  const metadata = {};
  for (let r = 0; r < headerRowIndex; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === "string" && METADATA_LABELS[cell.trim()]) {
        metadata[METADATA_LABELS[cell.trim()]] = nextNonNull(row, c + 1);
      }
    }
  }
  metadata.originalDatePublished = toIsoDate(metadata.originalDatePublished);
  metadata.revisionDate = toIsoDate(metadata.revisionDate);

  // A "Period" column was inserted right after Region (index 14) in the
  // 2026-09 template revision -- detected here, rather than assumed, so an
  // older submission file without it still imports correctly. Every fixed
  // column offset from here on (the Adjustment/Impacting/root-cause block)
  // shifts right by this amount when it's present.
  const headerRow = rows[headerRowIndex] || [];
  const shift = typeof headerRow[15] === "string" && headerRow[15].trim() === "Period" ? 1 : 0;

  // The "Automotive / AP / Other / Customer" block repeats once for
  // impacting adjustments and once for non-impacting -- same four labels
  // both times, distinguishable only by position: the four cells right
  // after the Yes/No "impacts" column (19+shift), then the next four after
  // that, then the 5 root-cause cells, confirmed against the real 2026-09
  // template's own column order.
  const impactingStart = 20 + shift;
  const nonImpactingStart = 24 + shift;
  const rootCauseStart = 28 + shift;
  const markedCategory = (row, startIdx) => IMPACT_CATEGORY_LABELS.find((_, i) => row[startIdx + i] === "x" || row[startIdx + i] === "X") || null;

  const items = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    // A blank "From" job # ends the real data -- what follows is either the
    // sheet's own totals row or empty pre-numbered template rows (this
    // template supports up to 200 lines; most submissions use far fewer).
    if (row[1] == null || row[1] === "") break;

    const causedBy = markedCategory(row, impactingStart) || markedCategory(row, nonImpactingStart);
    const rootCause = ROOT_CAUSE_LABELS.find((_, i) => row[rootCauseStart + i] === "x" || row[rootCauseStart + i] === "X") || null;

    const periodRaw = shift ? row[15] : null;
    const period =
      typeof periodRaw === "number"
        ? periodRaw
        : periodRaw != null && /^\d+$/.test(String(periodRaw).trim())
          ? Number(String(periodRaw).trim())
          : null;

    items.push({
      lineNumber: row[0],
      fromJobNumber: cleanCell(row[1]),
      fromObjectCode: cleanCell(row[2]),
      fromSubsidiary: cleanCell(row[3]),
      fromWomNumber: cleanCell(row[4]),
      fromAmount: typeof row[5] === "number" ? row[5] : null,
      toJobNumber: cleanCell(row[7]),
      toObjectCode: cleanCell(row[8]),
      toSubsidiary: cleanCell(row[9]),
      toWomNumber: cleanCell(row[10]),
      toAmount: typeof row[11] === "number" ? row[11] : null,
      vendor: row[12] != null ? String(row[12]).trim() : null,
      comments: row[13] != null ? String(row[13]).trim() : null,
      region: row[14] != null ? String(row[14]).trim() : null,
      period,
      costCenterAdjusted: row[15 + shift] === "x" || row[15 + shift] === "X",
      // Fixed from the previous mapping, which had these two swapped
      // relative to the real sheet's own column order (confirmed against
      // the 2026-09 template: Cost Center, Object Code, Subsidiary Code,
      // then Subledger/WOM, in that order). There's no dedicated
      // "subsidiaryCodeAdjusted" field in the schema -- subledgerAdjusted
      // is the closest fit of the four existing adjustment booleans.
      objectCodeAdjusted: row[16 + shift] === "x" || row[16 + shift] === "X",
      subledgerAdjusted: row[17 + shift] === "x" || row[17 + shift] === "X",
      womAdjusted: row[18 + shift] === "x" || row[18 + shift] === "X",
      impactsFinalInvoice: row[19 + shift] != null ? String(row[19 + shift]).trim() : null,
      causedBy,
      rootCause,
      pathForward: row[33 + shift] != null ? String(row[33 + shift]).trim() : null,
    });
  }

  return { metadata, items, sheetName };
}

router.get("/batches", (req, res) => {
  res.json(db.listReclassBatches());
});

router.get("/batches/:id", (req, res) => {
  const batch = db.findReclassBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: "Reclass batch not found" });
  res.json(batch);
});

router.post("/batches/import", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let parsed;
  try {
    parsed = parseReclassWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (parsed.items.length === 0) {
    return res.status(400).json({ error: "No reclass line items found in that file's RECLASS sheet" });
  }
  const batch = db.importReclassBatch(parsed.metadata, parsed.items, req.user.id, req.file.originalname);
  db.addAudit(
    req.user.id,
    "RECLASS_IMPORTED",
    `${req.user.name} imported a reclass submission (${parsed.items.length} line items, ${parsed.metadata.region || "no region"})`
  );
  res.status(201).json(batch);
});

function reclassFiltersFromQuery(query) {
  return {
    status: query.status,
    source: query.source,
    region: query.region,
    fiscalPeriodNumber: query.fiscalPeriodNumber,
    fiscalYear: query.fiscalYear,
    womNumber: query.womNumber,
    search: query.search,
  };
}

router.get("/items", (req, res) => {
  res.json(db.listReclassItems(reclassFiltersFromQuery(req.query)));
});

// Total reclassed $ and item count for whatever filters the list above is
// currently showing (e.g. region=Midwest) -- a separate call rather than
// folded into the list response so the list endpoint stays a plain array.
router.get("/summary", (req, res) => {
  res.json(db.getReclassSummary(reclassFiltersFromQuery(req.query)));
});

router.post("/items", (req, res) => {
  const item = db.addReclassItem(req.body || {}, req.user.id);
  db.addAudit(req.user.id, "RECLASS_FLAGGED", `${req.user.name} flagged a reclass finding (PO/WOM ${item.toWomNumber || item.fromWomNumber || "n/a"})`);
  res.status(201).json(item);
});

// One-click flag from the Budget PO Tracker (single PO or a bulk
// selection) -- logs a lightweight, undetailed reclass finding against
// each PO so it shows up on the running "flagged this month" list without
// requiring the full From/To form up front. See db.flagPosForReclass.
router.post("/flag-po", (req, res) => {
  const poIds = Array.isArray(req.body?.poIds) ? req.body.poIds : [];
  if (poIds.length === 0) return res.status(400).json({ error: "poIds is required" });
  const result = db.flagPosForReclass(poIds, req.user.id);
  if (result.flaggedCount > 0) {
    db.addAudit(
      req.user.id,
      "RECLASS_FLAGGED",
      `${req.user.name} flagged ${result.flaggedCount} PO${result.flaggedCount === 1 ? "" : "s"} for reclass review from the Budget PO Tracker`
    );
  }
  res.json(result);
});

// The symmetric undo for flag-po above -- removes whatever open flag
// exists for each PO outright (same action the Reclasses tab's own Status
// dropdown triggers by setting "Dismissed"), per Krista: this list is a
// pin, unflagging means it's gone, not kept around with a Dismissed badge.
router.post("/unflag-po", (req, res) => {
  const poIds = Array.isArray(req.body?.poIds) ? req.body.poIds : [];
  if (poIds.length === 0) return res.status(400).json({ error: "poIds is required" });
  const result = db.unflagPosForReclass(poIds, req.user.id);
  if (result.unflaggedCount > 0) {
    db.addAudit(
      req.user.id,
      "RECLASS_UNFLAGGED",
      `${req.user.name} unflagged ${result.unflaggedCount} PO${result.unflaggedCount === 1 ? "" : "s"} for reclass review from the Budget PO Tracker`
    );
  }
  res.json(result);
});

// Looks up this item's named WOM(s) against the Budget PO Tracker's own
// wom_number field, then shows whatever GL has actually posted against
// each matching PO -- lets the admin see with their own eyes whether a
// reclass has shown up in the GL yet, without the app auto-declaring it
// posted (that's still a manual call -- see confirmed_gl_reference).
router.get("/items/:id/gl-links", (req, res) => {
  const item = db.findReclassItem(Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Reclass item not found" });
  res.json({
    fromWomNumber: item.fromWomNumber,
    fromLinks: db.getPoGlLinksByWom(item.fromWomNumber),
    toWomNumber: item.toWomNumber,
    toLinks: item.toWomNumber && item.toWomNumber !== item.fromWomNumber ? db.getPoGlLinksByWom(item.toWomNumber) : [],
    // Direct search for the reclass itself having posted (see
    // findReclassPostingMatches) -- independent of WOM/PO, since the "to"
    // side of a reclass often moves to a job with no WOM at all.
    fromPostingMatches: db.findReclassPostingMatches(item.fromJobNumber, item.fromAmount),
    toPostingMatches: db.findReclassPostingMatches(item.toJobNumber, item.toAmount),
    // The tightened check (job # + object code + subsidiary + amount,
    // scoped to strictly after this item's own fiscal period) -- Part C's
    // "did this actually hit on the next report" signal. Still just a
    // candidate for admin to look at, same as the two above; never an
    // auto-confirmation of the item's status.
    toPostingMatchesTightened: db.findTightenedReclassPostingMatches(
      item.toJobNumber || item.fromJobNumber,
      item.toObjectCode || item.fromObjectCode,
      item.toSubsidiary || item.fromSubsidiary,
      item.toAmount != null ? item.toAmount : item.fromAmount,
      item.fiscalPeriodNumber,
      item.fiscalYear
    ),
  });
});

router.patch("/items/:id", (req, res) => {
  try {
    const updated = db.updateReclassItem(req.params.id, { ...(req.body || {}), updatedBy: req.user.id });
    if (!updated) return res.status(404).json({ error: "Reclass item not found" });
    // Setting status to 'dismissed' deletes the row instead of persisting
    // that status (see db.updateReclassItem) -- the list is a pin, not a
    // history log, so "dismissed" and "removed" are the same action.
    if (updated.deleted) {
      db.addAudit(req.user.id, "RECLASS_STATUS_CHANGED", `${req.user.name} dismissed and removed reclass #${updated.id}`);
      return res.json(updated);
    }
    if (req.body && req.body.status) {
      db.addAudit(req.user.id, "RECLASS_STATUS_CHANGED", `${req.user.name} set reclass #${updated.id} to ${db.RECLASS_STATUS_LABELS[updated.status] || updated.status}`);
    }
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reclass activity the GL itself shows (via the "Name - Alpha Explanation"
// signal), regardless of whether a Reclass Submission workbook was ever
// imported for it -- see db.getGlReclassActivity.
router.get("/gl-activity", (req, res) => {
  res.json(db.getGlReclassActivity());
});

// Exact header row from the real 2026-09+ template's RECLASS sheet (see
// parseReclassWorkbook above, and tests/reclasses.test.js's own import
// fixture) -- reused verbatim here, rather than redefined, so an export
// built from this row always round-trips straight back through that same
// parser.
const RECLASS_SHEET_HEADER = [
  "#", "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount", "To",
  "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount",
  "Vendor", "Comments", "Region", "Period",
  "Cost Center Adjustment", "Object Code Adjustment", "Subsidiary Code Adjustment", "Subledger (WOM#) Adjustment",
  "Yes (Impacting)  or No (Non Impacting)", "Automotive", "AP", "Other", "Customer", "Automotive", "AP", "Other", "Customer",
  "Process Failure", "Manual Mistake", "System Mistake", "Management Change", "Customer Change", "Comments and Path forward",
];

// The real "GL RECLASS - Expense Detail" sheet's 32 columns, in their real
// order (confirmed directly against a territory's own submission file).
// Only the 18 marked `true` have any backing data in gl_entries (see
// gl.js's own COLUMN_MAP, the GL import's column list) -- the other 14
// ship as blank columns below, not fabricated, since this app's GL import
// never captures them from any source file.
const EXPENSE_DETAIL_COLUMNS = [
  { header: "G/L Posted Code", supported: false },
  { header: "Period Number - General Ledger", key: "periodNumber", supported: true },
  { header: "Fiscal Year", key: "fiscalYear", supported: true },
  { header: "Business Unit Type", supported: false },
  { header: "GL Date", key: "glDate", supported: true },
  { header: "Document Type", key: "documentType", supported: true },
  { header: "Document Number", key: "documentNumber", supported: true },
  { header: "Address Number", supported: false },
  { header: "Name - Alpha Explanation", key: "nameAlpha", supported: true },
  { header: "Journal Entry Line Number", key: "journalEntryLineNumber", supported: true },
  { header: "Business Unit", key: "businessUnit", supported: true },
  { header: "Object Account", key: "objectAccount", supported: true },
  { header: "Subsidiary", key: "subsidiary", supported: true },
  { header: "Subledger - G/L", key: "subledgerGl", supported: true },
  { header: "Subledger Type", supported: false },
  { header: "Name - Remark Explanation", key: "remark", supported: true },
  { header: "Reference 2", supported: false },
  { header: "Amount", key: "amount", supported: true },
  { header: "Batch Number", key: "batchNumber", supported: true },
  { header: "Supplier Invoice Number", key: "supplierInvoiceNumber", supported: true },
  { header: "Bill Type", supported: false },
  { header: "Batch Date", supported: false },
  { header: "Invoice Date", key: "invoiceDate", supported: true },
  { header: "Cat Code 02", supported: false },
  { header: "Cat Code 03", supported: false },
  { header: "Cat Code 04", supported: false },
  { header: "Cat Code 05", supported: false },
  { header: "Cat Code 06", supported: false },
  { header: "Customer Code", supported: false },
  { header: "Location Code", key: "locationCode", supported: true },
  { header: "Group Code", supported: false },
  { header: "Purchase Order", key: "purchaseOrder", supported: true },
];

// Matches the real submission file's own title block + two-column metric
// layout exactly (confirmed against 5 real territory files): two title
// rows, a blank row, then 6 rows pairing a left-side metric (col B/D) with
// a right-side one (col M/N) -- "% of Reclasses for Region" has no
// right-side partner, so that row's right half is just left blank.
// parseReclassWorkbook doesn't care which row/column a label lands in (it
// scans every pre-header-row cell and reads the next non-null cell to its
// right in that same row), so this layout is cosmetic, not load-bearing --
// but it's what Finance is used to seeing.
function reclassMetadataRows(metadata) {
  const titleRow = (value) => {
    const r = [];
    r[1] = value;
    return r;
  };
  const metricRow = (leftLabel, leftValue, rightLabel, rightValue) => {
    const r = [];
    r[1] = leftLabel;
    r[3] = leftValue == null ? null : leftValue;
    r[12] = rightLabel;
    r[13] = rightValue == null ? null : rightValue;
    return r;
  };
  const pctOfReclassesForRegion = metadata.totalGlLineItems ? metadata.reclassCount / metadata.totalGlLineItems : null;
  return [
    titleRow("C&W Services"),
    titleRow("JOURNAL ENTRY  FORM - RECLASS"),
    [],
    metricRow("Metric Calculations", null, "Original Date Published:", metadata.originalDatePublished),
    metricRow("Region", metadata.region, "Revision Date:", metadata.revisionDate),
    metricRow("Total GL Line Items for Site", metadata.totalGlLineItems, "Reason for Change", metadata.reasonForChange),
    metricRow("# of Reclasses for Site", metadata.reclassCount, "Revision No.:", metadata.revisionNo),
    metricRow("Total Amount of Reclasses for Site", metadata.totalAmount, "Produced By:", metadata.producedBy),
    metricRow("% of Reclasses for Region", pctOfReclassesForRegion, null, null),
  ];
}

// The category-group header row that sits exactly one row above
// RECLASS_SHEET_HEADER in every real submission file -- these 6 labels
// span the same impacting/non-impacting/root-cause/path-forward column
// groups RECLASS_SHEET_HEADER's own columns already land on (confirmed
// against the real file's column positions, same 21/25/29/34 starts
// reclassItemToSheetRow/parseReclassWorkbook already use).
const RECLASS_CATEGORY_HEADER_ROW = (() => {
  const row = new Array(RECLASS_SHEET_HEADER.length).fill(null);
  row[16] = "TYPE";
  row[20] = "Would this have an impact on Final Invoice?";
  row[21] = "Impacting Adjustments";
  row[25] = "Non Impacting Adjustments";
  row[29] = "FINAL";
  row[34] = "FINAL ACTION TO PREVENT REOCCURANCE (if applicable)";
  return row;
})();

// Mirrors parseReclassWorkbook's column reading, in reverse -- each item
// becomes one row at the exact offsets that parser expects (shift=1, since
// this always writes the current, Period-column template).
function reclassItemToSheetRow(item, index) {
  const row = new Array(RECLASS_SHEET_HEADER.length).fill(null);
  row[0] = item.lineNumber || index + 1;
  row[1] = item.fromJobNumber;
  row[2] = item.fromObjectCode;
  row[3] = item.fromSubsidiary;
  row[4] = item.fromWomNumber;
  row[5] = item.fromAmount;
  row[7] = item.toJobNumber;
  row[8] = item.toObjectCode;
  row[9] = item.toSubsidiary;
  row[10] = item.toWomNumber;
  row[11] = item.toAmount;
  row[12] = item.vendor;
  row[13] = item.comments;
  row[14] = item.region;
  row[15] = item.fiscalPeriodNumber;
  if (item.costCenterAdjusted) row[16] = "x";
  if (item.objectCodeAdjusted) row[17] = "x";
  if (item.subledgerAdjusted) row[18] = "x"; // the sheet's own "Subsidiary Code Adjustment" column -- see parseReclassWorkbook's comment on this field's name
  if (item.womAdjusted) row[19] = "x";
  row[20] = item.impactsFinalInvoice;
  const impacting = item.impactsFinalInvoice === "Yes";
  const categoryIdx = IMPACT_CATEGORY_LABELS.indexOf(item.causedBy);
  if (categoryIdx !== -1) row[(impacting ? 21 : 25) + categoryIdx] = "x";
  const rootCauseIdx = ROOT_CAUSE_LABELS.indexOf(item.rootCause);
  if (rootCauseIdx !== -1) row[29 + rootCauseIdx] = "x";
  row[34] = item.pathForward;
  return row;
}

// The real raw JE-upload format Finance actually posts from (confirmed
// directly against 5 real territory files' own "Template" sheet) -- not
// the simplified Job#/Object/Subsidiary/WOM/Amount/Vendor/Comments shape
// this used to produce. One negative leg (pulling the dollars off the
// wrong coding) and one positive leg (landing them on the right coding)
// per reclass, same FROM/TO fields as the RECLASS sheet's own From/To
// block, just laid out the way the JE upload expects it.
function reclassItemToTemplateRows(item) {
  const leg = (jobNumber, objectCode, subsidiary, womNumber, amount) => ({
    // A dotted composite string, not three separate columns -- confirmed
    // against the real file's own "Account Number" column, e.g.
    // "100110043046.605200.20920000".
    accountNumber: [jobNumber, objectCode, subsidiary].join("."),
    amount,
    accountDescription: null,
    subledgerType: womNumber ? "W" : null,
    subledger: womNumber || null,
    subledgerDescription: null,
    // Truncated to 30 chars -- the column's own header says so, and the
    // real file's own values are cut at exactly 30.
    remark: (item.vendor || "").slice(0, 30),
    purchaseOrder: null,
    purchaseOrderSuffix: null,
    period: item.fiscalPeriodNumber,
  });
  return [
    leg(item.fromJobNumber, item.fromObjectCode, item.fromSubsidiary, item.fromWomNumber, -Math.abs(item.fromAmount || 0)),
    leg(item.toJobNumber, item.toObjectCode, item.toSubsidiary, item.toWomNumber, Math.abs(item.toAmount != null ? item.toAmount : item.fromAmount || 0)),
  ];
}

// REVENUE and EXPENSE are always-blank boilerplate stubs in every real
// submission file seen (confirmed against 5 real territory files, even
// fully-filled ones) -- this just matches their title-block structure for
// completeness, not real data.
function blankJournalEntryFormSheet(title, labelCol) {
  const titleRow = (value) => {
    const r = [];
    r[0] = value;
    return r;
  };
  const labelRow = (value) => {
    const r = [];
    r[labelCol] = value;
    return r;
  };
  return [titleRow("C&W Services"), titleRow(title), [], labelRow("Date of Request"), labelRow("Requester:"), labelRow("Requester Phone:"), labelRow("For the month of:")];
}

// Builds the same 5-sheet workbook both finance-export routes below hand
// back -- factored out so "just export what's on the list" (GET, no
// side effects) and "accept everything then export" (POST, below) can
// never drift apart in what they actually put in the file.
function buildFinanceExportWorkbook({ region, periodNumber, year, status, producedBy }) {
  // A blank "From" job # ends parseReclassWorkbook's own read of the line
  // items (it's the sheet's own "no more real rows" signal) -- an item with
  // no job # at all can't be posted as a reclass anyway (there's nothing to
  // pull the dollars off of), so it's left out here rather than written as
  // a blank row that would silently truncate every row after it on re-import.
  const allItems = db.listReclassItems({ region, fiscalPeriodNumber: periodNumber, fiscalYear: year, status });
  const items = allItems.filter((it) => it.fromJobNumber);

  const totalAmount = items.reduce((sum, it) => sum + Math.abs(it.fromAmount || 0), 0);
  const metadata = {
    region,
    totalGlLineItems: db.countGlEntriesForRegionPeriod(region, periodNumber, year),
    reclassCount: items.length,
    totalAmount,
    originalDatePublished: new Date().toISOString().slice(0, 10),
    revisionDate: new Date().toISOString().slice(0, 10),
    reasonForChange: "Monthly GL reclass submission",
    revisionNo: 1,
    producedBy,
  };

  const reclassSheetRows = [...reclassMetadataRows(metadata), RECLASS_CATEGORY_HEADER_ROW, RECLASS_SHEET_HEADER, ...items.map((it, i) => reclassItemToSheetRow(it, i))];
  const reclassSheet = XLSX.utils.aoa_to_sheet(reclassSheetRows);

  const templateHeader = [
    "Account Number",
    "Amount",
    "Account Description",
    "Subledger Type (if applicable)",
    "Subledger (if applicable)",
    "Subledger Description",
    "Remark (30 Characters)",
    "Purchase Order (if applicable)",
    "Purchase Order Suffix (if applicable)",
    "Period",
  ];
  const templateRows = items
    .flatMap(reclassItemToTemplateRows)
    .map((r) => [r.accountNumber, r.amount, r.accountDescription, r.subledgerType, r.subledger, r.subledgerDescription, r.remark, r.purchaseOrder, r.purchaseOrderSuffix, r.period]);
  const templateSheet = XLSX.utils.aoa_to_sheet([templateHeader, ...templateRows]);

  const expenseDetailHeader = EXPENSE_DETAIL_COLUMNS.map((c) => c.header);
  const expenseDetailRows = items.flatMap((item) =>
    db.findGlEntriesForReclassLine(item).map((glRow) => EXPENSE_DETAIL_COLUMNS.map((c) => (c.supported ? (glRow[c.key] == null ? null : glRow[c.key]) : null)))
  );
  const expenseDetailSheet = XLSX.utils.aoa_to_sheet([expenseDetailHeader, ...expenseDetailRows]);

  const revenueSheet = XLSX.utils.aoa_to_sheet(blankJournalEntryFormSheet("JOURNAL ENTRY  FORM - REVENUE", 4));
  const expenseSheet = XLSX.utils.aoa_to_sheet(blankJournalEntryFormSheet("JOURNAL ENTRY  FORM - EXPENSE", 5));

  // Sheet order matches every real submission file seen, exactly: Template,
  // RECLASS, GL RECLASS - Expense Detail, REVENUE, EXPENSE.
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, templateSheet, "Template");
  XLSX.utils.book_append_sheet(workbook, reclassSheet, "RECLASS");
  XLSX.utils.book_append_sheet(workbook, expenseDetailSheet, "GL RECLASS - Expense Detail");
  XLSX.utils.book_append_sheet(workbook, revenueSheet, "REVENUE");
  XLSX.utils.book_append_sheet(workbook, expenseSheet, "EXPENSE");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const fileName = `${region}_Reclass_Fiscal_${periodNumber}-${year}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { buffer, fileName, itemCount: items.length };
}

// The Finance-ready export Krista asked for: "export a reclass submission
// report exactly like the ones I attached for the submission which is the
// format needed for finance to do those reclasses" -- same 5 sheets, in the
// same order, as a real territory submission (Template, RECLASS, GL
// RECLASS - Expense Detail, REVENUE, EXPENSE -- confirmed against 5 real
// territory files), built from whatever's currently on the Reclass list
// for this region/period rather than a new file someone has to fill out by
// hand. A plain look at the file -- never changes any item's status (see
// /accept-export below for the version that does).
router.get("/finance-export", (req, res) => {
  const { region, fiscalPeriodNumber, fiscalYear, status } = req.query || {};
  if (!region || !fiscalPeriodNumber || !fiscalYear) {
    return res.status(400).json({ error: "region, fiscalPeriodNumber, and fiscalYear are all required" });
  }
  const { buffer, fileName } = buildFinanceExportWorkbook({
    region,
    periodNumber: Number(fiscalPeriodNumber),
    year: Number(fiscalYear),
    status,
    producedBy: req.user.name,
  });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buffer);
});

// Krista's real end-to-end ask: review every line for a region/month (the
// table's own Yes/No approve-or-reject actions, or a "fix" edit, per item),
// then hit one button that both locks the whole slice in as sent to
// Finance and drops the filled-out submission workbook, instead of two
// separate steps where it's unclear whether anything was ever actually
// finalized. Marking the batch accepted happens before the file is built,
// so what gets exported is identical to the GET route's own output -- just
// with the items' status now reflecting that this file was actually handed
// to Finance.
router.post("/accept-export", (req, res) => {
  const { region, fiscalPeriodNumber, fiscalYear } = req.body || {};
  if (!region || !fiscalPeriodNumber || !fiscalYear) {
    return res.status(400).json({ error: "region, fiscalPeriodNumber, and fiscalYear are all required" });
  }
  const periodNumber = Number(fiscalPeriodNumber);
  const year = Number(fiscalYear);
  const acceptedCount = db.acceptReclassItemsForExport({ region, fiscalPeriodNumber: periodNumber, fiscalYear: year, actorId: req.user.id });
  const { buffer, fileName, itemCount } = buildFinanceExportWorkbook({ region, periodNumber, year, producedBy: req.user.name });
  db.addAudit(
    req.user.id,
    "RECLASS_ACCEPTED_EXPORTED",
    `${req.user.name} accepted and exported ${itemCount} reclass line${itemCount === 1 ? "" : "s"} for ${region}, P${periodNumber}/FY${year}` +
      (acceptedCount ? ` (${acceptedCount} newly marked Submitted)` : "")
  );
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buffer);
});

router.get("/meta", (req, res) => {
  res.json({
    statuses: db.RECLASS_STATUSES.map((value) => ({ value, label: db.RECLASS_STATUS_LABELS[value] })),
    causedByOptions: db.RECLASS_CAUSED_BY_OPTIONS,
    rootCauseOptions: db.RECLASS_ROOT_CAUSE_OPTIONS,
    territories: db.TERRITORIES,
    // Every seeded fiscal period (not just ones with items already flagged
    // in them) -- lets the filter offer the current/upcoming period before
    // anything's been flagged in it yet. See db.resolveFiscalPeriod for why
    // this doesn't line up with plain calendar months.
    fiscalPeriods: db.getGlFiscalCalendar().map((p) => ({
      periodNumber: p.periodNumber,
      fiscalYear: p.fiscalYear,
      monthName: p.monthName,
    })),
  });
});

module.exports = router;
