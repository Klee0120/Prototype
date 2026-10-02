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
      fromJobNumber: row[1] != null ? String(row[1]).trim() : null,
      fromObjectCode: row[2] != null ? String(row[2]).trim() : null,
      fromSubsidiary: row[3] != null ? String(row[3]).trim() : null,
      fromWomNumber: row[4] != null ? String(row[4]).trim() : null,
      fromAmount: typeof row[5] === "number" ? row[5] : null,
      toJobNumber: row[7] != null ? String(row[7]).trim() : null,
      toObjectCode: row[8] != null ? String(row[8]).trim() : null,
      toSubsidiary: row[9] != null ? String(row[9]).trim() : null,
      toWomNumber: row[10] != null ? String(row[10]).trim() : null,
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

router.get("/items", (req, res) => {
  res.json(
    db.listReclassItems({
      status: req.query.status,
      source: req.query.source,
      region: req.query.region,
    })
  );
});

router.post("/items", (req, res) => {
  const item = db.addReclassItem(req.body || {}, req.user.id);
  db.addAudit(req.user.id, "RECLASS_FLAGGED", `${req.user.name} flagged a reclass finding (PO/WOM ${item.toWomNumber || item.fromWomNumber || "n/a"})`);
  res.status(201).json(item);
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
  });
});

router.patch("/items/:id", (req, res) => {
  try {
    const updated = db.updateReclassItem(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Reclass item not found" });
    if (req.body && req.body.status) {
      db.addAudit(req.user.id, "RECLASS_STATUS_CHANGED", `${req.user.name} set reclass #${updated.id} to ${db.RECLASS_STATUS_LABELS[updated.status] || updated.status}`);
    }
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/meta", (req, res) => {
  res.json({
    statuses: db.RECLASS_STATUSES.map((value) => ({ value, label: db.RECLASS_STATUS_LABELS[value] })),
    causedByOptions: db.RECLASS_CAUSED_BY_OPTIONS,
    rootCauseOptions: db.RECLASS_ROOT_CAUSE_OPTIONS,
  });
});

module.exports = router;
