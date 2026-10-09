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

  await t.test("GET /reconciliation/unmatched paginates correctly", async () => {
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

  await t.test("groups by location too, with Unassigned for no match -- a location drill-down scopes to just that location's lines", async () => {
    const res = await server.call("GET", `/api/admin/gl/spend-breakdown?periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}`, {
      userId: "ADMIN",
    });
    const princeton = res.body.locations.find((l) => l.locationCode === "PRINCETON");
    assert.ok(princeton, "TLS Princeton's own location code should show up as a location row");
    assert.equal(princeton.locationName, "TLS Princeton");
    assert.equal(princeton.total, 100 + 50 + 200 + 75);

    const unassigned = res.body.locations.find((l) => l.locationCode === null);
    assert.ok(unassigned, "the unmatched 'Nowhere Facility' location should fall under Unassigned");
    assert.equal(unassigned.total, 10);

    const detail = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?location=PRINCETON&periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}&pageSize=50`,
      { userId: "ADMIN" }
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.total, 4, "all 4 Princeton lines, not the Nowhere Facility one");
    // item.locationCode is the raw GL Location Code text (location_code),
    // not the resolved code the `location` filter itself matches against
    // (matched_location_code) -- same distinction getGlSpendBreakdown's own
    // territory grouping already relies on.
    assert.ok(detail.body.items.every((it) => it.locationCode.includes("TLS Princeton")));
  });

  await t.test("spend-breakdown's own location param scopes the chart/category totals, but the location list itself stays complete", async () => {
    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?location=PRINCETON&periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAmount, 100 + 50 + 200 + 75, "the Nowhere Facility's 10 should be excluded from the scoped total");
    assert.equal(res.body.entryCount, 4);
    const insurance = res.body.categories.find((c) => c.category === "H&W Insurance");
    assert.equal(insurance.total, 200, "category totals scope to the selected location too");
    assert.equal(
      res.body.categories.find((c) => c.category === "Cell Phone").total,
      150,
      "Cell Phone scoped to Princeton only (100 + 50), not the Nowhere Facility's 10"
    );

    // The location LIST itself is unaffected by its own filter -- it still
    // offers every location (including Nowhere Facility/Unassigned) so the
    // location button bar can switch to a different one, not just clear.
    assert.equal(res.body.locations.length, 2);
    assert.ok(res.body.locations.find((l) => l.locationCode === null));
  });

  await t.test("excludeBurden drops H&W Insurance/FICA/Medi/Gen Liability from totals, categories, and the detail drill-down", async () => {
    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?excludeBurden=true&periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.body.categories.find((c) => c.category === "H&W Insurance"),
      undefined,
      "the burden category should be dropped entirely, not just zeroed out"
    );
    assert.equal(res.body.totalAmount, 100 + 50 + 75 + 10, "the 200 of H&W Insurance should no longer be counted");

    const detail = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?excludeBurden=true&periodNumber=${SPEND_PERIOD.periodNumber}&fiscalYear=${SPEND_PERIOD.fiscalYear}&pageSize=50`,
      { userId: "ADMIN" }
    );
    assert.ok(
      detail.body.items.every((it) => it.objectAccount !== "602210 - Gen B&A~H&W Insurance"),
      "the H&W Insurance line shouldn't appear in the drill-down either"
    );
  });

  await t.test("excludeBurden also catches a burden line by its Vendor/Description text, even under an unrelated category", async () => {
    const BURDEN_DESC_PERIOD = { periodNumber: 3, fiscalYear: 27 };
    db.importGlEntries(
      [
        // "Material Use" isn't a burden category on its own -- only the
        // Vendor/Description text marks this one as burden.
        {
          glDate: "2026-03-01",
          objectAccount: "605400 - Gen FM~Material Use",
          amount: 900,
          nameAlpha: "Actual Burden Journal Entries",
        },
        { glDate: "2026-03-01", objectAccount: "605400 - Gen FM~Material Use", amount: 100, nameAlpha: "Regular Vendor Invoice" },
      ],
      BURDEN_DESC_PERIOD.periodNumber,
      BURDEN_DESC_PERIOD.fiscalYear,
      "ADMIN",
      "t-spend-burden-desc.xlsx"
    );

    const withBurden = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?periodNumber=${BURDEN_DESC_PERIOD.periodNumber}&fiscalYear=${BURDEN_DESC_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(withBurden.body.totalAmount, 900 + 100);

    const excluded = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown?excludeBurden=true&periodNumber=${BURDEN_DESC_PERIOD.periodNumber}&fiscalYear=${BURDEN_DESC_PERIOD.fiscalYear}`,
      { userId: "ADMIN" }
    );
    assert.equal(excluded.body.totalAmount, 100, "the 900 Actual Burden Journal Entries line should be dropped, the regular 100 kept");

    const detail = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?excludeBurden=true&periodNumber=${BURDEN_DESC_PERIOD.periodNumber}&fiscalYear=${BURDEN_DESC_PERIOD.fiscalYear}&pageSize=50`,
      { userId: "ADMIN" }
    );
    assert.ok(detail.body.items.every((it) => it.vendorOrDescription !== "Actual Burden Journal Entries"));
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

// "GL lines with a PO # not on file" export -- one row per distinct PO #
// GL already knows about that the Budget PO Tracker doesn't, shaped to
// paste straight into the real Operations PO Request Tracking sheet (see
// MISSING_FROM_TRACKER_EXPORT_COLUMNS in server/routes/gl.js for the exact
// 25-column header order, confirmed against a real export of that sheet).
test("GL Reconciliation: export POs missing from the tracker", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw
    .prepare("INSERT INTO locations (code, name, ef_job_number, wom_job_number, territory) VALUES (?, ?, ?, ?, ?)")
    .run("MFT-1", "Mock Facility Test", "100110099000", "100110099999", "East");

  db.importGlEntries(
    [
      // E&F-coded, no WOM # -- the "no WOM # listed" case.
      {
        glDate: "2026-09-01",
        businessUnit: "100110099000",
        objectAccount: "605200 Subcontracting",
        subsidiary: "100 Primary",
        amount: 250,
        purchaseOrder: "PO90101",
        nameAlpha: "John Doe Vendor",
        remark: "Repair work",
      },
      // WOM-coded (subledgerGl set) at the same location.
      {
        glDate: "2026-09-02",
        businessUnit: "100110099000",
        objectAccount: "605300 Other Work",
        subsidiary: "200 Secondary",
        amount: 500,
        purchaseOrder: "PO90102",
        subledgerGl: "WOM-9500",
      },
      // Posted against the location's own WOM job # (Business Unit matches
      // locations.wom_job_number, not ef_job_number) but with no WOM #/
      // Subledger on the line itself -- the ambiguous case Krista asked
      // about: this is NOT an E&F-coded request.
      {
        glDate: "2026-09-03",
        businessUnit: "100110099999",
        objectAccount: "605400 WOM Work, No WOM#",
        subsidiary: "300 Tertiary",
        amount: 750,
        purchaseOrder: "PO90103",
      },
    ],
    16,
    26,
    "ADMIN",
    "t-missing-from-tracker.xlsx"
  );

  await t.test("getPosMissingFromTrackerForExport fills only what GL actually carries", () => {
    const rows = db.getPosMissingFromTrackerForExport();
    const efRow = rows.find((r) => r.poNumber === "PO90101");
    const womRow = rows.find((r) => r.poNumber === "PO90102");
    const needsWomRow = rows.find((r) => r.poNumber === "PO90103");
    assert.ok(efRow, "expected the E&F-coded unmatched PO to show up");
    assert.ok(womRow, "expected the WOM-coded unmatched PO to show up");
    assert.ok(needsWomRow, "expected the WOM-job-number-but-no-WOM# unmatched PO to show up");

    // No WOM # -> Question 1/2 use the real sheet's own E&F vocabulary,
    // and the location's own E&F job # fills E&F Contract Job #.
    assert.equal(efRow.question1, "E&F Job");
    assert.equal(efRow.question2, "-");
    assert.equal(efRow.needsWomNumberConfirmed, false);
    assert.equal(efRow.efJobNumber, "100110099000\tMock Facility Test");
    assert.equal(efRow.e1WomJobNumber, null);
    assert.equal(efRow.womNumber, null);
    assert.equal(efRow.requestor, null, "GL has no requestor field -- left blank, not guessed");
    assert.equal(efRow.vendorName, "John Doe Vendor", "name_alpha is the vendor's own name, not a requestor");
    assert.equal(efRow.description, "Repair work");
    assert.equal(efRow.dateRequested, "2026-09-01", "pre-filled with the earliest GL date as an editable placeholder");
    assert.equal(efRow.poAmount, 250);
    assert.equal(efRow.objectCode, "605200 Subcontracting");
    assert.equal(efRow.subsidiary, "100 Primary");
    assert.equal(efRow.assetNumber, null, "never fabricates Asset # from GL");
    assert.equal(efRow.maximoWo, null, "never fabricates Maximo WO# from GL");

    // WOM # present -> Question 1/2 left blank (Krista only specified the
    // no-WOM case), WOM Number filled directly, and the location's own
    // E1 WOM Job # fills that column instead of E&F Contract Job #.
    assert.equal(womRow.question1, null);
    assert.equal(womRow.question2, null);
    assert.equal(womRow.needsWomNumberConfirmed, false);
    assert.equal(womRow.efJobNumber, null);
    assert.equal(womRow.e1WomJobNumber, "100110099999");
    assert.equal(womRow.womNumber, "WOM-9500");
    assert.equal(womRow.vendorName, null, "no name_alpha on this line -- left blank, not guessed");
    assert.equal(womRow.poAmount, 500);

    // Business Unit matches the location's WOM job # (not E&F), but no
    // WOM #/Subledger on the line -- not an E&F request, flagged instead
    // of silently defaulted.
    assert.equal(needsWomRow.needsWomNumberConfirmed, true);
    assert.equal(needsWomRow.question1, "WOM is Required");
    assert.equal(needsWomRow.question2, null);
    assert.equal(needsWomRow.efJobNumber, null, "should never fall back to E&F Contract Job # for a WOM-job-number line");
    assert.equal(needsWomRow.e1WomJobNumber, "100110099999");
    assert.equal(needsWomRow.womNumber, null, "the actual WOM # is still unknown -- not guessed");
    assert.match(needsWomRow.description, /confirm the WOM #/i);
  });

  await t.test("GET /reconciliation/missing-from-tracker returns the same rows with a count", async () => {
    const res = await server.call("GET", "/api/admin/gl/reconciliation/missing-from-tracker", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.count >= 3);
    assert.ok(res.body.needsWomNumberConfirmedCount >= 1);
    assert.ok(res.body.items.some((r) => r.poNumber === "PO90101"));
    assert.ok(res.body.items.some((r) => r.poNumber === "PO90102"));
    assert.ok(res.body.items.some((r) => r.poNumber === "PO90103"));
  });

  await t.test("GET /reconciliation/missing-from-tracker/export returns a downloadable xlsx", async () => {
    const res = await server.rawGet("/api/admin/gl/reconciliation/missing-from-tracker/export", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(res.headers.get("content-disposition") || "", /attachment; filename="PO_Tracker_Missing_From_GL_.*\.xlsx"/);
    assert.ok(res.text.length > 0);
  });

  await t.test("once the PO is added to the tracker, it drops out of the export", async () => {
    raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`
      )
      .run("now-tracked", "PO90101", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    // A fresh import re-runs the PO match against the now-existing PO row.
    db.importGlEntries(
      [
        {
          glDate: "2026-09-01",
          businessUnit: "100110099000",
          objectAccount: "605200 Subcontracting",
          subsidiary: "100 Primary",
          amount: 250,
          purchaseOrder: "PO90101",
          nameAlpha: "John Doe Vendor",
          remark: "Repair work",
        },
      ],
      16,
      26,
      "ADMIN",
      "t-missing-from-tracker-2.xlsx"
    );
    const rows = db.getPosMissingFromTrackerForExport();
    assert.ok(!rows.some((r) => r.poNumber === "PO90101"), "now matched to a real PO, so it should no longer show up as missing");
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

    // Each item carries its own id + full underlying GL record (glLine), same
    // "full GL line" shape as Meals/Cell Phones, for the drill-down modal's
    // row-click popup.
    assert.ok(page1.items[0].id, "each item should carry the gl_entries row id");
    assert.equal(page1.items[0].glLine.objectAccount, "647200 - Gen B&A~Cell Phone");

    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?${new URLSearchParams({ category: "Cell Phone", periodNumber: String(PERIOD.periodNumber), fiscalYear: String(PERIOD.fiscalYear) })}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
  });

  // Searching for a specific PO # or WOM # (subledger) should find that
  // line regardless of the no-PO/no-WOM-reference defaults -- those exist
  // to hide the common case, not the one line someone's looking for.
  await t.test("getGlSpendDetailPage's search param finds a line by PO # or WOM # (subledger), ignoring the reference-exclusion defaults", async () => {
    const PERIOD = { periodNumber: 18, fiscalYear: 26 };
    db.importGlEntries(
      [
        { glDate: "2026-10-01", objectAccount: "605300 - I-Electric~Sub NonRecur Lab", amount: 500, nameAlpha: "No ref line" },
        { glDate: "2026-10-02", objectAccount: "605300 - I-Electric~Sub NonRecur Lab", amount: 600, nameAlpha: "PO line", purchaseOrder: "PO88123" },
        { glDate: "2026-10-03", objectAccount: "605300 - I-Electric~Sub NonRecur Lab", amount: 700, nameAlpha: "WOM line", subledgerGl: "W-55512" },
      ],
      PERIOD.periodNumber,
      PERIOD.fiscalYear,
      "ADMIN",
      "t-search.xlsx"
    );

    const defaultScope = db.getGlSpendDetailPage({ ...PERIOD, pageSize: 50 });
    assert.ok(
      defaultScope.items.every((it) => it.vendorOrDescription !== "PO line" && it.vendorOrDescription !== "WOM line"),
      "the default no-PO/no-WOM scope should still exclude both referenced lines"
    );

    const poSearch = db.getGlSpendDetailPage({ ...PERIOD, search: "88123" });
    assert.equal(poSearch.total, 1);
    assert.equal(poSearch.items[0].vendorOrDescription, "PO line");

    const womSearch = db.getGlSpendDetailPage({ ...PERIOD, search: "55512" });
    assert.equal(womSearch.total, 1);
    assert.equal(womSearch.items[0].vendorOrDescription, "WOM line");
    assert.equal(womSearch.items[0].glLine.subledgerGl, "W-55512");

    const res = await server.call(
      "GET",
      `/api/admin/gl/spend-breakdown/detail?${new URLSearchParams({ periodNumber: String(PERIOD.periodNumber), fiscalYear: String(PERIOD.fiscalYear), search: "88123" })}`,
      { userId: "ADMIN" }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].vendorOrDescription, "PO line");
  });

  await t.test("a technician can't reach the Spend Breakdown detail route", async () => {
    const res = await server.call("GET", "/api/admin/gl/spend-breakdown/detail", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("getCellPhoneCharges groups by phone #, formats it, and supports a territory filter", async () => {
    // A synthetic fiscal year nothing else in this file touches -- unlike
    // getGlSpendDetailPage, getCellPhoneCharges has no period-level filter
    // (it's meant to summarize a whole fiscal year of phone bills at once),
    // so the exact counts/totals below need a year no other test's Cell
    // Phone rows land in.
    const FY = 44;
    db.importGlEntries(
      [
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 39.24, nameAlpha: "CALERO SOFTWARE LLC", remark: "2059944582", locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-10-01", objectAccount: "647200 - Gen FM~Cell Phone", amount: 38.39, nameAlpha: "CALERO SOFTWARE LLC", remark: "2059944582", locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 20.66, nameAlpha: "CALERO SOFTWARE LLC", remark: "2146294637", locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 10, nameAlpha: "CALERO SOFTWARE LLC", remark: "3107497524", locationCode: "99999999 - Nowhere Facility" },
        { glDate: "2026-10-01", objectAccount: "602210 - Gen B&A~H&W Insurance", amount: 999, locationCode: "20001805 - TLS Princeton" },
      ],
      9,
      FY,
      "ADMIN",
      "t-cellphones.xlsx"
    );

    const data = db.getCellPhoneCharges({ fiscalYear: FY });
    assert.equal(data.count, 4, "only Cell Phone lines, not the H&W Insurance one");
    assert.equal(data.totalAmount, Math.round((39.24 + 38.39 + 20.66 + 10) * 100) / 100);

    const first = data.items.find((i) => i.phoneNumberRaw === "2059944582");
    assert.equal(first.phoneNumber, "(205) 994-4582", "a 10-digit remark is formatted for readability");
    assert.equal(first.month, null, "FY44 has no seeded fiscal calendar -- no month name to resolve");

    const grouped = data.byPhone.find((p) => p.phoneNumber === "(205) 994-4582");
    assert.ok(grouped, "expected the two lines for this number to be grouped together");
    assert.equal(grouped.count, 2);
    assert.equal(grouped.total, Math.round((39.24 + 38.39) * 100) / 100);

    const midwestOnly = db.getCellPhoneCharges({ fiscalYear: FY, territory: "Midwest" });
    assert.equal(midwestOnly.count, 3, "excludes the Nowhere Facility line, which doesn't resolve to a territory");

    const res = await server.call("GET", `/api/admin/gl/cell-phones?fiscalYear=${FY}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 4);
  });

  await t.test("getCellPhoneCharges resolves the real fiscal calendar's month name for a seeded year", () => {
    const data = db.getCellPhoneCharges({ fiscalYear: 26 });
    const sept = data.items.find((i) => i.periodNumber === 9 && i.fiscalYear === 26);
    assert.ok(sept, "expected at least one Cell Phone line from the period-9/FY26 fixture earlier in this file");
    assert.equal(sept.month, "September");
  });

  await t.test("a technician can't reach the Cell Phones route", async () => {
    const res = await server.call("GET", "/api/admin/gl/cell-phones", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("getCellPhoneCharges matches a GL line's number against the roster (tech's own phone, a phone-type device, or a cellular iPad's own line)", async () => {
    const FY = 45;
    // T1001 (Alex Rivera) already has phone "609-555-0142" seeded. T1002
    // (Jordan Lee) gets a second number via a phone-type device, covering
    // someone carrying more than one line. T1003 gets a cellular iPad with
    // its own line on the plan -- its own GL bill line, same as a phone.
    db.addDevice("T1002", "phone", "614-555-9931", "", "");
    db.addDevice("T1003", "ipad", "312-555-7720", "", "");

    db.importGlEntries(
      [
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 40, remark: "6095550142" }, // matches T1001's own phone
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 41, remark: "6145559931" }, // matches T1002's device
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 43, remark: "3125557720" }, // matches T1003's iPad
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 42, remark: "5555550000" }, // nobody's number
      ],
      1,
      FY,
      "ADMIN",
      "t-cellphone-roster.xlsx"
    );

    const data = db.getCellPhoneCharges({ fiscalYear: FY });
    const ownPhone = data.items.find((i) => i.phoneNumberRaw === "6095550142");
    assert.equal(ownPhone.assignedToId, "T1001");
    assert.equal(ownPhone.assignedToName, "Alex Rivera");

    const devicePhone = data.items.find((i) => i.phoneNumberRaw === "6145559931");
    assert.equal(devicePhone.assignedToId, "T1002");
    assert.equal(devicePhone.assignedToName, "Jordan Lee");

    const ipadLine = data.items.find((i) => i.phoneNumberRaw === "3125557720");
    assert.equal(ipadLine.assignedToId, "T1003");
    assert.equal(ipadLine.assignedToName, "Sam Patel");

    const unmatched = data.items.find((i) => i.phoneNumberRaw === "5555550000");
    assert.equal(unmatched.assignedToId, null);
    assert.equal(unmatched.assignedToName, null);

    const grouped = data.byPhone.find((p) => p.phoneNumber === "(609) 555-0142");
    assert.equal(grouped.assignedToName, "Alex Rivera");
  });

  // Still being billed for a line assigned to someone no longer employed --
  // flagged both per-line (assignedToTerminated) and as its own
  // count/total, since that's money that's likely worth cancelling.
  await t.test("getCellPhoneCharges flags a line still assigned to a terminated employee", async () => {
    const FY = 49;
    db.createTechnician({ id: "GLTERM1", name: "Gone Fromhere", pin: "4444", phone: "216-555-3030" });
    db.setEmploymentStatus("GLTERM1", "terminated");

    db.importGlEntries(
      [
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 25, remark: "2165553030" }, // terminated tech's old line
        { glDate: "2026-10-01", objectAccount: "647200 - Gen B&A~Cell Phone", amount: 40, remark: "6095550142" }, // T1001, still active
      ],
      1,
      FY,
      "ADMIN",
      "t-cellphone-terminated.xlsx"
    );

    const data = db.getCellPhoneCharges({ fiscalYear: FY });
    const terminatedLine = data.items.find((i) => i.phoneNumberRaw === "2165553030");
    assert.equal(terminatedLine.assignedToId, "GLTERM1");
    assert.equal(terminatedLine.assignedToTerminated, true);

    const activeLine = data.items.find((i) => i.phoneNumberRaw === "6095550142");
    assert.equal(activeLine.assignedToTerminated, false);

    assert.equal(data.terminatedCount, 1);
    assert.equal(data.terminatedTotal, 25);

    const grouped = data.byPhone.find((p) => p.phoneNumber === "(216) 555-3030");
    assert.equal(grouped.assignedToTerminated, true);

    const res = await server.call("GET", `/api/admin/gl/cell-phones?fiscalYear=${FY}`, { userId: "ADMIN" });
    assert.equal(res.body.terminatedCount, 1);
  });

  await t.test("getMealsCharges keeps the two Meals categories separate and groups by the raw description, never fabricating a name", async () => {
    const FY = 46;
    db.importGlEntries(
      [
        {
          glDate: "2026-10-01",
          objectAccount: "616620 - Events~Meals Empl",
          amount: 11.04,
          remark: "Plano Aug McDonald Charles",
          locationCode: "20001805 - TLS Princeton",
          documentNumber: "DOC-1001",
          supplierInvoiceNumber: "INV-555",
        },
        { glDate: "2026-10-02", objectAccount: "616620 - Events~Meals Empl", amount: 31.08, remark: "Plano Aug McDonald Charles", locationCode: "20001805 - TLS Princeton" },
        { glDate: "2026-10-01", objectAccount: "616600 - Gen FM~Meals & Ent", amount: -1904.88, remark: "Aug26 FP/ADM Concur Entry USD", nameAlpha: "Aug26 FP/ADM Concur Entry USD" },
      ],
      1,
      FY,
      "ADMIN",
      "t-meals.xlsx"
    );

    const data = db.getMealsCharges({ fiscalYear: FY });
    assert.equal(data.count, 3);
    assert.equal(data.totalAmount, Math.round((11.04 + 31.08 - 1904.88) * 100) / 100);

    // Each line carries its own full underlying GL record (glLine) -- not
    // just the handful of summary fields -- so the UI can show "the full GL
    // line" for a row on click without a second round trip.
    const firstLine = data.items.find((it) => it.glLine && it.glLine.documentNumber === "DOC-1001");
    assert.ok(firstLine, "a GL line's extra fields (document #, etc.) should be present on glLine");
    assert.equal(firstLine.glLine.supplierInvoiceNumber, "INV-555");
    assert.equal(firstLine.glLine.remark, "Plano Aug McDonald Charles");
    assert.ok(firstLine.id, "each item carries the gl_entries row id");

    const empl = data.byCategory.find((c) => c.category === "Meals Empl");
    const ent = data.byCategory.find((c) => c.category === "Meals & Ent");
    assert.equal(empl.total, Math.round((11.04 + 31.08) * 100) / 100);
    assert.equal(ent.total, -1904.88, "the two categories stay separate, not combined into one Meals total");

    const grouped = data.byDescription.find((d) => d.description === "Plano Aug McDonald Charles");
    assert.ok(grouped, "two lines with the same Concur remark text should group together");
    assert.equal(grouped.count, 2);
    assert.equal(grouped.category, "Meals Empl");

    const res = await server.call("GET", `/api/admin/gl/meals?fiscalYear=${FY}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 3);
  });

  await t.test("a technician can't reach the Meals route", async () => {
    const res = await server.call("GET", "/api/admin/gl/meals", { userId: "T1001" });
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

// Financials (GL routes, Reclasses, and the WOM cost-summary/invoicing-queue
// routes) is limited to Midwest admins -- by their own home location's
// territory, see db.getAdminTerritory -- plus whoever holds the RFM/
// reviewer role, regardless of territory (server/middleware/auth.js's
// requireFinancialsAccess). An admin with no home location set yet
// (territory null) is let through rather than blocked, so this doesn't lock
// out every admin seeded before the gate shipped.
test("Financials access gate: Midwest admins and the RFM reviewer only", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES ('FG-EAST', 'Far East Branch', 'East')").run();

  async function loginToken(id, pin) {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, pin }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, `login should succeed for ${id}`);
    return json;
  }

  await t.test("an admin with no home location set (territory null) is let through", async () => {
    db.createAdmin({ id: "FINADM1", name: "No Home Location Admin", pin: "4444" });
    const { token } = await loginToken("FINADM1", "4444");
    const res = await server.call("GET", "/api/admin/gl/meals", { token });
    assert.equal(res.status, 200);
  });

  await t.test("a Midwest-territory admin is let through", async () => {
    raw.prepare("INSERT OR IGNORE INTO locations (code, name, territory) VALUES ('PORMT-A', 'PO Remaining Test Site A', 'Midwest')").run();
    db.createAdmin({ id: "FINADM2", name: "Midwest Admin", pin: "4445", homeLocationCode: "PORMT-A" });
    const { token } = await loginToken("FINADM2", "4445");
    const res = await server.call("GET", "/api/admin/gl/meals", { token });
    assert.equal(res.status, 200);
  });

  await t.test("a non-Midwest-territory admin who isn't the RFM reviewer is blocked", async () => {
    db.createAdmin({ id: "FINADM3", name: "East Admin", pin: "4446", homeLocationCode: "FG-EAST" });
    const { token } = await loginToken("FINADM3", "4446");
    const res = await server.call("GET", "/api/admin/gl/meals", { token });
    assert.equal(res.status, 403);

    const reclassRes = await server.call("GET", "/api/admin/reclasses/summary", { token });
    assert.equal(reclassRes.status, 403);

    const costSummaryRes = await server.call("GET", "/api/woms/cost-summary", { token });
    assert.equal(costSummaryRes.status, 403);
  });

  await t.test("a non-Midwest-territory admin who IS the RFM reviewer is still let through", async () => {
    const { token, id } = await loginToken("FINADM3", "4446");
    db.setPseReviewer(id);
    const res = await server.call("GET", "/api/admin/gl/meals", { token });
    assert.equal(res.status, 200);
  });

  await t.test("login response carries territory and isPseReviewer", async () => {
    const midwest = await loginToken("FINADM2", "4445");
    assert.equal(midwest.territory, "Midwest");
    assert.equal(midwest.isPseReviewer, false);

    const reviewer = await loginToken("FINADM3", "4446");
    assert.equal(reviewer.territory, "East");
    assert.equal(reviewer.isPseReviewer, true);
  });
});

// A real monthly extract is always a single period, but a rolling export
// (e.g. an "open WOM backlog" pull spanning several months) carries rows
// from more than one Period/Fiscal Year in one file -- /preview and /import
// need to group by each row's own period instead of assuming the whole file
// is one, per Krista's "WOM Info" export (same GL line-item columns, 14
// different periods in one sheet).
test("GL import: a file spanning multiple periods splits cleanly by Period/Fiscal Year", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const XLSX = require("xlsx");

  const headers = [
    "Period Number - General Ledger", "Fiscal Year", "GL Date", "Document Type", "Document Number",
    "Journal Entry Line Number", "Business Unit", "Object Account", "Subsidiary", "Amount",
    "Batch Number", "Supplier Invoice Number", "Invoice Date", "Location Code",
    "Name - Alpha Explanation", "Name - Remark Explanation", "Purchase Order", "Subledger - G/L",
  ];

  function buildRow({ period, fy, amount, po, seq }) {
    return [
      period, fy, "2026-07-15", "PU", `DOC${seq}`, seq, "BU1", "605200 - Material", "100",
      amount, `BATCH${seq}`, `INV${seq}`, "2026-07-10", "LOC1", "Some Vendor", "A remark", po, null,
    ];
  }

  function buildWorkbook(rows) {
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "GL Report");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  raw
    .prepare(
      `INSERT INTO pos (composite_key, po_number, po_amount, subsidiary, object_code, status, location_code,
       lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Open', ?, 'active', ?, ?, ?, ?)`
    )
    .run("gl-multi-1", "PO90500", 1000, "100", "605200", "LOC1", new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

  // Fiscal year 99 with periods 1-4 -- guaranteed not to collide with any
  // other test in this file (which reuses real-looking periods/years like
  // 7/26, 8/26, 1/26 elsewhere), since this file shares one DB across all
  // its top-level test() blocks.
  const FY = 99;

  // A pre-existing single period NOT present in the multi-period file --
  // confirms importing P2/P3 never touches P1's already-imported rows.
  db.importGlEntries(
    [{ glDate: "2025-10-01", businessUnit: "BU1", objectAccount: "605200", subsidiary: "100", amount: 50, purchaseOrder: null }],
    1,
    FY,
    "ADMIN",
    "pre-existing.xlsx"
  );

  const multiPeriodRows = [
    buildRow({ period: 2, fy: FY, amount: 500, po: "PO90500", seq: 1 }),
    buildRow({ period: 2, fy: FY, amount: 250, po: null, seq: 2 }),
    buildRow({ period: 3, fy: FY, amount: 300, po: "PO90999", seq: 3 }),
    buildRow({ period: 3, fy: FY, amount: 400, po: null, seq: 4 }),
    buildRow({ period: 3, fy: FY, amount: 600, po: null, seq: 5 }),
  ];
  const multiBuffer = buildWorkbook(multiPeriodRows);

  await t.test("preview reports a breakdown per period, not one assumed period", async () => {
    const res = await server.upload("/api/admin/gl/preview", {
      userId: "ADMIN",
      fileName: "wom-info.xlsx",
      fileContent: multiBuffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.periods.length, 2);
    assert.equal(res.body.totalRowCount, 5);
    const p2 = res.body.periods.find((p) => p.periodNumber === 2 && p.fiscalYear === FY);
    const p3 = res.body.periods.find((p) => p.periodNumber === 3 && p.fiscalYear === FY);
    assert.equal(p2.rowCount, 2);
    assert.equal(p3.rowCount, 3);
    assert.equal(p2.existingImport, null);
    assert.equal(p3.existingImport, null);
  });

  await t.test("import writes every period's rows under its own period, in one call", async () => {
    const res = await server.upload("/api/admin/gl/import", {
      userId: "ADMIN",
      fields: { calendarMonth: "2026-07" },
      fileName: "wom-info.xlsx",
      fileContent: multiBuffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const importResult = res.body;
    assert.equal(importResult.periods.length, 2);
    assert.equal(importResult.rowCount, 5);
    assert.equal(importResult.matchedCount, 1); // PO90500
    assert.equal(importResult.unmatchedCount, 1); // PO90999, not on file
    assert.equal(importResult.noPoReferenceCount, 3);

    const p2Rows = raw.prepare("SELECT COUNT(*) AS c FROM gl_entries WHERE period_number = 2 AND fiscal_year = ?").get(FY);
    const p3Rows = raw.prepare("SELECT COUNT(*) AS c FROM gl_entries WHERE period_number = 3 AND fiscal_year = ?").get(FY);
    assert.equal(p2Rows.c, 2);
    assert.equal(p3Rows.c, 3);
  });

  await t.test("a period not present in the multi-period file is left untouched", () => {
    const p1Rows = raw.prepare("SELECT COUNT(*) AS c FROM gl_entries WHERE period_number = 1 AND fiscal_year = ?").get(FY);
    assert.equal(p1Rows.c, 1);
  });

  await t.test("each period got its own gl_imports row", () => {
    const imports = raw
      .prepare("SELECT period_number, fiscal_year, row_count FROM gl_imports WHERE fiscal_year = ? AND period_number IN (2, 3) ORDER BY period_number")
      .all(FY);
    assert.equal(imports.length, 2);
    assert.equal(imports[0].period_number, 2);
    assert.equal(imports[0].row_count, 2);
    assert.equal(imports[1].period_number, 3);
    assert.equal(imports[1].row_count, 3);
  });

  await t.test("a multi-period import is NOT filed as a single Reports-tab document", () => {
    const files = raw.prepare("SELECT COUNT(*) AS c FROM files WHERE related_type = 'labor_report' AND category = 'gl_report'").get();
    assert.equal(files.c, 0);
  });

  await t.test("re-previewing the same file now flags both periods as already imported", async () => {
    const res = await server.upload("/api/admin/gl/preview", {
      userId: "ADMIN",
      fileName: "wom-info.xlsx",
      fileContent: multiBuffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const p2 = res.body.periods.find((p) => p.periodNumber === 2);
    const p3 = res.body.periods.find((p) => p.periodNumber === 3);
    assert.ok(p2.existingImport);
    assert.ok(p3.existingImport);
    assert.equal(p2.existingImport.rowCount, 2);
    assert.equal(p3.existingImport.rowCount, 3);
  });

  await t.test("a single-period file still files the source document into the Reports tab, as before", async () => {
    const singleBuffer = buildWorkbook([buildRow({ period: 4, fy: FY, amount: 100, po: null, seq: 10 })]);
    const res = await server.upload("/api/admin/gl/import", {
      userId: "ADMIN",
      fields: { calendarMonth: "2026-09" },
      fileName: "september.xlsx",
      fileContent: singleBuffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.periods.length, 1);
    assert.equal(res.body.periods[0].periodNumber, 4);

    const files = raw.prepare("SELECT COUNT(*) AS c FROM files WHERE related_type = 'labor_report' AND category = 'gl_report'").get();
    assert.equal(files.c, 1);
  });

  await t.test("importing without a calendarMonth is rejected", async () => {
    const buffer = buildWorkbook([buildRow({ period: 5, fy: FY, amount: 100, po: null, seq: 11 })]);
    const res = await server.upload("/api/admin/gl/import", {
      userId: "ADMIN",
      fileName: "no-month.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 400);
  });

  await t.test("a malformed calendarMonth is rejected", async () => {
    const buffer = buildWorkbook([buildRow({ period: 5, fy: FY, amount: 100, po: null, seq: 12 })]);
    const res = await server.upload("/api/admin/gl/import", {
      userId: "ADMIN",
      fields: { calendarMonth: "September 2026" },
      fileName: "bad-month.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 400);
  });

  await t.test("the chosen calendarMonth is recorded on the import and surfaced in /imports", async () => {
    const buffer = buildWorkbook([buildRow({ period: 6, fy: FY, amount: 100, po: null, seq: 13 })]);
    const res = await server.upload("/api/admin/gl/import", {
      userId: "ADMIN",
      fields: { calendarMonth: "2026-11" },
      fileName: "november.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.periods[0].calendarMonth, "2026-11");

    const imports = await server.call("GET", "/api/admin/gl/imports", { userId: "ADMIN" });
    const thisImport = imports.body.find((i) => i.periodNumber === 6 && i.fiscalYear === FY);
    assert.ok(thisImport, "expected the new import to show up in the imports list");
    assert.equal(thisImport.calendarMonth, "2026-11");
  });
});
