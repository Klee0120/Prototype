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
