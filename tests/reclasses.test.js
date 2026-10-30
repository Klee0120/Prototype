const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Which fiscal period a date falls into -- fiscal periods don't line up
// with calendar month boundaries (confirmed against Krista's real GL
// export: mid-January dates are legitimately tagged Period 2/FY26). Pure
// function, tested directly against known boundary dates from the real
// C&W Services Monthly Closing Schedule rather than relying on wall-clock
// "today."
test("resolveFiscalPeriod: real fiscal period boundaries from the close calendar", async (t) => {
  const db = require("../server/data/db");

  await t.test("a date on a period's own fiscal month end lands in that period", () => {
    assert.deepEqual(db.resolveFiscalPeriod("2026-01-11"), { periodNumber: 1, fiscalYear: 26 });
    assert.deepEqual(db.resolveFiscalPeriod("2026-02-08"), { periodNumber: 2, fiscalYear: 26 });
  });

  await t.test("a date the day after one period's fiscal month end lands in the next period", () => {
    // Confirmed against the real February GL export: 2026-01-18 (the day
    // after Period 1/FY26's own fiscal month end of 2026-01-11) is a real
    // row tagged Period 2/FY26, not Period 1.
    assert.deepEqual(db.resolveFiscalPeriod("2026-01-12"), { periodNumber: 2, fiscalYear: 26 });
    assert.deepEqual(db.resolveFiscalPeriod("2026-01-18"), { periodNumber: 2, fiscalYear: 26 });
    assert.deepEqual(db.resolveFiscalPeriod("2026-01-22"), { periodNumber: 2, fiscalYear: 26 });
  });

  await t.test("a fiscal year boundary (December into January) resolves correctly on both sides", () => {
    assert.deepEqual(db.resolveFiscalPeriod("2025-12-14"), { periodNumber: 12, fiscalYear: 25 });
    assert.deepEqual(db.resolveFiscalPeriod("2025-12-15"), { periodNumber: 1, fiscalYear: 26 });
  });

  await t.test("a date past the last seeded period returns null, not a guess", () => {
    assert.equal(db.resolveFiscalPeriod("2026-12-14"), null);
  });

  await t.test("no date given returns null", () => {
    assert.equal(db.resolveFiscalPeriod(null), null);
    assert.equal(db.resolveFiscalPeriod(""), null);
  });
});

// A reclass line's own "Period" column (2026-09 template revision) names a
// bare posting month, not a fiscal year -- resolvePeriodFiscalYear picks
// the year from context since more than one seeded fiscal year can share
// the same period number.
test("resolvePeriodFiscalYear: picks the fiscal year closest to a reference date", async () => {
  const db = require("../server/data/db");

  assert.equal(
    db.resolvePeriodFiscalYear(10, "2026-10-15"),
    26,
    "period 10 close to a FY26 date should resolve to FY26, not FY25's same period number"
  );
  assert.equal(
    db.resolvePeriodFiscalYear(10, "2025-10-15"),
    25,
    "the same period number close to a FY25 date should resolve to FY25 instead"
  );
  assert.equal(
    db.resolvePeriodFiscalYear(10, null),
    26,
    "with no reference date at all, falls back to the most recently seeded year"
  );
  assert.equal(db.resolvePeriodFiscalYear(99, "2026-10-15"), null, "a period number outside the seeded calendar returns null");
});

