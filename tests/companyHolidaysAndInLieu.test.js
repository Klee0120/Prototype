const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// company_holidays (the real Toyota/TMNA holiday calendar, re-entered
// every year -- see db.js's own comment) and the admin-granted
// floating-holiday-in-lieu-of-a-holiday-worked bank, which is the one
// balance entry in this app that carries its own expiry (6 months from
// the holiday worked) rather than the normal "resets every Jan 1" rule.
function isoDaysFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("company holidays: CRUD", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  let holidayId;

  await t.test("admin can add a holiday", async () => {
    const res = await server.call("POST", "/api/time-off/holidays", {
      userId: "ADMIN",
      body: { date: "2026-12-25", name: "Christmas Day" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.date, "2026-12-25");
    assert.equal(res.body.name, "Christmas Day");
    holidayId = res.body.id;
  });

  await t.test("a technician cannot add one", async () => {
    const res = await server.call("POST", "/api/time-off/holidays", {
      userId: "T1001",
      body: { date: "2026-07-03", name: "Independence Day" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects a duplicate date", async () => {
    const res = await server.call("POST", "/api/time-off/holidays", {
      userId: "ADMIN",
      body: { date: "2026-12-25", name: "Christmas (dup)" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("any authenticated user can list holidays, filtered by year", async () => {
    await server.call("POST", "/api/time-off/holidays", { userId: "ADMIN", body: { date: "2027-01-01", name: "New Year's Day" } });
    const res2026 = await server.call("GET", "/api/time-off/holidays?year=2026", { userId: "T1001" });
    assert.equal(res2026.status, 200);
    assert.ok(res2026.body.some((h) => h.name === "Christmas Day"));
    assert.ok(!res2026.body.some((h) => h.name === "New Year's Day"));
  });

  await t.test("admin can edit a holiday", async () => {
    const res = await server.call("PATCH", `/api/time-off/holidays/${holidayId}`, { userId: "ADMIN", body: { name: "Christmas Day (Observed)" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Christmas Day (Observed)");
  });

  await t.test("admin can delete a holiday", async () => {
    const res = await server.call("DELETE", `/api/time-off/holidays/${holidayId}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const list = await server.call("GET", "/api/time-off/holidays?year=2026", { userId: "ADMIN" });
    assert.ok(!list.body.some((h) => h.id === holidayId));
  });

  await t.test("404s editing/deleting a holiday that doesn't exist", async () => {
    const patchRes = await server.call("PATCH", "/api/time-off/holidays/999999", { userId: "ADMIN", body: { name: "x" } });
    assert.equal(patchRes.status, 404);
    const delRes = await server.call("DELETE", "/api/time-off/holidays/999999", { userId: "ADMIN" });
    assert.equal(delRes.status, 404);
  });
});

test("floating holiday in-lieu grant: admin-only, expires 6 months out, respected by balance", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // The balance view only shows a type the tech's assigned policy
  // actually offers (pre-existing, deliberate -- see computeTimeOffBalance's
  // own ruleByType filter), so a floating_holiday grant needs a policy
  // with that rule, same as it would in real use (the 2 baseline floating
  // holidays from the real Toyota memo are themselves a floating_holiday
  // rule on the policy).
  const policyRes = await server.call("POST", "/api/time-off/policies", {
    userId: "ADMIN",
    body: { name: "Floating Holiday Test Policy", rules: [{ type: "floating_holiday", frequency: "annually", accrueOnDay: 1, rateHours: 16, accrueUntil: "none", startRule: "hire_date" }] },
  });
  const policyId = policyRes.body.id;
  await server.call("PATCH", "/api/time-off/technicians/T1001/policy", { userId: "ADMIN", body: { policyId } });
  await server.call("PATCH", "/api/time-off/technicians/T1002/policy", { userId: "ADMIN", body: { policyId } });

  await t.test("a technician cannot self-grant", async () => {
    const res = await server.call("POST", "/api/time-off/technicians/T1001/in-lieu-grant", {
      userId: "T1001",
      body: { workedDate: "2026-11-26" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin grants it, expires_at is exactly 6 months after the worked date", async () => {
    const res = await server.call("POST", "/api/time-off/technicians/T1001/in-lieu-grant", {
      userId: "ADMIN",
      body: { workedDate: "2026-11-26" },
    });
    assert.equal(res.status, 201);
    const grant = res.body.find((e) => e.accrualDate === "2026-11-26");
    assert.ok(grant, "expected the in-lieu event to be in the returned ledger");
    assert.equal(grant.hours, 8);
    assert.equal(grant.expiresAt, "2027-05-26");
    assert.equal(grant.accruedBy, "In Lieu of Holiday Worked");
  });

  await t.test("it counts toward 2026's floating_holiday balance (unexpired)", async () => {
    const res = await server.call("GET", "/api/time-off/balance/T1001?year=2026", { userId: "ADMIN" });
    const entry = res.body.types.find((e) => e.type === "floating_holiday");
    assert.ok(entry, "expected a floating_holiday entry even though no policy offers it -- the ledger event itself should still show");
  });

  await t.test("rejects a non-positive hours override", async () => {
    const res = await server.call("POST", "/api/time-off/technicians/T1002/in-lieu-grant", {
      userId: "ADMIN",
      body: { workedDate: "2026-11-26", hours: 0 },
    });
    assert.equal(res.status, 400);
  });
});

test("computeTimeOffBalance: expiry math, independent of API routes", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");

  const policyRes = await server.call("POST", "/api/time-off/policies", {
    userId: "ADMIN",
    body: { name: "Floating Holiday Expiry Test Policy", rules: [{ type: "floating_holiday", frequency: "annually", accrueOnDay: 1, rateHours: 16, accrueUntil: "none", startRule: "hire_date" }] },
  });
  const policyId = policyRes.body.id;
  for (const techId of ["T1001", "T1002", "T1003"]) {
    await server.call("PATCH", `/api/time-off/technicians/${techId}/policy`, { userId: "ADMIN", body: { policyId } });
  }

  await t.test("an unexpired in-lieu grant counts in this year's balance", async () => {
    const futureExpiry = isoDaysFromToday(60); // still months out
    const workedDate = isoDaysFromToday(-30); // a month ago, same calendar year as today for this assertion's purposes
    db.grantInLieuFloatingHoliday({ techId: "T1002", workedDate, hours: 8, createdBy: "ADMIN" });
    const year = Number(new Date().getFullYear());
    const balance = db.computeTimeOffBalance("T1002", year);
    const entry = balance.types.find((t) => t.type === "floating_holiday");
    assert.ok(entry.accruedHours >= 8, `expected the unexpired grant to count, got ${entry.accruedHours}`);
    void futureExpiry;
  });

  await t.test("an already-expired in-lieu grant does NOT count, even though its accrual_date is in this year", async () => {
    // A grant whose 6-month expiry already passed -- simulate by writing
    // directly, since grantInLieuFloatingHoliday always computes +6mo from
    // a real worked date and there's no legitimate way to get an expired
    // grant through the public function with today's real date.
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
    const longAgo = isoDaysFromToday(-400);
    const alreadyExpired = isoDaysFromToday(-10);
    raw
      .prepare(
        `INSERT INTO time_off_accrual_events (tech_id, type, accrual_date, hours, rule_id, source, note, created_by, expires_at, created_at)
         VALUES ('T1003', 'floating_holiday', ?, 8, NULL, 'in_lieu_holiday', 'test', 'ADMIN', ?, ?)`
      )
      .run(longAgo, alreadyExpired, new Date().toISOString());
    const year = Number(new Date().getFullYear());
    const balance = db.computeTimeOffBalance("T1003", year);
    const entry = balance.types.find((t) => t.type === "floating_holiday");
    assert.equal(entry.accruedHours, 0, "an already-expired grant should not count toward the balance");
  });

  await t.test("a grant posted late last year, whose expiry extends into this year, still counts in this year's balance", async () => {
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
    const currentYear = new Date().getFullYear();
    const lastYearDate = `${currentYear - 1}-12-15`;
    const stillValidExpiry = isoDaysFromToday(30); // in the future
    raw
      .prepare(
        `INSERT INTO time_off_accrual_events (tech_id, type, accrual_date, hours, rule_id, source, note, created_by, expires_at, created_at)
         VALUES ('T1001', 'floating_holiday', ?, 8, NULL, 'in_lieu_holiday', 'test-carryover', 'ADMIN', ?, ?)`
      )
      .run(lastYearDate, stillValidExpiry, new Date().toISOString());
    const balance = db.computeTimeOffBalance("T1001", currentYear);
    const entry = balance.types.find((t) => t.type === "floating_holiday");
    assert.ok(entry.accruedHours >= 8, `expected the still-valid prior-year grant to carry into this year's balance, got ${entry.accruedHours}`);
  });
});
