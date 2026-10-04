const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const IMPACTING_CATEGORIES = db.RECLASS_CAUSED_BY_OPTIONS;
const ROOT_CAUSE_CATEGORIES = db.RECLASS_ROOT_CAUSE_OPTIONS;

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

  const items = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    // A blank "From" job # ends the real data -- what follows is either the
    // sheet's own totals row or empty pre-numbered template rows (this
    // template supports up to 200 lines; most submissions use far fewer).
    if (row[1] == null || row[1] === "") break;

    const causedBy =
      IMPACTING_CATEGORIES.find((_, i) => row[20 + i] === "x" || row[20 + i] === "X") ||
      IMPACTING_CATEGORIES.find((_, i) => row[27 + i] === "x" || row[27 + i] === "X") ||
      null;
    const rootCause = ROOT_CAUSE_CATEGORIES.find((_, i) => row[34 + i] === "x" || row[34 + i] === "X") || null;

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
      costCenterAdjusted: row[15] === "x" || row[15] === "X",
      subledgerAdjusted: row[16] === "x" || row[16] === "X",
      objectCodeAdjusted: row[17] === "x" || row[17] === "X",
      womAdjusted: row[18] === "x" || row[18] === "X",
      impactsFinalInvoice: row[19] != null ? String(row[19]).trim() : null,
      causedBy,
      rootCause,
      pathForward: row[39] != null ? String(row[39]).trim() : null,
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

// The symmetric undo for flag-po above -- dismisses whatever open flag
// exists for each PO (same "Dismissed" status the Reclasses tab's own
// Status dropdown sets), so it's gone from "flagged this month" without
// losing the record of it ever having been flagged.
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
  });
});

router.patch("/items/:id", (req, res) => {
  try {
    const updated = db.updateReclassItem(req.params.id, { ...(req.body || {}), updatedBy: req.user.id });
    if (!updated) return res.status(404).json({ error: "Reclass item not found" });
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
