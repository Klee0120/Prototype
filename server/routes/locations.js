const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { findColumn } = require("../utils/smartsheet");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// A real COA export represents a blank/not-applicable job number as a cell
// full of dashes ("-----") rather than leaving it empty.
function toJobNumberString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^-+$/.test(s)) return null;
  return s;
}

// Toyota's own "Job Numbers" sheet -- same E&F Contract Job Number this
// app's own locations already carry (for matching POs), plus the E1 WOM
// Job Number that's been missing: WOM-type time posts to location.subsidiary.WOM#,
// and that first segment is this number, not the E&F one. Column headers on
// the real file carry extra internal whitespace ("E1 WOM          Job
// Number"), so these are matched by keyword rather than an exact header.
function parseCoaWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames.find((n) => /job\s*numbers/i.test(n)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw Object.assign(new Error("No sheet found in the uploaded file"), { status: 400 });

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (raw.length === 0) return { sheetName, rows: [], missingColumns: [] };

  const columns = Object.keys(raw[0]);
  const descriptionCol = findColumn(columns, ["description"]);
  const efCol = findColumn(columns, ["e&f", "contract", "job"]);
  const womCol = findColumn(columns, ["e1", "wom", "job"]);
  if (!descriptionCol) throw Object.assign(new Error('Could not find a "Description" column in that sheet'), { status: 400 });

  const missingColumns = [];
  if (!efCol) missingColumns.push("E&F Contract Job Number");
  if (!womCol) missingColumns.push("E1 WOM Job Number");

  // Most rows are category headers ("GENERAL MGT & ADMIN") with no job
  // numbers at all and no real location behind them -- skipped here rather
  // than surfaced as noise in the unmatched list.
  const rows = raw
    .map((r) => ({
      description: r[descriptionCol] == null ? null : String(r[descriptionCol]).trim(),
      efJobNumber: efCol ? toJobNumberString(r[efCol]) : null,
      womJobNumber: womCol ? toJobNumberString(r[womCol]) : null,
    }))
    .filter((r) => r.description && (r.efJobNumber || r.womJobNumber));

  return { sheetName, rows, missingColumns };
}

// The E&F subsidiary/service code is a single standard value JDE uses for
// general (E&F) time across every location -- unlike the E&F/WOM Contract
// Job Numbers and WOM subsidiary codes, which vary per location/project and
// are stored on the location/WOM records themselves.
const EF_SUBSIDIARY_CODE = "20920000";

function presentLocation(l) {
  return {
    code: l.code,
    name: l.name,
    efJobNumber: l.ef_job_number,
    womJobNumber: l.wom_job_number,
    region: l.region,
    territory: l.territory,
    efSubsidiaryCode: EF_SUBSIDIARY_CODE,
  };
}

router.get("/", requireAuth, (req, res) => {
  res.json(db.listLocations().map(presentLocation));
});

router.get("/territories", requireAuth, (req, res) => {
  res.json(db.TERRITORIES);
});

// Backfills E&F Contract Job Number / WOM Job Number on existing locations
// from Toyota's own Chart of Accounts export, matched by name. Never
// creates a location -- a COA row with no match just comes back unmatched,
// same "preview, then commit" shape as the PO Tracker import.
router.post("/import-coa", requireAuth, requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const dryRun = req.query.dryRun === "true" || req.body.dryRun === "true";

  let parsed;
  try {
    parsed = parseCoaWorkbook(req.file.buffer);
  } catch (err) {
    return res.status(err.status || 400).json({ error: `Could not read that file: ${err.message}` });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: "No rows with a job number found in the uploaded sheet" });
  }

  const summary = db.runLocationCoaImport(parsed.rows, { commit: !dryRun });
  if (!dryRun) {
    db.addAudit(
      req.user.id,
      "LOCATION_COA_IMPORT",
      `${req.user.name} imported job numbers from the Chart of Accounts: ${summary.changedCount} location(s) updated, ${summary.unmatchedCount} unmatched`
    );
  }
  res.json({ ...summary, dryRun, sheetName: parsed.sheetName, missingColumns: parsed.missingColumns });
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  const { code, name, efJobNumber, region, womJobNumber, territory } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "code and name are required" });
  if (db.findLocation(code)) return res.status(409).json({ error: "Location code already exists" });
  if (territory && !db.TERRITORIES.includes(territory)) return res.status(400).json({ error: "Unknown territory" });

  db.createLocation(code, name, efJobNumber || null, region || null, womJobNumber || null, territory || null);
  db.addAudit(req.user.id, "LOCATION_CREATED", `${req.user.name} created location ${code}: ${name}`);
  res.status(201).json({ ok: true });
});

router.patch("/:code", requireAuth, requireAdmin, (req, res) => {
  const { name, efJobNumber, region, womJobNumber, territory } = req.body || {};
  const existing = db.findLocation(req.params.code);
  if (!existing) return res.status(404).json({ error: "Location not found" });
  if (!name) return res.status(400).json({ error: "name is required" });
  if (territory && !db.TERRITORIES.includes(territory)) return res.status(400).json({ error: "Unknown territory" });

  const location = db.setLocationDetails(req.params.code, { name, efJobNumber, region, womJobNumber, territory });
  db.addAudit(req.user.id, "LOCATION_UPDATED", `${req.user.name} updated location ${location.code}`);
  res.json(presentLocation(location));
});

// A location created by mistake -- a test entry, a typo -- rather than
// leaving it sitting around forever. Unlike a WOM, there's no "force" here:
// reassigning every technician/WOM/allocation that points at a whole
// location is too big a change for one confirm click, so it's blocked
// outright until those are moved elsewhere first.
router.delete("/:code", requireAuth, requireAdmin, (req, res) => {
  const result = db.deleteLocation(req.params.code);
  if (result.error === "not_found") return res.status(404).json({ error: "Location not found" });
  if (result.error === "in_use") {
    const parts = [];
    if (result.technicianCount > 0) parts.push(`${result.technicianCount} technician${result.technicianCount === 1 ? "" : "s"}`);
    if (result.womCount > 0) parts.push(`${result.womCount} WOM${result.womCount === 1 ? "" : "s"}`);
    if (result.allocationCount > 0) parts.push(`${result.allocationCount} allocation${result.allocationCount === 1 ? "" : "s"}`);
    return res.status(409).json({
      technicianCount: result.technicianCount,
      womCount: result.womCount,
      allocationCount: result.allocationCount,
      error: `Still in use by ${parts.join(", ")} -- reassign those first`,
    });
  }

  db.addAudit(req.user.id, "LOCATION_DELETED", `${req.user.name} deleted location ${req.params.code}`);
  res.json({ ok: true });
});

module.exports = router;
