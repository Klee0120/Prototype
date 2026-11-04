const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Budget Review answers the FY27 budget deck's own gap: a few sites get a
// 5-year R&M-spend-vs-budget table and an OT-rate trend backing a
// headcount/R&M ask, Kansas City doesn't. This pulls the same two signals
// (R&M spend from the GL import, OT rate from logged hours) from data
// already in ServiceWorks, for any site -- see db.getBudgetReviewReport.
test("Budget Review: R&M spend-vs-budget + OT rate by site/fiscal year", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("KC1", "Kansas City", "Midwest");
  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("EAST1", "East Site", "East");

  function insertGl({ locationCode, objectAccount, amount, fiscalYear }) {
    raw
      .prepare(
        `INSERT INTO gl_entries (object_account, amount, fiscal_year, matched_location_code, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(objectAccount, amount, fiscalYear, locationCode, now);
  }

  insertGl({ locationCode: "KC1", objectAccount: "605200 ~ R&M", amount: 1000, fiscalYear: 26 });
  insertGl({ locationCode: "KC1", objectAccount: "605200 ~ R&M", amount: 500, fiscalYear: 26 });
  insertGl({ locationCode: "KC1", objectAccount: "600100 ~ Labor", amount: 2000, fiscalYear: 26 });
  insertGl({ locationCode: "EAST1", objectAccount: "605200 ~ R&M", amount: 300, fiscalYear: 26 });

  await t.test("listGlCategories returns every distinct parsed category on file", () => {
    const categories = db.listGlCategories();
    assert.ok(categories.includes("R&M"));
    assert.ok(categories.includes("Labor"));
  });

  await t.test("getBudgetReviewReport sums only the selected categories, scoped by location", () => {
    const { rows } = db.getBudgetReviewReport({ location: "KC1", categories: ["R&M"] });
    const row = rows.find((r) => r.fiscalYear === 26);
    assert.ok(row, "expected a FY26 row for KC1");
    assert.equal(row.rmSpend, 1500); // R&M only, Labor excluded
  });

  await t.test("getBudgetReviewReport with no categories selected includes every category", () => {
    const { rows } = db.getBudgetReviewReport({ location: "KC1", categories: [] });
    const row = rows.find((r) => r.fiscalYear === 26);
    assert.equal(row.rmSpend, 3500); // R&M (1500) + Labor (2000)
  });

  await t.test("territory filter excludes a site outside the selected territory", () => {
    const { rows } = db.getBudgetReviewReport({ territory: "Midwest", categories: ["R&M"] });
    assert.ok(rows.some((r) => r.locationCode === "KC1"));
    assert.ok(!rows.some((r) => r.locationCode === "EAST1"));
  });

  await t.test("setRmBudget upserts (replaces, not stacks) and feeds variance", () => {
    const first = db.setRmBudget("KC1", 26, 1200, "ADMIN");
    assert.equal(first.amount, 1200);

    let { rows } = db.getBudgetReviewReport({ location: "KC1", categories: ["R&M"] });
    let row = rows.find((r) => r.fiscalYear === 26);
    assert.equal(row.rmBudget, 1200);
    assert.equal(row.variance, 300); // 1500 spend - 1200 budget

    db.setRmBudget("KC1", 26, 1800, "ADMIN");
    const budgets = db.listRmBudgets().filter((b) => b.locationCode === "KC1" && b.fiscalYear === 26);
    assert.equal(budgets.length, 1, "replaces the existing row rather than stacking a second one");

    ({ rows } = db.getBudgetReviewReport({ location: "KC1", categories: ["R&M"] }));
    row = rows.find((r) => r.fiscalYear === 26);
    assert.equal(row.rmBudget, 1800);
    assert.equal(row.variance, -300); // 1500 spend - 1800 budget
  });

  await t.test("OT rate is attributed to the tech's home location and bucketed by fiscal year", () => {
    // A brand-new technician, not one of the seeded demo techs -- reusing
    // a seeded tech here would pull in their own real seed allocations
    // (also dated within FY26), double-counting into the same bucket.
    raw
      .prepare(
        "INSERT INTO technicians (id, name, pin, role, active, home_location_code) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("TOTTEST", "OT Test Tech", "hash", "tech", 1, "KC1");
    // Week of 2026-01-05 resolves to Period 1/FY26 (fiscalMonthEnd 2026-01-11).
    raw
      .prepare("INSERT INTO allocations (tech_id, week_monday, day, type, location_code, hours) VALUES (?, ?, ?, ?, ?, ?)")
      .run("TOTTEST", "2026-01-05", "mon", "ef", "KC1", 30);
    raw
      .prepare("INSERT INTO allocations (tech_id, week_monday, day, type, location_code, hours) VALUES (?, ?, ?, ?, ?, ?)")
      .run("TOTTEST", "2026-01-05", "tue", "ef", "KC1", 20); // 50 total -> 10 OT

    const { rows } = db.getBudgetReviewReport({ location: "KC1" });
    const row = rows.find((r) => r.fiscalYear === 26);
    assert.equal(row.otHours, 10);
    assert.equal(row.totalHours, 50);
    assert.equal(row.otRatePct, 20); // 10/50 * 100
  });

  await t.test("GET /api/admin/gl/budget-review and PUT /rm-budgets round-trip over HTTP", async () => {
    const getRes = await server.call("GET", "/api/admin/gl/budget-review?location=KC1&categories=R%26M", { userId: "ADMIN" });
    assert.equal(getRes.status, 200);
    assert.ok(getRes.body.categories.includes("R&M"));

    const putRes = await server.call("PUT", "/api/admin/gl/rm-budgets", {
      userId: "ADMIN",
      body: { locationCode: "EAST1", fiscalYear: 26, amount: 999 },
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.amount, 999);

    const listRes = await server.call("GET", "/api/admin/gl/rm-budgets", { userId: "ADMIN" });
    assert.ok(listRes.body.some((b) => b.locationCode === "EAST1" && b.fiscalYear === 26 && b.amount === 999));
  });

  await t.test("a technician cannot reach the budget-review or rm-budgets routes", async () => {
    const res = await server.call("GET", "/api/admin/gl/budget-review", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});
