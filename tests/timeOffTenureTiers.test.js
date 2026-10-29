const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Tenure-tiered accrual rules -- one policy whose rate follows each
// technician's own hire date automatically (the real PTO policy's "0-1
// years / 2nd year / 3rd year / ..." rate card), replacing the old design
// where an admin had to manually move someone to a different named
// policy/rule at every work anniversary. See db.js's resolveAccrualRateForTech
// and completedYearsOfService.
test("Time Off: tenure-tiered accrual rules", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, hire_date) VALUES (?, ?, ?, 'tech', 1, 'active', ?)")
    .run("TTIER", "Tier Test", "hash", "2023-01-01");

  let policyId;

  await t.test("rejects a tiered rule with no tiers", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: { name: "Bad Tiered", rules: [{ type: "vacation", frequency: "monthly", accrueOnDay: 1, accrueUntil: "cap", startRule: "hire_date", tiered: true, tiers: [] }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least one tier/);
  });

  await t.test("rejects two tiers starting at the same years-of-service", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Bad Tiered 2",
        rules: [
          {
            type: "vacation",
            frequency: "monthly",
            accrueOnDay: 1,
            accrueUntil: "cap",
            startRule: "hire_date",
            tiered: true,
            tiers: [
              { minYears: 0, rateHours: 5, capHours: 60 },
              { minYears: 0, rateHours: 6, capHours: 72 },
            ],
          },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /both start at 0 years/);
  });

  await t.test("rejects a tier missing its cap when accrueUntil is 'cap'", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Bad Tiered 3",
        rules: [
          {
            type: "vacation",
            frequency: "monthly",
            accrueOnDay: 1,
            accrueUntil: "cap",
            startRule: "hire_date",
            tiered: true,
            tiers: [{ minYears: 0, rateHours: 5, capHours: null }],
          },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /needs a cap/);
  });

  await t.test("creates a real 3-tier policy and assigns it", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "Standard PTO",
        rules: [
          {
            type: "vacation",
            frequency: "monthly",
            accrueOnDay: 1,
            accrueUntil: "cap",
            startRule: "hire_date",
            tiered: true,
            tiers: [
              { minYears: 0, rateHours: 5, capHours: 200 },
              { minYears: 1, rateHours: 8, capHours: 200 },
              { minYears: 2, rateHours: 10, capHours: 200 },
            ],
          },
        ],
      },
    });
    assert.equal(res.status, 201);
    const rule = res.body.rules.find((r) => r.type === "vacation");
    assert.equal(rule.tiered, true);
    assert.equal(rule.tiers.length, 3);
    // Returned sorted ascending by minYears regardless of input order.
    assert.deepEqual(rule.tiers.map((t2) => t2.minYears), [0, 1, 2]);
    policyId = res.body.id;

    const assign = await server.call("PATCH", "/api/time-off/technicians/TTIER/policy", { userId: "ADMIN", body: { policyId } });
    assert.equal(assign.status, 200);
  });

  await t.test("a technician's first occurrence uses the tier matching their years of service at that time", async () => {
    // Hired 2023-01-01 exactly on the accrual day -- no pro-ration to
    // muddy the rate assertion. Still under 1 completed year on 2023-02-01
    // -> the 0-years tier (rate 5).
    const run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2023-02-01" } });
    assert.equal(run.body.posted, 1);
    const events = await server.call("GET", "/api/time-off/accrual-events/TTIER?type=vacation&year=2023", { userId: "ADMIN" });
    assert.equal(events.body.length, 1);
    assert.equal(events.body[0].hours, 5);
  });

  await t.test("the rate advances automatically on the 1-year anniversary -- no policy/rule swap needed", async () => {
    const run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2024-01-01" } });
    assert.equal(run.body.posted, 1);
    const events = await server.call("GET", "/api/time-off/accrual-events/TTIER?type=vacation&year=2024", { userId: "ADMIN" });
    assert.equal(events.body.length, 1);
    assert.equal(events.body[0].hours, 8, "crossed into the 2nd year of service -- rate 8, automatically");
  });

  await t.test("and again on the 2-year anniversary", async () => {
    const run = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2025-01-01" } });
    assert.equal(run.body.posted, 1);
    const events = await server.call("GET", "/api/time-off/accrual-events/TTIER?type=vacation&year=2025", { userId: "ADMIN" });
    assert.equal(events.body.length, 1);
    assert.equal(events.body[0].hours, 10, "3rd year of service -- rate 10, still automatic");
  });

  await t.test("the balance tab's cap follows the person's own current tier too", async () => {
    // All three tiers share cap 200 in this fixture, so change the current
    // (2-years) tier's cap and confirm the balance reflects THAT tier's
    // cap, not tier 0's.
    const policy = (await server.call("GET", "/api/time-off/policies", { userId: "ADMIN" })).body.find((p) => p.id === policyId);
    const rule = policy.rules.find((r) => r.type === "vacation");
    await server.call("PATCH", `/api/time-off/policies/${policyId}`, {
      userId: "ADMIN",
      body: {
        rules: [
          {
            ...rule,
            tiers: rule.tiers.map((t2) => (t2.minYears === 2 ? { ...t2, capHours: 123 } : t2)),
          },
        ],
      },
    });
    const balance = await server.call("GET", "/api/time-off/balance/TTIER?year=2025", { userId: "ADMIN" });
    assert.equal(balance.body.types.find((t2) => t2.type === "vacation").capHours, 123);
  });
});
