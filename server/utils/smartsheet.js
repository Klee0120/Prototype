// Thin, read-only client for a one-way pull from a single Smartsheet sheet
// (the WOM project tracker). Opt-in via environment variables, same pattern
// as server/utils/mailer.js -- if they aren't set, every call here fails
// clearly rather than silently, and nothing elsewhere in the app depends on
// it. This app never writes back to Smartsheet; it only ever reads.
const SMARTSHEET_API_TOKEN = process.env.SMARTSHEET_API_TOKEN;
const SMARTSHEET_SHEET_ID = process.env.SMARTSHEET_SHEET_ID;
const SMARTSHEET_API_BASE = "https://api.smartsheet.com/2.0";

function isConfigured() {
  return Boolean(SMARTSHEET_API_TOKEN && SMARTSHEET_SHEET_ID);
}

// The raw Smartsheet shape: { name, columns: [{id, title, ...}], rows: [{id, cells: [{columnId, value, displayValue}]}] }
async function fetchSheet() {
  if (!isConfigured()) {
    throw new Error("Smartsheet isn't connected -- set SMARTSHEET_API_TOKEN and SMARTSHEET_SHEET_ID");
  }
  const res = await fetch(`${SMARTSHEET_API_BASE}/sheets/${SMARTSHEET_SHEET_ID}`, {
    headers: { Authorization: `Bearer ${SMARTSHEET_API_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Smartsheet API error ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

// Reshapes the raw column-id-keyed cell arrays into { sheetName, columns:
// ["Title", ...], rows: [{Title: value, ..., __smartsheetRowId}] } -- both
// easier for a human (the admin preview) and for column-to-WOM-field
// mapping logic to work with than Smartsheet's own shape. __smartsheetRowId
// is Smartsheet's own row id, carried along (not a column) so a later sync
// can recognize the same row again even after its WOM # cell changes --
// see syncWomsFromSheetRows in server/data/db.js.
function simplifySheet(rawSheet) {
  const titleByColumnId = Object.fromEntries((rawSheet.columns || []).map((c) => [c.id, c.title]));
  const columns = (rawSheet.columns || []).map((c) => c.title);
  const rows = (rawSheet.rows || []).map((row) => {
    const obj = { __smartsheetRowId: String(row.id) };
    for (const cell of row.cells || []) {
      const title = titleByColumnId[cell.columnId];
      if (title) obj[title] = cell.displayValue !== undefined ? cell.displayValue : cell.value;
    }
    return obj;
  });
  return { sheetName: rawSheet.name, columns, rows };
}

async function fetchSimplifiedSheet() {
  return simplifySheet(await fetchSheet());
}

// Finds the column whose title contains every given keyword (case-
// insensitive substring match) -- tolerant of whatever exact punctuation or
// line-wrapping the real sheet uses (e.g. "Estimate WOM $ - Project
// Total"), since that can't be hardcoded byte-for-byte without seeing the
// live sheet. Returns null if no column matches all the keywords.
function findColumn(columns, keywords) {
  const lower = keywords.map((k) => k.toLowerCase());
  return columns.find((c) => lower.every((k) => c.toLowerCase().includes(k))) || null;
}

module.exports = { isConfigured, fetchSheet, fetchSimplifiedSheet, simplifySheet, findColumn };