test("Reclasses tab: location/month filtering and the Midwest total", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, womNumber, region, adminName }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, wom_number, region, admin_name, lifecycle_status,
         first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, womNumber, region, adminName, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("flagging a PO for reclass auto-fills region from the PO's own region", async () => {
    const poId = insertPo({ composite: "mw-1", poNumber: "PO80001", womNumber: null, region: "Midwest", adminName: "Pat Admin" });
    const flagRes = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(flagRes.status, 200);
    assert.equal(flagRes.body.flaggedCount, 1);
    assert.equal(flagRes.body.items[0].region, "Midwest");
  });

  await t.test("the general Flag a Finding form resolves region from a typed-in WOM # matched against the PO Tracker", async () => {
    insertPo({ composite: "east-1", poNumber: "PO80002", womNumber: "WOM-EAST-1", region: "East", adminName: "Pat Admin" });
    const res = await server.call("POST", "/api/admin/reclasses/items", {
      userId: "ADMIN",
      body: { fromWomNumber: "WOM-EAST-1", fromAmount: 500, comments: "test" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.region, "East");
  });

  await t.test("with no matching PO, region falls back to the WOM's own location territory", async () => {
    raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("WESTLOC", "West Site", "West");
    raw.prepare("INSERT INTO woms (code, description, status, location_code) VALUES (?, ?, 'open', ?)").run("WOM-WEST-1", "West job", "WESTLOC");
    const res = await server.call("POST", "/api/admin/reclasses/items", {
      userId: "ADMIN",
      body: { fromWomNumber: "WOM-WEST-1", fromAmount: 250, comments: "test" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.region, "West");
  });

  await t.test("a newly flagged item gets today's real fiscal period, not a guessed calendar month", async () => {
    const poId = insertPo({ composite: "period-1", poNumber: "PO80003", womNumber: null, region: "Midwest", adminName: "Pat Admin" });
    const flagRes = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    const expected = db.resolveFiscalPeriod(new Date().toISOString().slice(0, 10));
    assert.equal(flagRes.body.items[0].fiscalPeriodNumber, expected.periodNumber);
    assert.equal(flagRes.body.items[0].fiscalYear, expected.fiscalYear);
  });

  await t.test("listReclassItems filters by region", async () => {
    const res = await server.call("GET", "/api/admin/reclasses/items?region=Midwest", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((r) => r.region === "Midwest"));
  });

  await t.test("listReclassItems filters by fiscal period + year together", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { periodNumber, fiscalYear } = db.resolveFiscalPeriod(today);
    const res = await server.call(
      "GET",
      `/api/admin/reclasses/items?fiscalPeriodNumber=${periodNumber}&fiscalYear=${fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((r) => r.fiscalPeriodNumber === periodNumber && r.fiscalYear === fiscalYear));
  });

  await t.test("the summary endpoint totals match the same filtered slice the list shows", async () => {
    const itemsRes = await server.call("GET", "/api/admin/reclasses/items?region=Midwest", { userId: "ADMIN" });
    const summaryRes = await server.call("GET", "/api/admin/reclasses/summary?region=Midwest", { userId: "ADMIN" });
    assert.equal(summaryRes.status, 200);
    assert.equal(summaryRes.body.itemCount, itemsRes.body.length);
    const expectedTotal = itemsRes.body.reduce((sum, r) => sum + Math.abs(r.fromAmount || 0), 0);
    assert.equal(summaryRes.body.totalAmount, expectedTotal);
  });

  await t.test("meta exposes the territory list and every seeded fiscal period", async () => {
    const res = await server.call("GET", "/api/admin/reclasses/meta", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.territories.includes("Midwest"));
    assert.ok(res.body.fiscalPeriods.length >= 24, "expected both FY25 and FY26's 12 periods each");
    assert.ok(res.body.fiscalPeriods.some((p) => p.periodNumber === 2 && p.fiscalYear === 26 && p.monthName === "February"));
  });

  // A shared/home WOM can carry dozens of POs that have nothing to do with
  // one specific reclass -- most never touched by GL at all. Dumping every
  // one of them into the reclass detail's "Linked Toyota PO" panel buried
  // the PO that actually mattered under noise (Krista: "all this should not
  // be on reclass flag"). getPoGlLinksByWom now only returns POs that
  // actually have GL activity posted against them.
  await t.test("getPoGlLinksByWom drops POs with no GL activity instead of listing every PO on the WOM", async () => {
    const withGlPoId = insertPo({ composite: "gl-1", poNumber: "PO90001", womNumber: "WOM-SHARED-1", region: "Midwest", adminName: "Pat Admin" });
    insertPo({ composite: "nogl-1", poNumber: "PO90002", womNumber: "WOM-SHARED-1", region: "Midwest", adminName: "Pat Admin" });
    insertPo({ composite: "nogl-2", poNumber: "PO90003", womNumber: "WOM-SHARED-1", region: "Midwest", adminName: "Pat Admin" });
    raw
      .prepare(
        `INSERT INTO gl_entries (period_number, fiscal_year, gl_date, amount, matched_po_id, created_at)
         VALUES (2, 26, '2026-02-01', 500, ?, ?)`
      )
      .run(withGlPoId, now);

    const links = db.getPoGlLinksByWom("WOM-SHARED-1");
    assert.equal(links.length, 1, "only the PO with an actual GL line should show up");
    assert.equal(links[0].poNumber, "PO90001");
    assert.equal(links[0].glLineCount, 1);
  });

  await t.test("getPoGlLinksByWom returns nothing for a WOM with no POs at all", () => {
    assert.deepEqual(db.getPoGlLinksByWom("WOM-DOES-NOT-EXIST"), []);
  });

  // The WOM profile's Labor & Financials tab (Plan: WOM Profile Consolidation)
  // surfaces exactly this same GL-matched data through its own route.
  await t.test("GET /api/woms/:code/gl-links exposes the same GL-matched POs as the db helper", async () => {
    raw.prepare("INSERT INTO woms (code, description, status) VALUES (?, ?, 'open')").run("WOM-SHARED-1", "Shared job");
    const res = await server.call("GET", "/api/woms/WOM-SHARED-1/gl-links", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1, "only the PO with an actual GL line should show up");
    assert.equal(res.body[0].poNumber, "PO90001");
  });

  await t.test("GET /api/woms/:code/gl-links 404s for a WOM that doesn't exist", async () => {
    const res = await server.call("GET", "/api/woms/WOM-DOES-NOT-EXIST/gl-links", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  // Backs the WOM profile's Vendors & POs tab: narrows the Budget PO Tracker
  // to just the POs tagged with one WOM #, the same wom_number linkage
  // getPoGlLinksByWom uses.
  await t.test("Budget PO Tracker's list can be filtered to just one WOM's POs", async () => {
    const res = await server.call("GET", "/api/admin/pos?womNumber=WOM-SHARED-1", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3, "all 3 POs tagged WOM-SHARED-1, regardless of GL activity");
    assert.ok(res.body.every((p) => p.womNumber === "WOM-SHARED-1"));
  });
});

// A lone "-" is the RECLASS sheet's own placeholder for "blank," not a real
// job #/WOM #/object code -- confirmed directly after it caused the Linked
// Toyota PO lookup on a real reclass item to match every other PO on file
// that also happened to have no real WOM #, since both sides stored the
// exact same placeholder verbatim. This covers the fix at the one place it
// actually needs to hold: the real import, not just the helper function.
test("Reclasses import: a lone '-' normalizes to no job #/WOM # instead of being treated as a real one", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const XLSX = require("xlsx");

  const rows = [
    // Header row -- only this exact string's presence matters for detecting
    // where the line items start; every other column is read by position.
    ["Line #", "Job # (Cost Center or Business Unit)", "Object Code", "Subsidiary", "WOM #", "Amount", null,
      "Job # (Cost Center or Business Unit)", "Object Code", "Subsidiary", "WOM #", "Amount", "Vendor", "Comments", "Region"],
    // "From" side uses "-" placeholders for Job #/WOM # (the real-world gap this fixes);
    // "To" side has real values, to confirm the fix doesn't blank out a genuine one.
    [1, "-", "6000", "100", "-", 500, null, "1002", "6001", "200", "WOM-9999", 500, "Acme Plumbing", "Test row", "Midwest"],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "RECLASS");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const importRes = await server.upload("/api/admin/reclasses/batches/import", {
    userId: "ADMIN",
    fields: {},
    fileName: "reclass.xlsx",
    fileContent: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(importRes.status, 201, JSON.stringify(importRes.body));

  const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
  const item = itemsRes.body.find((i) => i.vendor === "Acme Plumbing");
  assert.ok(item, "expected the imported row to show up");
  assert.equal(item.fromJobNumber, null, "a lone '-' should not be stored as a real job #");
  assert.equal(item.fromWomNumber, null, "a lone '-' should not be stored as a real WOM #");
  assert.equal(item.toJobNumber, "1002", "a real value on the other side should still come through untouched");
  assert.equal(item.toWomNumber, "WOM-9999");
});

// The 2026-09 template revision inserted a "Period" column right after
// Region, pushing every Adjustment/Impacting/root-cause column one slot to
// the right -- confirmed against the real template Krista sent
// (2026-09_TEMPLATE_-_TMNA_Reclass_Fiscal_MONTH.xlsx). Each line names its
// own posting month (e.g. 10 for October), independent of the batch's
// import date, and the two lines below land in different fiscal years to
// prove that per-line resolution -- not a single batch-wide guess -- is
// actually happening.
test("Reclasses import: the 2026-09 template's Period column resolves each line's own fiscal period", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const XLSX = require("xlsx");

  const header = [
    "#", "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount", "To",
    "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount",
    "Vendor", "Comments", "Region", "Period",
    "Cost Center Adjustment", "Object Code Adjustment", "Subsidiary Code Adjustment", "Subledger (WOM#) Adjustment",
    "Yes (Impacting)  or No (Non Impacting)", "Automotive", "AP", "Other", "Customer", "Automotive", "AP", "Other", "Customer",
    "Process Failure", "Manual Mistake", "System Mistake", "Management Change", "Customer Change", "Comments and Path forward",
  ];
  const rows = [
    header,
    // Period 10 (October) -- only Object Code Adjustment marked (column R,
    // the one previously swapped with Subsidiary Code Adjustment).
    [1, "2092-1001", "605200", "20920000", "WOM-1", 1200, null, "2092-1002", "601000", "20920000", null, 1200,
      "Acme Plumbing", "Timekeeping error", "Midwest", 10,
      null, "x", null, null, "Yes", "x", null, null, null, null, null, null, null,
      "x", null, null, null, null, "Fixed miscoding"],
    // Period 2 (February) -- only Subsidiary Code Adjustment marked.
    [2, "2092-2001", "616100", "20920000", null, 800, null, "2092-2001", "616100", "10910000", null, 800,
      "Delta Air", "Concur reclass", "East", 2,
      null, null, "x", null, "No", null, null, null, null, null, null, null, null,
      null, "x", null, null, null, null],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "RECLASS");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const importRes = await server.upload("/api/admin/reclasses/batches/import", {
    userId: "ADMIN",
    fields: {},
    fileName: "reclass.xlsx",
    fileContent: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(importRes.status, 201, JSON.stringify(importRes.body));

  const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
  const octLine = itemsRes.body.find((i) => i.vendor === "Acme Plumbing");
  const febLine = itemsRes.body.find((i) => i.vendor === "Delta Air");
  assert.ok(octLine && febLine, "expected both imported lines to show up");

  assert.equal(octLine.fiscalPeriodNumber, 10, "line 1's own Period column (10) should drive its fiscal period, not the import date");
  assert.equal(octLine.objectCodeAdjusted, true, "Object Code Adjustment's 'x' should land on objectCodeAdjusted, not subledgerAdjusted");
  assert.equal(octLine.subledgerAdjusted, false);
  assert.equal(octLine.costCenterAdjusted, false);
  assert.equal(octLine.causedBy, "Automotive");
  assert.equal(octLine.rootCause, "Process Failure");

  assert.equal(febLine.fiscalPeriodNumber, 2, "line 2's own Period column (2) should drive its fiscal period independently of line 1's");
  assert.equal(febLine.fiscalYear, 26, "FY26 (the more recent seeded year) should win when a bare period number matches more than one year");
  assert.equal(febLine.subledgerAdjusted, true, "Subsidiary Code Adjustment's 'x' should land on subledgerAdjusted, not objectCodeAdjusted");
  assert.equal(febLine.objectCodeAdjusted, false);
  assert.equal(febLine.rootCause, "Manual Mistake");
});

// The Finance export (GET /finance-export) is meant to hand Finance exactly
// the format a territory submission already comes in -- built here from
// whatever's on the Reclass list for a region/period, rather than requiring
// someone to fill out a new file by hand. Round-tripping the export straight
// back through the real import parser is the actual correctness bar: if the
// two ever drift, this is where it shows up.
test("Reclasses finance-export: builds a 5-sheet Finance workbook that round-trips through the real import parser", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());
  const XLSX = require("xlsx");

  const REGION = "Midwest";
  const PERIOD = 8;
  const FY = 40;
  const now = new Date().toISOString();

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("FINEXP-SITE", "Finance Export Test Site", REGION);

  // Two exportable items (a real job # on the From side -- the one thing
  // the export route requires to include a line) plus one with no From job
  // #, confirming it's left out of the export rather than written as a
  // blank row that would truncate the sheet on re-import.
  function insertItem({ fromJobNumber, fromObjectCode, fromSubsidiary, fromAmount, toJobNumber, toObjectCode, toSubsidiary, toAmount, vendor, comments, causedBy, rootCause, impactsFinalInvoice }) {
    raw
      .prepare(
        `INSERT INTO reclass_items (
          from_job_number, from_object_code, from_subsidiary, from_amount,
          to_job_number, to_object_code, to_subsidiary, to_amount,
          vendor, comments, region, caused_by, root_cause, impacts_final_invoice,
          cost_center_adjusted, object_code_adjusted, subledger_adjusted, wom_adjusted,
          source, status, fiscal_period_number, fiscal_year, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 'auto_flagged', 'flagged', ?, ?, ?, ?)`
      )
      .run(
        fromJobNumber, fromObjectCode, fromSubsidiary, fromAmount,
        toJobNumber, toObjectCode, toSubsidiary, toAmount,
        vendor, comments, REGION, causedBy, rootCause, impactsFinalInvoice,
        PERIOD, FY, now, now
      );
  }

  insertItem({
    fromJobNumber: "FINEXP-SITE", fromObjectCode: "605300", fromSubsidiary: "10010010", fromAmount: 500,
    toJobNumber: "FINEXP-SITE", toObjectCode: "601000", toSubsidiary: "10010010", toAmount: 500,
    vendor: "Allegis Global Solutions", comments: "Temp labor reclass", causedBy: "Automotive", rootCause: "Process Failure", impactsFinalInvoice: "Yes",
  });
  insertItem({
    fromJobNumber: "FINEXP-SITE", fromObjectCode: "616100", fromSubsidiary: "99999999", fromAmount: 250,
    toJobNumber: "FINEXP-SITE", toObjectCode: "616100", toSubsidiary: "10910000", toAmount: 250,
    vendor: "Concur Technologies", comments: "Concur reclass", causedBy: "AP", rootCause: "Manual Mistake", impactsFinalInvoice: "No",
  });
  insertItem({
    fromJobNumber: null, fromObjectCode: "999000", fromSubsidiary: "99999999", fromAmount: 100,
    toJobNumber: null, toObjectCode: "999000", toSubsidiary: "11111111", toAmount: 100,
    vendor: "No Job Number", comments: "should be excluded", causedBy: null, rootCause: null, impactsFinalInvoice: null,
  });

  // A GL line backing the first item's From side, for the Expense Detail sheet.
  raw
    .prepare(
      `INSERT INTO gl_entries (
        period_number, fiscal_year, gl_date, document_type, document_number, business_unit,
        object_account, object_account_code, subsidiary, amount, name_alpha, created_at
      ) VALUES (?, ?, '2026-08-01', 'JE', 'DOC-1', 'FINEXP-SITE', '605300 - Gen~Sub NonRecur Lab', '605300', '10010010', 500, 'ALLEGIS GLOBAL SOLUTIONS', ?)`
    )
    .run(PERIOD, FY, now);

  await t.test("400s without region/fiscalPeriodNumber/fiscalYear", async () => {
    const res = await server.call("GET", "/api/admin/reclasses/finance-export", { userId: "ADMIN" });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can't reach the export route", async () => {
    const res = await server.call("GET", `/api/admin/reclasses/finance-export?region=${REGION}&fiscalPeriodNumber=${PERIOD}&fiscalYear=${FY}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  const token = await server.tokenFor("ADMIN");
  const exportRes = await fetch(`${server.baseUrl}/api/admin/reclasses/finance-export?region=${REGION}&fiscalPeriodNumber=${PERIOD}&fiscalYear=${FY}`, {
    headers: { "x-session-token": token },
  });
  assert.equal(exportRes.status, 200);
  const buffer = Buffer.from(await exportRes.arrayBuffer());

  const workbook = XLSX.read(buffer, { type: "buffer" });

  await t.test("the workbook has exactly the 5 real sheets, in order", () => {
    assert.deepEqual(workbook.SheetNames, ["Template", "RECLASS", "GL RECLASS - Expense Detail", "REVENUE", "EXPENSE"]);
  });

  await t.test("the RECLASS sheet's metadata block carries the title rows, metrics, % row, and category-group header", () => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["RECLASS"], { header: 1, defval: null });
    assert.equal(rows[0][1], "C&W Services");
    assert.equal(rows[1][1], "JOURNAL ENTRY  FORM - RECLASS");
    assert.equal(rows[4][1], "Region");
    assert.equal(rows[4][3], REGION);
    assert.equal(rows[8][1], "% of Reclasses for Region");
    const totalGlLineItems = db.countGlEntriesForRegionPeriod(REGION, PERIOD, FY);
    assert.equal(rows[8][3], totalGlLineItems ? 2 / totalGlLineItems : null);
    // The category-group header row sits one row above the real column
    // header row, at the exact columns the Yes/No, impacting, non-impacting,
    // root-cause, and path-forward blocks land on.
    const categoryHeaderRow = rows[9];
    assert.equal(categoryHeaderRow[16], "TYPE");
    assert.equal(categoryHeaderRow[20], "Would this have an impact on Final Invoice?");
    assert.equal(categoryHeaderRow[21], "Impacting Adjustments");
    assert.equal(categoryHeaderRow[25], "Non Impacting Adjustments");
    assert.equal(categoryHeaderRow[29], "FINAL");
    assert.equal(categoryHeaderRow[34], "FINAL ACTION TO PREVENT REOCCURANCE (if applicable)");
    assert.deepEqual(rows[10].slice(0, 2), ["#", "Job # (Cost Center or Business Unit)"]);
  });

  await t.test("the Template sheet matches the real 10-column JE-upload format", () => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["Template"], { header: 1, defval: null });
    assert.deepEqual(rows[0], [
      "Account Number", "Amount", "Account Description", "Subledger Type (if applicable)", "Subledger (if applicable)",
      "Subledger Description", "Remark (30 Characters)", "Purchase Order (if applicable)", "Purchase Order Suffix (if applicable)", "Period",
    ]);
    const allegisFrom = rows.find((r) => r[0] === "FINEXP-SITE.605300.10010010");
    assert.ok(allegisFrom, "expected the Allegis item's From leg as a dotted Account Number composite");
    assert.equal(allegisFrom[1], -500);
    assert.equal(allegisFrom[6], "Allegis Global Solutions");
    assert.equal(allegisFrom[9], PERIOD);
    const allegisTo = rows.find((r) => r[0] === "FINEXP-SITE.601000.10010010");
    assert.ok(allegisTo);
    assert.equal(allegisTo[1], 500);
  });

  await t.test("REVENUE and EXPENSE ship as blank boilerplate stub sheets", () => {
    for (const sheetName of ["REVENUE", "EXPENSE"]) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
      assert.equal(rows[0][0], "C&W Services");
      assert.equal(rows[1][0], `JOURNAL ENTRY  FORM - ${sheetName}`);
    }
  });

  await t.test("the RECLASS sheet's line items exclude the item with no From job #", () => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["RECLASS"], { header: 1, defval: null });
    const allCells = rows.flat().filter((c) => typeof c === "string");
    assert.ok(!allCells.includes("No Job Number"), "the item with no From job # should not appear anywhere in the sheet");
    assert.ok(allCells.includes("Allegis Global Solutions"));
    assert.ok(allCells.includes("Concur Technologies"));
  });

  await t.test("the GL RECLASS - Expense Detail sheet has all 32 real headers, with the unsupported ones blank", () => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets["GL RECLASS - Expense Detail"], { header: 1, defval: null });
    assert.equal(rows[0].length, 32);
    assert.deepEqual(rows[0].slice(0, 3), ["G/L Posted Code", "Period Number - General Ledger", "Fiscal Year"]);
    const dataRow = rows.find((r, i) => i > 0 && r.some((c) => c != null));
    assert.ok(dataRow, "expected the backing GL line for the Allegis item to show up");
    assert.equal(dataRow[0], null, "G/L Posted Code is never captured by this app's GL import -- should ship blank, not fabricated");
    assert.equal(dataRow[1], PERIOD);
    assert.equal(dataRow[6], "DOC-1");
  });

  await t.test("the exported file round-trips through the real RECLASS import parser", async () => {
    const importRes = await server.upload("/api/admin/reclasses/batches/import", {
      userId: "ADMIN",
      fields: {},
      fileName: "finance_export.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(importRes.status, 201, JSON.stringify(importRes.body));
    assert.equal(importRes.body.items.length, 2, "only the 2 exportable items should come back through re-import");

    const allegis = importRes.body.items.find((i) => i.vendor === "Allegis Global Solutions");
    assert.ok(allegis);
    assert.equal(allegis.fromJobNumber, "FINEXP-SITE");
    assert.equal(allegis.fromObjectCode, "605300");
    assert.equal(allegis.fromSubsidiary, "10010010");
    assert.equal(allegis.fromAmount, 500);
    assert.equal(allegis.toObjectCode, "601000");
    assert.equal(allegis.region, REGION);
    assert.equal(allegis.fiscalPeriodNumber, PERIOD);
    assert.equal(allegis.causedBy, "Automotive");
    assert.equal(allegis.rootCause, "Process Failure");
    assert.equal(allegis.objectCodeAdjusted, true);

    const concur = importRes.body.items.find((i) => i.vendor === "Concur Technologies");
    assert.ok(concur);
    assert.equal(concur.fromSubsidiary, "99999999");
    assert.equal(concur.toSubsidiary, "10910000");
    assert.equal(concur.causedBy, "AP");
    assert.equal(concur.rootCause, "Manual Mistake");
  });
});

