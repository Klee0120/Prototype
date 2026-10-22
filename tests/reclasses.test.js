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
