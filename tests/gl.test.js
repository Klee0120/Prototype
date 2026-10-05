const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// GL Reconciliation used to pull every GL line ever imported on every page
// load, compute mismatch flags by scanning every matched line in JS, and
// ship everything to the browser before paginating client-side -- see
// server/data/db.js's getGlReconciliationSummary/getReconciledPage/etc for
// the server-side-paginated replacement. subsidiary_mismatch/
// object_code_mismatch on gl_entries are precomputed at import time
// specifically so filtering/pagination can stay plain, indexed SQL.
test("GL Reconciliation: precomputed mismatch flags + server-side pagination", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, poAmount, subsidiary, objectCode, status, locationCode }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, po_amount, subsidiary, object_code, status, location_code,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, poAmount, subsidiary, objectCode, status, locationCode ?? null, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("importGlEntries computes subsidiary/object-code mismatch flags per matched line", () => {
    const poId = insertPo({
      composite: "gl-1",
      poNumber: "PO80001",
      poAmount: 1000,
      subsidiary: "100 Primary",
      objectCode: "605200 Subcontracting",
      status: "Open",
      locationCode: "LOC1",
    });
    db.importGlEntries(
      [
        { glDate: "2026-07-01", businessUnit: "BU1", objectAccount: "605200", subsidiary: "100", amount: 500, purchaseOrder: "PO80001" },
        { glDate: "2026-07-02", businessUnit: "BU1", objectAccount: "605300", subsidiary: "200", amount: 500, purchaseOrder: "PO80001" },
      ],
      7,
      26,
      "ADMIN",
      "test.xlsx"
    );

    const mismatchLine = raw
      .prepare("SELECT subsidiary_mismatch, object_code_mismatch FROM gl_entries WHERE matched_po_id = ? AND subsidiary = '200'")
      .get(poId);
    assert.equal(mismatchLine.subsidiary_mismatch, 1);
    assert.equal(mismatchLine.object_code_mismatch, 1);

    const matchLine = raw.prepare("SELECT subsidiary_mismatch, object_code_mismatch FROM gl_entries WHERE matched_po_id = ? AND subsidiary = '100'").get(poId);
    assert.equal(matchLine.subsidiary_mismatch, 0);
    assert.equal(matchLine.object_code_mismatch, 0);
  });

  await t.test("GET /reconciliation/summary aggregates counts and totals", async () => {
    const res = await server.call("GET", "/api/admin/gl/reconciliation/summary", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.reconciledCount >= 1);
    assert.ok(res.body.subsidiaryMismatchCount >= 1);
    assert.ok(res.body.objectCodeMismatchCount >= 1);
  });

  await t.test("GET /reconciliation/reconciled filters: status bucket, above-PO, missing location", async () => {
    const openId = insertPo({ composite: "gl-open", poNumber: "PO80010", poAmount: 100, subsidiary: "100 Primary", objectCode: "605200 X", status: "Open", locationCode: "LOC1" });
    const closedId = insertPo({
      composite: "gl-closed",
      poNumber: "PO80011",
      poAmount: 100,
      subsidiary: "100 Primary",
      objectCode: "605200 X",
      status: "Fully invoiced, JDE PO Closed",
      locationCode: "LOC1",
    });
    const noLocId = insertPo({ composite: "gl-noloc", poNumber: "PO80012", poAmount: 100, subsidiary: "100 Primary", objectCode: "605200 X", status: "Open", locationCode: null });

    db.importGlEntries(
      [
        { glDate: "2026-08-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 100, purchaseOrder: "PO80010" },
        { glDate: "2026-08-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 100, purchaseOrder: "PO80011" },
        { glDate: "2026-08-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 150, purchaseOrder: "PO80012" },
      ],
      8,
      26,
      "ADMIN",
      "test2.xlsx"
    );

    const openRes = await server.call("GET", "/api/admin/gl/reconciliation/reconciled?status=open&pageSize=500", { userId: "ADMIN" });
    assert.ok(openRes.body.items.some((i) => i.poId === openId));
    assert.ok(!openRes.body.items.some((i) => i.poId === closedId));

    const closedRes = await server.call("GET", "/api/admin/gl/reconciliation/reconciled?status=closed&pageSize=500", { userId: "ADMIN" });
    assert.ok(closedRes.body.items.some((i) => i.poId === closedId));
    assert.ok(!closedRes.body.items.some((i) => i.poId === openId));

    const aboveRes = await server.call("GET", "/api/admin/gl/reconciliation/reconciled?aboveOnly=true&pageSize=500", { userId: "ADMIN" });
    assert.ok(aboveRes.body.items.some((i) => i.poId === noLocId));
    assert.ok(!aboveRes.body.items.some((i) => i.poId === openId));

    const missingLocRes = await server.call("GET", "/api/admin/gl/reconciliation/reconciled?missingLocationOnly=true&pageSize=500", { userId: "ADMIN" });
    assert.ok(missingLocRes.body.items.some((i) => i.poId === noLocId));
    assert.ok(!missingLocRes.body.items.some((i) => i.poId === openId));
  });

  await t.test("GET /reconciliation/reconciled coding filter uses the precomputed mismatch flags", async () => {
    const res = await server.call(
      "GET",
      "/api/admin/gl/reconciliation/reconciled?coding=subsidiary&pageSize=500",
      { userId: "ADMIN" }
    );
    assert.ok(res.body.items.every((i) => i.subsidiaryMismatch === true));
    assert.ok(res.body.items.some((i) => i.poNumber === "PO80001"));
  });

  await t.test("GET /reconciliation/reconciled paginates with a correct total count", async () => {
    for (let i = 0; i < 5; i++) {
      insertPo({ composite: `gl-page-${i}`, poNumber: `PO801${20 + i}`, poAmount: 10, subsidiary: "100 Primary", objectCode: "605200 X", status: "Open", locationCode: "LOC1" });
      db.importGlEntries(
        [{ glDate: "2026-09-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 10, purchaseOrder: `PO801${20 + i}` }],
        9,
        26 + i,
        "ADMIN",
        `t${i}.xlsx`
      );
    }
    const page1 = await server.call("GET", "/api/admin/gl/reconciliation/reconciled?page=1&pageSize=2", { userId: "ADMIN" });
    assert.equal(page1.body.items.length, 2);
    assert.equal(page1.body.page, 1);
    assert.equal(page1.body.pageSize, 2);
    assert.ok(page1.body.total >= 7);

    const summaryRes = await server.call("GET", "/api/admin/gl/reconciliation/summary", { userId: "ADMIN" });
    assert.equal(summaryRes.body.reconciledCount, page1.body.total, "the summary's count and the paginated list's total should agree");
  });

  await t.test("GET /reconciliation/unmatched and /no-po-reference paginate correctly", async () => {
    db.importGlEntries(
      [
        { glDate: "2026-10-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 10, purchaseOrder: "PONOTFOUND1" },
        { glDate: "2026-10-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 20, purchaseOrder: null },
      ],
      10,
      26,
      "ADMIN",
      "t-unmatched.xlsx"
    );

    const unmatchedRes = await server.call("GET", "/api/admin/gl/reconciliation/unmatched?page=1&pageSize=50", { userId: "ADMIN" });
    assert.ok(unmatchedRes.body.items.some((e) => e.purchaseOrder === "PONOTFOUND1"));
    assert.equal(unmatchedRes.body.page, 1);

    const noPoRefRes = await server.call("GET", "/api/admin/gl/reconciliation/no-po-reference?page=1&pageSize=50", { userId: "ADMIN" });
    assert.ok(noPoRefRes.body.items.some((e) => e.amount === 20));
  });

  await t.test("refreshGlMismatchFlagsForPo updates already-matched lines when the PO's own coding is corrected later", () => {
    const poId = insertPo({ composite: "gl-refresh", poNumber: "PO80099", poAmount: 50, subsidiary: "100 Primary", objectCode: "605200 X", status: "Open", locationCode: "LOC1" });
    db.importGlEntries([{ glDate: "2026-11-01", businessUnit: "BU", objectAccount: "605200", subsidiary: "100", amount: 50, purchaseOrder: "PO80099" }], 11, 26, "ADMIN", "t-refresh.xlsx");

    let line = raw.prepare("SELECT subsidiary_mismatch FROM gl_entries WHERE matched_po_id = ?").get(poId);
    assert.equal(line.subsidiary_mismatch, 0);

    raw.prepare("UPDATE pos SET subsidiary = ? WHERE id = ?").run("999 Changed", poId);
    db.refreshGlMismatchFlagsForPo(poId);

    line = raw.prepare("SELECT subsidiary_mismatch FROM gl_entries WHERE matched_po_id = ?").get(poId);
    assert.equal(line.subsidiary_mismatch, 1, "should now mismatch since the PO's subsidiary changed without a GL re-import");
  });

  raw.close();
});

// Spend Breakdown: every imported GL line (not just AP vendor invoices --
// health insurance posts from payroll, with no PO at all) grouped by its
// own chart-of-accounts category and, separately, by territory (resolved
// from the raw Location Code column's facility-name portion against a real
// location -- see extractGlLocationName/matchLocationCodeByName).
test("GL Spend Breakdown: category + territory grouping", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");

  const SPEND_PERIOD = { periodNumber: 9, fiscalYear: 26 };

  await t.test("groups by chart-of-accounts category, with an Unknown bucket for unparseable Object Account", () => {
    db.importGlEntries(
      [
        // PRINCETON's real name ("TLS Princeton") -- matches by name, not code.
        { glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 100, locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-09-01", objectAccount: "647200 - Gen FM~Cell Phone", amount: 50, locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-09-01", objectAccount: "602210 - Gen B&A~H&W Insurance", amount: 200, locationCode: "20001805 - TLS Princeton" },
        // No "~" at all -- can't be parsed into a category.
        { glDate: "2026-09-01", objectAccount: "605200", amount: 75, locationCode: "20001805 - TLS Princeton" },
        // Location name matches nothing on file.
        { glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 10, locationCode: "99999999 - Nowhere Facility" },
      ],
      SPEND_PERIOD.periodNumber,
      SPEND_PERIOD.fiscalYear,
      "ADMIN",
      "t-spend.xlsx"
    );

    const res = { body: db.getGlSpendBreakdown(SPEND_PERIOD) };
    const cellPhone = res.body.categories.find((c) => c.category === "Cell Phone");
    assert.ok(cellPhone, "expected a Cell Phone category");
    assert.equal(cellPhone.total, 160, "100 + 50 + 10 across both locations");
    assert.equal(cellPhone.count, 3);

    const insurance = res.body.categories.find((c) => c.category === "H&W Insurance");
    assert.equal(insurance.total, 200);

    const unknown = res.body.categories.find((c) => c.category === "Unknown / Uncategorized");
    assert.ok(unknown, "a line with no '~' in Object Account should fall into Unknown / Uncategorized");
    assert.equal(unknown.total, 75);
  });

  await t.test("groups by territory via the Location Code's facility name, with Unassigned for no match", async () => {
    const res = await server.call("GET", `/api/admin/gl/spend-breakdown?periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}`, {
      userId: "ADMIN",
    });
    assert.equal(res.status, 200);
    const midwest = res.body.territories.find((t2) => t2.territory === "Midwest");
    assert.ok(midwest, "TLS Princeton should resolve to the Midwest territory");
    assert.equal(midwest.total, 100 + 50 + 200 + 75);

    const unassigned = res.body.territories.find((t2) => t2.territory === "Unassigned");
    assert.ok(unassigned, "the unmatched 'Nowhere Facility' location should fall under Unassigned");
    assert.equal(unassigned.total, 10);
    assert.ok(res.body.unassignedLocationCount >= 1);
  });

  await t.test("a territory filter scopes both the totals and entry count to just that territory", async () => {
    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?territory=Midwest&periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.territories.length, 1);
    assert.equal(res.body.territories[0].territory, "Midwest");
    assert.equal(res.body.totalAmount, 100 + 50 + 200 + 75);
  });

  await t.test("a technician can't reach the Spend Breakdown route", async () => {
    const res = await server.call("GET", "/api/admin/gl/spend-breakdown", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("defaults to no-PO-reference lines only, excluding a line with a Purchase Order on it", () => {
    const PO_PERIOD = { periodNumber: 12, fiscalYear: 26 };
    db.importGlEntries(
      [
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 300, locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 500, locationCode: "20001805 - TLS Princeton", purchaseOrder: "PO-1234" },
      ],
      PO_PERIOD.periodNumber,
      PO_PERIOD.fiscalYear,
      "ADMIN",
      "t-spend-po.xlsx"
    );

    const scoped = db.getGlSpendBreakdown(PO_PERIOD);
    const scopedCellPhone = scoped.categories.find((c) => c.category === "Cell Phone");
    assert.equal(scopedCellPhone.total, 300, "the PO-referenced line should be excluded by default");

    const full = db.getGlSpendBreakdown({ ...PO_PERIOD, noPoReferenceOnly: false });
    const fullCellPhone = full.categories.find((c) => c.category === "Cell Phone");
    assert.equal(fullCellPhone.total, 800, "noPoReferenceOnly: false should include every line");
  });

  await t.test("the route's noPoReferenceOnly query param matches the db-level default and override", async () => {
    const PO_PERIOD = { periodNumber: 13, fiscalYear: 26 };
    db.importGlEntries(
      [
        { glDate: "2026-11-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 40, locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-11-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 60, locationCode: "20001805 - TLS Princeton", purchaseOrder: "PO-9999" },
      ],
      PO_PERIOD.periodNumber,
      PO_PERIOD.fiscalYear,
      "ADMIN",
      "t-spend-po-route.xlsx"
    );

    const defaultRes = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?periodNumber=${PO_PERIOD.periodNumber}&fiscalYear=${PO_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(defaultRes.body.categories.find((c) => c.category === "Cell Phone").total, 40);

    const fullRes = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?periodNumber=${PO_PERIOD.periodNumber}&fiscalYear=${PO_PERIOD.fiscalYear}&noPoReferenceOnly=false`,
      { userId: "ADMIN" }
    );
    assert.equal(fullRes.body.categories.find((c) => c.category === "Cell Phone").total, 100);
  });
});

// A GL line's "Business Unit" is the same JDE job number the COA import
// already puts on locations.ef_job_number/pps_job_number/wom_job_number --
// a precise match, unlike the raw "Location Code" column's facility name,
// which this app can only match tolerantly (see matchLocationCodeByName)
// and which real production data shows often doesn't match at all. Business
// Unit is tried first; the name match is only a fallback for a business
// unit not on file under any of the three job-number columns.
test("GL location matching: Business Unit job number takes priority over the Location Code name match", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  // A real location whose own name wouldn't match the GL Location Code's
  // facility name at all, but whose E&F job number does match the GL
  // line's Business Unit exactly.
  raw
    .prepare("INSERT INTO locations (code, name, ef_job_number, territory) VALUES (?, ?, ?, ?)")
    .run("JOBNUM-LOC", "Totally Different Facility Name", "100110999999", "East");

  await t.test("resolves via Business Unit even when the Location Code's name matches nothing", () => {
    db.importGlEntries(
      [
        {
          glDate: "2026-09-01",
          objectAccount: "647200 - Gen B&A~Cell Phone",
          amount: 123,
          businessUnit: "100110999999",
          locationCode: "99999999 - Nothing Like That Name",
        },
      ],
      14,
      26,
      "ADMIN",
      "t-bu-match.xlsx"
    );

    const line = raw.prepare("SELECT matched_location_code, matched_location_source FROM gl_entries WHERE business_unit = ?").get("100110999999");
    assert.equal(line.matched_location_code, "JOBNUM-LOC");
    assert.equal(line.matched_location_source, "business_unit");

    const result = db.getGlSpendBreakdown({ periodNumber: 14, fiscalYear: 26 });
    const east = result.territories.find((t2) => t2.territory === "East");
    assert.ok(east, "should resolve to East via the Business Unit match, not fall through to Unassigned");
    assert.equal(east.total, 123);
  });

  await t.test("falls back to the name match when Business Unit isn't on file under any job-number column", () => {
    db.importGlEntries(
      [
        {
          glDate: "2026-09-01",
          objectAccount: "647200 - Gen B&A~Cell Phone",
          amount: 50,
          businessUnit: "100110000000",
          locationCode: "20001805 - Totally Different Facility Name",
        },
      ],
      15,
      26,
      "ADMIN",
      "t-name-fallback.xlsx"
    );

    const line = raw.prepare("SELECT matched_location_code, matched_location_source FROM gl_entries WHERE business_unit = ?").get("100110000000");
    assert.equal(line.matched_location_code, "JOBNUM-LOC");
    assert.equal(line.matched_location_source, "name");
  });
});

// A line coded straight to a WOM project (Subledger - G/L set, see
// subledgerGl) never has a PO either -- a different reason for having no PO
// than payroll burden or an accrual, and already tracked through the WOM
// feature, so it's excluded by default here too, same shape as the
// PO-reference toggle. periodFrom/periodTo narrow a fiscal year to a
// month range ("fiscal month to fiscal month") without pinning to one
// exact period. getGlSpendDetailPage is the GL-line drill-down behind a
// clicked category/territory row.
test("GL Spend Breakdown: WOM-reference scoping, fiscal-month range, and GL-line drill-down", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");

  await t.test("defaults to no-WOM-reference lines only, excluding a line with a Subledger - G/L set", () => {
    const PERIOD = { periodNumber: 16, fiscalYear: 26 };
    db.importGlEntries(
      [
        { glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 100 },
        { glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 200, subledgerGl: "19337866" },
      ],
      PERIOD.periodNumber,
      PERIOD.fiscalYear,
      "ADMIN",
      "t-wom.xlsx"
    );

    const scoped = db.getGlSpendBreakdown(PERIOD);
    assert.equal(scoped.categories.find((c) => c.category === "Cell Phone").total, 100, "the WOM-referenced line should be excluded by default");

    const full = db.getGlSpendBreakdown({ ...PERIOD, noWomReferenceOnly: false });
    assert.equal(full.categories.find((c) => c.category === "Cell Phone").total, 300, "noWomReferenceOnly: false should include every line");
  });

  await t.test("periodFrom/periodTo narrows a fiscal year to a fiscal-month range", () => {
    db.importGlEntries([{ glDate: "2027-01-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 10 }], 1, 27, "ADMIN", "fy27-p1.xlsx");
    db.importGlEntries([{ glDate: "2027-02-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 20 }], 2, 27, "ADMIN", "fy27-p2.xlsx");
    db.importGlEntries([{ glDate: "2027-03-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 40 }], 3, 27, "ADMIN", "fy27-p3.xlsx");

    const wholeYear = db.getGlSpendBreakdown({ fiscalYear: 27 });
    assert.equal(wholeYear.totalAmount, 70, "fiscalYear alone combines every period in that year");

    const narrowed = db.getGlSpendBreakdown({ fiscalYear: 27, periodFrom: 1, periodTo: 2 });
    assert.equal(narrowed.totalAmount, 30, "periodFrom/periodTo should exclude period 3");
  });

  await t.test("getGlSpendDetailPage returns the actual GL lines behind a category, paginated, newest first", async () => {
    const PERIOD = { periodNumber: 17, fiscalYear: 26 };
    db.importGlEntries(
      [
        { glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 10, nameAlpha: "VERIZON" },
        { glDate: "2026-09-02", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 20, nameAlpha: "ATT" },
        { glDate: "2026-09-03", objectAccount: "602210 - Gen B&A~H&W Insurance", amount: 999 },
      ],
      PERIOD.periodNumber,
      PERIOD.fiscalYear,
      "ADMIN",
      "t-detail.xlsx"
    );

    const page1 = db.getGlSpendDetailPage({ category: "Cell Phone", ...PERIOD, pageSize: 1, page: 1 });
    assert.equal(page1.total, 2, "only the two Cell Phone lines, not the H&W Insurance one");
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0].vendorOrDescription, "ATT", "newest GL date first");

    const page2 = db.getGlSpendDetailPage({ category: "Cell Phone", ...PERIOD, pageSize: 1, page: 2 });
    assert.equal(page2.items[0].vendorOrDescription, "VERIZON");

    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?${new URLSearchParams({ category: "Cell Phone", periodNumber: String(PERIOD.periodNumber), fiscalYear: String(PERIOD.fiscalYear) })}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
  });

  await t.test("a technician can't reach the Spend Breakdown detail route", async () => {
    const res = await server.call("GET", "/api/admin/gl/spend-breakdown/detail", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("fiscal-calendar route returns that fiscal year's own period/month list", async () => {
    const res = await server.call("GET", "/api/admin/gl/fiscal-calendar?fiscalYear=26", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((p) => p.periodNumber === 9 && p.monthName === "September"));
    assert.equal(res.body.length, 12);
  });

  await t.test("fiscal-calendar route includes fiscal month end and WOM close date for the Timekeeping reference view", async () => {
    const res = await server.call("GET", "/api/admin/gl/fiscal-calendar?fiscalYear=26", { userId: "ADMIN" });
    const september = res.body.find((p) => p.periodNumber === 9);
    assert.equal(september.fiscalMonthEnd, "2026-09-13");
    assert.equal(september.womCloseDate, "2026-09-21");
  });

  await t.test("fiscal-calendar-years route lists every fiscal year the close calendar covers", async () => {
    const res = await server.call("GET", "/api/admin/gl/fiscal-calendar-years", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [26, 25]);
  });

  await t.test("a technician can't reach the fiscal-calendar-years route", async () => {
    const res = await server.call("GET", "/api/admin/gl/fiscal-calendar-years", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});

// Spend Analysis's "Include current estimated PO" checkbox: an Active PO's
// own amount minus whatever's already matched to it in the GL, layered on
// top of GL actuals -- never the same dollar counted twice. See
// db.getPoRemainingAmounts/resolveCategoryForObjectCode.
test("GL Spend Breakdown: including the PO Tracker's remaining (not-yet-posted) PO amounts", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  raw.prepare(`INSERT OR IGNORE INTO locations (code, name, territory) VALUES ('PORMT-A', 'PO Remaining Test Site A', 'Midwest')`).run();

  function insertPo({ composite, poNumber, poAmount, objectCode, locationCode, lifecycleStatus }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, po_amount, object_code, location_code, lifecycle_status,
         first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(composite, poNumber, poAmount, objectCode || null, locationCode, lifecycleStatus || "active", now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  // A real GL line with this object code, so resolveCategoryForObjectCode
  // has a category name to resolve "647200" to. Period 15/FY26 and the
  // "Midwest"-territory scoping below are both deliberate: this file's
  // other test blocks leave their own POs/GL entries behind in this same
  // shared DB (no cross-test cleanup), so an unused period plus a
  // territory filter keeps this block's counts from picking any of that up.
  db.importGlEntries(
    [{ glDate: "2026-09-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 40, businessUnit: "PORMT-NOPE" }],
    15,
    26,
    "ADMIN",
    "t-po-remaining-seed.xlsx"
  );

  await t.test("a PO with no GL activity contributes its full amount", () => {
    const poId = insertPo({ composite: "pr-1", poNumber: "PO95001", poAmount: 500, objectCode: "647200", locationCode: "PORMT-A" });

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest", includePoRemaining: true });
    const cellPhone = breakdown.categories.find((c) => c.category === "Cell Phone");
    assert.ok(cellPhone, "expected the PO's object code to resolve to the Cell Phone category via the seeded GL line");
    assert.ok(cellPhone.total >= 500, "the PO's full $500 should be included since nothing's posted against it yet");

    const midwest = breakdown.territories.find((t2) => t2.territory === "Midwest");
    assert.ok(midwest.total >= 500);
    assert.equal(breakdown.poRemainingCount, 1);
    assert.equal(breakdown.poRemainingTotal, 500);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
  });

  await t.test("a partially-invoiced PO only contributes its remaining exposure, never the full amount twice", () => {
    const poId = insertPo({ composite: "pr-2", poNumber: "PO95002", poAmount: 1000, objectCode: "647200", locationCode: "PORMT-A" });
    db.importGlEntries(
      [{ glDate: "2026-09-02", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 300, businessUnit: "PORMT-NOPE", purchaseOrder: "PO95002" }],
      15,
      26,
      "ADMIN",
      "t-po-remaining-seed2.xlsx"
    );
    raw.prepare("UPDATE gl_entries SET matched_po_id = ? WHERE purchase_order = 'PO95002'").run(poId);

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest", includePoRemaining: true });
    assert.equal(breakdown.poRemainingTotal, 700, "1000 - 300 already matched = 700 remaining");

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
    raw.prepare("DELETE FROM gl_entries WHERE purchase_order = 'PO95002'").run();
  });

  await t.test("a fully-invoiced PO (remaining <= 0) contributes nothing", () => {
    const poId = insertPo({ composite: "pr-3", poNumber: "PO95003", poAmount: 200, objectCode: "647200", locationCode: "PORMT-A" });
    db.importGlEntries(
      [{ glDate: "2026-09-03", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 250, businessUnit: "PORMT-NOPE", purchaseOrder: "PO95003" }],
      15,
      26,
      "ADMIN",
      "t-po-remaining-seed3.xlsx"
    );
    raw.prepare("UPDATE gl_entries SET matched_po_id = ? WHERE purchase_order = 'PO95003'").run(poId);

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest", includePoRemaining: true });
    assert.equal(breakdown.poRemainingCount, 0, "fully (over-)invoiced PO should not appear");

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
    raw.prepare("DELETE FROM gl_entries WHERE purchase_order = 'PO95003'").run();
  });

  await t.test("a needs_organization PO is never included, even with a dollar amount on file", () => {
    const poId = insertPo({ composite: "pr-4", poNumber: "PO95004", poAmount: 999, objectCode: "647200", locationCode: "PORMT-A", lifecycleStatus: "needs_organization" });

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest", includePoRemaining: true });
    assert.equal(breakdown.poRemainingCount, 0);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
  });

  await t.test("defaults to excluding PO Tracker amounts when includePoRemaining isn't set", () => {
    insertPo({ composite: "pr-5", poNumber: "PO95005", poAmount: 500, objectCode: "647200", locationCode: "PORMT-A" });

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest" });
    assert.equal(breakdown.poRemainingTotal, 0);
    assert.equal(breakdown.poRemainingCount, 0);

    raw.prepare("DELETE FROM pos WHERE po_number = 'PO95005'").run();
  });

  await t.test("an object code with no matching GL history falls into Unknown / Uncategorized", () => {
    const poId = insertPo({ composite: "pr-6", poNumber: "PO95006", poAmount: 150, objectCode: "999999999", locationCode: "PORMT-A" });

    const breakdown = db.getGlSpendBreakdown({ periodNumber: 15, fiscalYear: 26, territory: "Midwest", includePoRemaining: true });
    const unknown = breakdown.categories.find((c) => c.category === "Unknown / Uncategorized");
    assert.ok(unknown.total >= 150);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
  });

  await t.test("the spend-breakdown route passes includePoRemaining through from the query string", async () => {
    const poId = insertPo({ composite: "pr-7", poNumber: "PO95007", poAmount: 650, objectCode: "647200", locationCode: "PORMT-A" });

    const off = await server.call("GET", "/api/admin/gl/spend-breakdown?periodNumber=15&fiscalYear=26&territory=Midwest", { userId: "ADMIN" });
    assert.equal(off.body.poRemainingCount, 0);

    const on = await server.call("GET", "/api/admin/gl/spend-breakdown?periodNumber=15&fiscalYear=26&territory=Midwest&includePoRemaining=true", { userId: "ADMIN" });
    assert.equal(on.body.poRemainingCount, 1);
    assert.equal(on.body.poRemainingTotal, 650);

    raw.prepare("DELETE FROM pos WHERE id = ?").run(poId);
  });

  raw.close();
});