// Part C: "we need to have a way that we verify those reclasses hit on the
// next report." findTightenedReclassPostingMatches is the tightened check
// (job # + object code + subsidiary + amount, strictly after the item's own
// fiscal period); refreshReclassVerificationTask/refreshAllReclassVerificationTasks
// is the lazy task-regeneration pair modeled on refreshPoCodingDriftTask.
// Neither one ever writes to reclass_items.status itself -- a candidate
// match only ever clears the nag task, never auto-confirms the reclass.
test("Reclasses Part C: tightened posting-match check + verification task lifecycle", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  const now = new Date().toISOString();

  await t.test("findTightenedReclassPostingMatches matches job+object+subsidiary+amount strictly after the given period", () => {
    raw
      .prepare(
        `INSERT INTO gl_entries (period_number, fiscal_year, gl_date, business_unit, object_account, object_account_code, subsidiary, amount, name_alpha, created_at)
         VALUES (?, ?, '2026-04-01', 'TIGHT-JOB', '601000 - Gen~Labor', '601000', '20920000', 750, 'Payroll Labor Distribution', ?)`
      )
      .run(4, 26, now);

    const tight = db.findTightenedReclassPostingMatches("TIGHT-JOB", "601000", "20920000", 750, 3, 26);
    assert.equal(tight.length, 1, "a later-period line matching job/object/subsidiary/amount should be a tight match");
    assert.equal(tight[0].matchType, "tight");

    const sameOrEarlier = db.findTightenedReclassPostingMatches("TIGHT-JOB", "601000", "20920000", 750, 4, 26);
    assert.equal(sameOrEarlier.length, 0, "a line in the SAME period as the cutoff should not match -- only strictly after");

    const wrongObjectCode = db.findTightenedReclassPostingMatches("TIGHT-JOB", "605000", "20920000", 750, 3, 26);
    assert.equal(wrongObjectCode.length, 0, "a mismatched object code should not tight-match, even with the right job/subsidiary/amount");
  });

  await t.test("falls back to the looser name-based match when nothing tight is found", () => {
    raw
      .prepare(
        `INSERT INTO gl_entries (period_number, fiscal_year, gl_date, business_unit, object_account, object_account_code, subsidiary, amount, name_alpha, created_at)
         VALUES (?, ?, '2026-05-01', 'LOOSE-JOB', '605250 - Gen~Sub Recur Matl', '605250', '99999999', 300, 'AER Reclass May 2026', ?)`
      )
      .run(5, 26, now);

    // Doesn't match tight (object code differs from what's asked for), but
    // does carry the "Reclass" name signal, in a period after the cutoff.
    const result = db.findTightenedReclassPostingMatches("LOOSE-JOB", "999999", null, 300, 4, 26);
    assert.equal(result.length, 1);
    assert.equal(result[0].matchType, "loose");
  });

  await t.test("refreshReclassVerificationTask creates a task for a submitted item with no match, and clears it once one appears", () => {
    const itemResult = raw
      .prepare(
        `INSERT INTO reclass_items (
          from_job_number, from_object_code, from_subsidiary, from_amount,
          to_job_number, to_object_code, to_subsidiary, to_amount,
          vendor, source, status, fiscal_period_number, fiscal_year, created_at, updated_at
        ) VALUES ('VERIFY-JOB', '605300', '10010010', 500, 'VERIFY-JOB', '601000', '10010010', 500, 'Allegis Global Solutions', 'auto_flagged', 'submitted', ?, ?, ?, ?)`
      )
      .run(6, 26, now, now);
    const itemId = Number(itemResult.lastInsertRowid);
    const sourceKey = `RECLASS-${itemId}-VERIFICATION`;

    db.refreshReclassVerificationTask(itemId);
    const openTask = db.findTaskBySourceKey(sourceKey);
    assert.ok(openTask, "a submitted item with no posting match yet should get a verification task");
    assert.equal(openTask.status, "open");
    assert.equal(openTask.category, "reclass_verification");

    // Now the correction actually posts, in a later period, matching the To side's coding.
    raw
      .prepare(
        `INSERT INTO gl_entries (period_number, fiscal_year, gl_date, business_unit, object_account, object_account_code, subsidiary, amount, name_alpha, created_at)
         VALUES (?, ?, '2026-07-01', 'VERIFY-JOB', '601000 - Gen~Labor', '601000', '10010010', 500, 'Payroll Labor Distribution', ?)`
      )
      .run(7, 26, now);

    db.refreshReclassVerificationTask(itemId);
    const clearedTask = db.findTaskBySourceKey(sourceKey);
    assert.equal(clearedTask.status, "completed", "once a candidate posting match appears, the nag task should clear");

    const itemAfter = db.findReclassItem(itemId);
    assert.equal(itemAfter.status, "submitted", "clearing the task must never itself change the item's own status -- that's still a manual call");
  });

  await t.test("a non-submitted item (flagged/reviewed/draft/confirmed_posted/dismissed) never gets a verification task", () => {
    const itemResult = raw
      .prepare(
        `INSERT INTO reclass_items (from_job_number, from_amount, vendor, source, status, fiscal_period_number, fiscal_year, created_at, updated_at)
         VALUES ('NOTSUBMITTED-JOB', 100, 'Office Depot', 'manual', 'flagged', ?, ?, ?, ?)`
      )
      .run(8, 26, now, now);
    const itemId = Number(itemResult.lastInsertRowid);
    db.refreshReclassVerificationTask(itemId);
    assert.ok(!db.findTaskBySourceKey(`RECLASS-${itemId}-VERIFICATION`));
  });

  await t.test("refreshAllReclassVerificationTasks sweeps every submitted item without needing each id passed in by hand", () => {
    const itemResult = raw
      .prepare(
        `INSERT INTO reclass_items (from_job_number, from_amount, vendor, source, status, fiscal_period_number, fiscal_year, created_at, updated_at)
         VALUES ('SWEEP-JOB', 999, 'Sweep Test Vendor', 'manual', 'submitted', ?, ?, ?, ?)`
      )
      .run(9, 26, now, now);
    const itemId = Number(itemResult.lastInsertRowid);
    db.refreshAllReclassVerificationTasks();
    assert.ok(db.findTaskBySourceKey(`RECLASS-${itemId}-VERIFICATION`), "the sweep should pick up every submitted item on its own");
  });

  await t.test("GET /items/:id/gl-links surfaces the tightened match alongside the existing looser ones", async () => {
    const itemResult = raw
      .prepare(
        `INSERT INTO reclass_items (
          from_job_number, from_object_code, from_subsidiary, from_amount,
          to_job_number, to_object_code, to_subsidiary, to_amount,
          vendor, source, status, fiscal_period_number, fiscal_year, created_at, updated_at
        ) VALUES ('GLLINKS-JOB', '605300', '10010010', 400, 'GLLINKS-JOB', '601000', '10010010', 400, 'Allegis Global Solutions', 'auto_flagged', 'submitted', ?, ?, ?, ?)`
      )
      .run(10, 26, now, now);
    const itemId = Number(itemResult.lastInsertRowid);
    raw
      .prepare(
        `INSERT INTO gl_entries (period_number, fiscal_year, gl_date, business_unit, object_account, object_account_code, subsidiary, amount, name_alpha, created_at)
         VALUES (?, ?, '2026-11-01', 'GLLINKS-JOB', '601000 - Gen~Labor', '601000', '10010010', 400, 'Payroll Labor Distribution', ?)`
      )
      .run(11, 26, now);

    const res = await server.call("GET", `/api/admin/reclasses/items/${itemId}/gl-links`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.toPostingMatchesTightened));
    assert.equal(res.body.toPostingMatchesTightened.length, 1);
    assert.equal(res.body.toPostingMatchesTightened[0].matchType, "tight");
  });
});

