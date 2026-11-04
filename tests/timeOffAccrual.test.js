const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// The accrual engine itself (db.runTimeOffAccrual), covering what
// timeOff.test.js's flat annual-grant fixtures don't exercise: real
// monthly pro-ration of a hire month, an accrual capped mid-year, the
// Jan-1 carryover exception, re-run idempotency, and the audit-trail
// endpoint PurelyHR's own screen is modeled on.
test("Time Off: accrual engine", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("a monthly PTO rule pro-rates the hire month", async () => {
    // Hired mid-month: 2026-03-16. March has 31 days; employed 16 of them
    // (16th through 31st inclusive) -- 16/31 of the monthly rate.
    raw.prepare("UPDATE technicians SET hire_date = ? WHERE id = ?").run("2026-03-16", "T1001");

    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Tier 1 PTO",
        rules: [{ type: "vacation", frequency: "monthly", accrueOnDay: 1, rateHours: 6.64, accrueUntil: "cap", capHours: 80, startRule: "hire_date" }],
      },
    });
    await server.call("PATCH", "/api/time-off/technicians/T1001/policy", { userId: "ADMIN", body: { policyId: policyRes.body.id } });

    // The 1st of the hire month itself is before the hire date -- no post.
    let run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-03-01" } });
    assert.equal(run.body.posted, 0);

    // April 1st: the first occurrence on/after hire -- this IS the hire
    // month's own pro-rated post (the engine posts on accrue_on_day of the
    // month, so the hire month's pro-ration lands on the first occurrence
    // at/after hire_date's own month).
    run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-04-01" } });
    assert.equal(run.body.posted, 1);

    const events = await server.call("GET", "/api/time-off/accrual-events/T1001?type=vacation&year=2026", { userId: "ADMIN" });
    assert.equal(events.body.length, 1);
    assert.equal(events.body[0].accrualDate, "2026-04-01");
    // 16/31 * 6.64 rounded to 2 decimals.
    assert.equal(events.body[0].hours, Math.round((6.64 * (16 / 31)) * 100) / 100);
    assert.equal(events.body[0].accruedBy, "System Accrual");
  });

  await t.test("re-running the same day is a no-op (idempotent)", async () => {
    const run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-04-01" } });
    assert.equal(run.body.posted, 0);
    const events = await server.call("GET", "/api/time-off/accrual-events/T1001?type=vacation&year=2026", { userId: "ADMIN" });
    assert.equal(events.body.length, 1, "still just the one event, not doubled");
  });

  await t.test("accrual stops once the annual cap is reached", async () => {
    // Its own tech/policy/low cap, isolated from T1001's running Tier 1
    // PTO balance above, so hitting the cap is decisive rather than a
    // "probably close" guess.
    raw
      .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, hire_date) VALUES (?, ?, ?, 'tech', 1, 'active', ?)")
      .run("TCAP", "Cap Test", "hash", "2020-01-01");
    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Low Cap PTO",
        rules: [{ type: "vacation", frequency: "monthly", accrueOnDay: 1, rateHours: 6.64, accrueUntil: "cap", capHours: 20, startRule: "hire_date" }],
      },
    });
    await server.call("PATCH", "/api/time-off/technicians/TCAP/policy", { userId: "ADMIN", body: { policyId: policyRes.body.id } });

    // 6.64/mo would reach 26.56h after 4 months -- over the 20h cap.
    for (const m of ["01", "02", "03", "04"]) {
      await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: `2026-${m}-01` } });
    }
    const balance = await server.call("GET", "/api/time-off/balance/TCAP?year=2026", { userId: "ADMIN" });
    assert.equal(balance.body.types.find((t2) => t2.type === "vacation").accruedHours, 20, "clamped exactly at the cap, never over it");

    const events = await server.call("GET", "/api/time-off/accrual-events/TCAP?type=vacation&year=2026", { userId: "ADMIN" });
    assert.equal(events.body.length, 4, "every month still posts its own (possibly partial, possibly zero) event up to the cap");
  });

  await t.test("Jan-1 carryover: use-it-or-lose-it by default, up to 1.75x for an exempt employee", async () => {
    // A second tech, isolated from T1001's running balance above, so the
    // carryover math is easy to reason about independently.
    raw
      .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, hire_date) VALUES (?, ?, ?, 'tech', 1, 'active', ?)")
      .run("TCARRY", "Carryover Test", "hash", "2020-01-01");

    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Flat Annual PTO",
        rules: [{ type: "vacation", frequency: "annually", accrueOnDay: 1, rateHours: 80, accrueUntil: "cap", capHours: 80, startRule: "calendar_year" }],
      },
    });
    await server.call("PATCH", "/api/time-off/technicians/TCARRY/policy", { userId: "ADMIN", body: { policyId: policyRes.body.id } });

    // Grant the full 80h for 2026, use none of it.
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-01-01" } });
    let balance2026 = await server.call("GET", "/api/time-off/balance/TCARRY?year=2026", { userId: "ADMIN" });
    assert.equal(balance2026.body.types.find((t2) => t2.type === "vacation").balance, 80);

    // Not exempt -- 2027's Jan-1 run should post the new year's 80h grant
    // but NOT carry over the unused 80h from 2026.
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2027-01-01" } });
    let balance2027 = await server.call("GET", "/api/time-off/balance/TCARRY?year=2027", { userId: "ADMIN" });
    assert.equal(balance2027.body.types.find((t2) => t2.type === "vacation").accruedHours, 80, "just this year's flat grant, no carryover");

    // Mark exempt (CA/MT/NE), then run 2028's Jan-1: this year's 80h grant
    // PLUS up to 1.75x80=140h carried over from 2027's unused balance (80h
    // unused -> fully carries, since 80 < 140).
    await server.call("PATCH", "/api/time-off/technicians/TCARRY/carryover-exempt", { userId: "ADMIN", body: { exempt: true } });
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2028-01-01" } });
    const balance2028 = await server.call("GET", "/api/time-off/balance/TCARRY?year=2028", { userId: "ADMIN" });
    assert.equal(balance2028.body.types.find((t2) => t2.type === "vacation").accruedHours, 160, "80h new grant + 80h carried over");

    const events2028 = await server.call("GET", "/api/time-off/accrual-events/TCARRY?type=vacation&year=2028", { userId: "ADMIN" });
    assert.ok(events2028.body.some((e) => e.accruedBy === "Carryover"));
  });

  await t.test("Sick time posts as a flat grant on hire date, then Jan 1 each year after", async () => {
    raw.prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, hire_date) VALUES (?, ?, ?, 'tech', 1, 'active', ?)").run(
      "TSICK",
      "Sick Grant Test",
      "hash",
      "2026-05-20"
    );
    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: { name: "Sick Only", rules: [{ type: "sick", frequency: "on_hire_date", rateHours: 40, accrueUntil: "none" }] },
    });
    await server.call("PATCH", "/api/time-off/technicians/TSICK/policy", { userId: "ADMIN", body: { policyId: policyRes.body.id } });

    // Checks TSICK's own event list rather than the run's global posted
    // count -- other techs' rules legitimately fire on some of these same
    // calendar dates (e.g. another policy's own Jan-1 accrual), so the
    // global counter isn't this test's signal.
    async function sickEventDates() {
      const res = await server.call("GET", "/api/time-off/accrual-events/TSICK?type=sick", { userId: "ADMIN" });
      return res.body.map((e) => e.accrualDate).sort();
    }

    // Jan 1 of the hire year does NOT grant (grant is on the actual hire date in the hire year).
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-01-01" } });
    assert.deepEqual(await sickEventDates(), []);
    // The actual hire date grants it.
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-05-20" } });
    assert.deepEqual(await sickEventDates(), ["2026-05-20"]);
    // The following Jan 1 (not the hire-date anniversary) grants the next one.
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2027-01-01" } });
    assert.deepEqual(await sickEventDates(), ["2026-05-20", "2027-01-01"]);
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2027-05-20" } });
    assert.deepEqual(await sickEventDates(), ["2026-05-20", "2027-01-01"], "no second grant on the hire-date anniversary itself");
  });

  await t.test("a technician cannot run accrual or read someone else's audit trail", async () => {
    const runRes = await server.call("POST", "/api/time-off/run-accrual", { userId: "T1001", body: {} });
    assert.equal(runRes.status, 403);
    const eventsRes = await server.call("GET", "/api/time-off/accrual-events/T1002", { userId: "T1001" });
    assert.equal(eventsRes.status, 403);
  });
});
