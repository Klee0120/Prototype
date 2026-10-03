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
});