// A submission file from before the 2026-09 template revision has no
// Period column at all -- the import should still work, falling back to
// the batch's own import date for fiscal period the same way it always
// has, with the Adjustment columns read from their original (one column
// to the left) positions.
test("Reclasses import: an older submission file with no Period column still imports correctly", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const XLSX = require("xlsx");

  const header = [
    "#", "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount", "To",
    "Job # (Cost Center or Business Unit)", "Object Acct or Code", "Subsidiary or Cost Code", "WOM Number If Needed", "Amount",
    "Vendor", "Comments", "Region",
    "Cost Center Adjustment", "Object Code Adjustment", "Subsidiary Code Adjustment", "Subledger (WOM#) Adjustment",
    "Yes (Impacting)  or No (Non Impacting)", "Automotive", "AP", "Other", "Customer", "Automotive", "AP", "Other", "Customer",
    "Process Failure", "Manual Mistake", "System Mistake", "Management Change", "Customer Change", "Comments and Path forward",
  ];
  const rows = [
    header,
    [1, "2092-1001", "605200", "20920000", "WOM-1", 1200, null, "2092-1002", "601000", "20920000", null, 1200,
      "Acme Plumbing", "No Period column here", "Midwest",
      null, "x", null, null, "Yes", "x", null, null, null, null, null, null, null,
      "x", null, null, null, null, "Fixed miscoding"],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "RECLASS");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const importRes = await server.upload("/api/admin/reclasses/batches/import", {
    userId: "ADMIN",
    fields: {},
    fileName: "reclass.xlsx",
    fileContent: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(importRes.status, 201, JSON.stringify(importRes.body));

  const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
  const item = itemsRes.body.find((i) => i.vendor === "Acme Plumbing");
  assert.ok(item, "expected the imported row to show up");
  assert.equal(item.objectCodeAdjusted, true, "still reads from the pre-Period column position correctly");
  assert.equal(item.subledgerAdjusted, false);
  assert.ok(item.fiscalPeriodNumber != null, "falls back to the import date's own fiscal period when there's no Period column");
});

// Krista's real workflow: review every line for a region/month (approve,
// reject, or fix each one), then one button both locks the batch in and
// drops the Finance workbook.
test("Reclasses: editing a line's coding (\"submit the fix\"), rejecting one, and Accept & Export finalizing the rest", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  const REGION = "Southeast";
  const PERIOD = 6;
  const FY = 40;
  const now = new Date().toISOString();

  function insertItem(vendor) {
    raw
      .prepare(
        `INSERT INTO reclass_items (
          from_job_number, from_object_code, from_subsidiary, from_amount,
          to_job_number, to_object_code, to_subsidiary, to_amount,
          vendor, comments, region, source, status, fiscal_period_number, fiscal_year, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'flagged', ?, ?, ?, ?)`
      )
      .run("SE-SITE", "605300", "10010010", 100, "SE-SITE", "601000", "10010010", 100, vendor, "needs review", REGION, PERIOD, FY, now, now);
    return raw.prepare("SELECT last_insert_rowid() AS id").get().id;
  }

  const fixMeId = insertItem("Wrong Vendor Name");
  const rejectMeId = insertItem("Should Be Rejected");
  const approveMeId = insertItem("Approve As-Is");

  await t.test("PATCH can fix a line's coding, not just its status", async () => {
    const res = await server.call("PATCH", `/api/admin/reclasses/items/${fixMeId}`, {
      userId: "ADMIN",
      body: { fromJobNumber: "SE-SITE-FIXED", toObjectCode: "601500", vendor: "Corrected Vendor LLC", status: "reviewed" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fromJobNumber, "SE-SITE-FIXED");
    assert.equal(res.body.toObjectCode, "601500");
    assert.equal(res.body.vendor, "Corrected Vendor LLC");
    assert.equal(res.body.status, "reviewed");
    // Untouched fields survive the edit.
    assert.equal(res.body.fromSubsidiary, "10010010");
  });

  await t.test("PATCH status:dismissed removes the rejected line outright", async () => {
    const res = await server.call("PATCH", `/api/admin/reclasses/items/${rejectMeId}`, { userId: "ADMIN", body: { status: "dismissed" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    const listRes = await server.call("GET", `/api/admin/reclasses/items?region=${REGION}`, { userId: "ADMIN" });
    assert.ok(!listRes.body.find((i) => i.id === rejectMeId), "rejected item should no longer appear anywhere");
  });

  await t.test("400s without region/fiscalPeriodNumber/fiscalYear", async () => {
    const res = await server.call("POST", "/api/admin/reclasses/accept-export", { userId: "ADMIN", body: {} });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can't reach accept-export", async () => {
    const res = await server.call("POST", "/api/admin/reclasses/accept-export", {
      userId: "T1001",
      body: { region: REGION, fiscalPeriodNumber: PERIOD, fiscalYear: FY },
    });
    assert.equal(res.status, 403);
  });

  const token = await server.tokenFor("ADMIN");
  const acceptRes = await fetch(`${server.baseUrl}/api/admin/reclasses/accept-export`, {
    method: "POST",
    headers: { "x-session-token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ region: REGION, fiscalPeriodNumber: PERIOD, fiscalYear: FY }),
  });
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const buffer = Buffer.from(await acceptRes.arrayBuffer());
  const XLSX = require("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["Template", "RECLASS", "GL RECLASS - Expense Detail", "REVENUE", "EXPENSE"]);
  const templateRows = XLSX.utils.sheet_to_json(workbook.Sheets["Template"], { header: 1, defval: null });
  assert.ok(
    templateRows.some((r) => r[0] === "SE-SITE-FIXED.605300.10010010"),
    "the fixed coding, not the original, should be what gets exported"
  );

  await t.test("both remaining open items moved to Submitted, the dismissed one stays gone", async () => {
    const listRes = await server.call("GET", `/api/admin/reclasses/items?region=${REGION}`, { userId: "ADMIN" });
    const fixed = listRes.body.find((i) => i.id === fixMeId);
    const approved = listRes.body.find((i) => i.id === approveMeId);
    assert.equal(fixed.status, "submitted");
    assert.ok(fixed.submittedAt);
    assert.equal(approved.status, "submitted");
    assert.ok(!listRes.body.find((i) => i.id === rejectMeId));
  });

  await t.test("accept-export on a region/period with nothing open is a no-op, not an error", async () => {
    const res = await server.call("POST", "/api/admin/reclasses/accept-export", {
      userId: "ADMIN",
      body: { region: REGION, fiscalPeriodNumber: PERIOD, fiscalYear: FY },
    });
    assert.equal(res.status, 200);
  });
});
