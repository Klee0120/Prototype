const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Time Off: a real request/approval/balance system, separate from the
// existing allocations.type='timeoff' weekly-hours entries -- modeled on
// PurelyHR per Krista's screenshots. Covers the genuinely new piece: a
// per-person approver list (not a single "manager" field) that supports
// her exact scenario -- Kevin approves Krista's own requests, and BOTH
// Krista and Kevin can approve any technician's.
test("Time Off: policies, approvers, requests, balances", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  // A second admin ("KEVIN") plus a tech, beyond the seeded ADMIN/T1001.
  // A real session token (not a demo-PIN login) since the test harness's
  // DEMO_PINS map only knows the seeded accounts.
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status) VALUES (?, ?, ?, 'admin', 1, 'active')")
    .run("KEVIN", "Kevin Fluegeman", "hash");
  const kevinToken = db.createSession("KEVIN");

  await t.test("creating a policy with accrual rules, then reading it back", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "2yr Policy",
        rules: [
          { type: "vacation", frequency: "annually", accrueOnDay: 1, rateHours: 80, accrueUntil: "cap", capHours: 80, startRule: "calendar_year" },
          { type: "sick", frequency: "on_hire_date", rateHours: 40, accrueUntil: "none" },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.rules.length, 2);
  });

  await t.test("a technician cannot manage policies", async () => {
    const res = await server.call("GET", "/api/time-off/policies", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  // T1001 has no seeded hire_date -- the accrual engine can't pro-rate or
  // post anything for someone it has no hire anchor for, so every test
  // below that needs real accrued hours needs this set first.
  raw.prepare("UPDATE technicians SET hire_date = ? WHERE id = ?").run("2020-01-01", "T1001");

  let policyId;
  await t.test("assigning a policy to a technician, then running accrual", async () => {
    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "New Hire",
        rules: [
          { type: "vacation", frequency: "annually", accrueOnDay: 1, rateHours: 40, accrueUntil: "cap", capHours: 40, startRule: "calendar_year" },
          { type: "floating_holiday", frequency: "annually", accrueOnDay: 1, rateHours: 16, accrueUntil: "cap", capHours: 16, startRule: "calendar_year" },
        ],
      },
    });
    policyId = policyRes.body.id;
    const assignRes = await server.call("PATCH", "/api/time-off/technicians/T1001/policy", { userId: "ADMIN", body: { policyId } });
    assert.equal(assignRes.status, 200);

    const runRes = await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-01-01" } });
    assert.equal(runRes.status, 200);
    assert.equal(runRes.body.posted, 2); // vacation + floating_holiday, one event each

    const balanceRes = await server.call("GET", "/api/time-off/balance/T1001", { userId: "ADMIN" });
    assert.equal(balanceRes.body.policyName, "New Hire");
    assert.equal(balanceRes.body.types.length, 2);
    const vacation = balanceRes.body.types.find((t2) => t2.type === "vacation");
    assert.equal(vacation.accruedHours, 40);
    assert.equal(vacation.capHours, 40);
    assert.equal(vacation.used, 0);
    assert.equal(vacation.balance, 40);
  });

  await t.test("with no approvers configured, any active admin may approve", () => {
    assert.equal(db.canApproveTimeOff("ADMIN", "T1001"), true);
    assert.equal(db.canApproveTimeOff("KEVIN", "T1001"), true);
  });

  await t.test("self-approval is always blocked, even if self-listed", () => {
    db.setTimeOffApprovers("ADMIN", ["ADMIN", "KEVIN"]);
    assert.equal(db.canApproveTimeOff("ADMIN", "ADMIN"), false);
    assert.equal(db.canApproveTimeOff("KEVIN", "ADMIN"), true);
  });

  await t.test("Krista's exact scenario: Kevin approves her own; both Kevin and Krista approve a tech's", () => {
    // ADMIN here stands in for "Krista." Her own requests: only Kevin approves.
    db.setTimeOffApprovers("ADMIN", ["KEVIN"]);
    assert.equal(db.canApproveTimeOff("KEVIN", "ADMIN"), true);
    assert.equal(db.canApproveTimeOff("ADMIN", "ADMIN"), false, "never self-approve");

    // Techs: both Krista (ADMIN) and Kevin can approve.
    db.setTimeOffApprovers("T1001", ["ADMIN", "KEVIN"]);
    assert.equal(db.canApproveTimeOff("ADMIN", "T1001"), true);
    assert.equal(db.canApproveTimeOff("KEVIN", "T1001"), true);
  });

  let requestId;
  await t.test("a technician submits their own request", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      userId: "T1001",
      body: { type: "vacation", startDate: "2026-06-01", endDate: "2026-06-03", hoursPerDay: 8, notes: "Family trip" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "pending");
    // 2026-06-01 is a Monday, 06-03 a Wednesday -- 3 weekdays * 8h.
    assert.equal(res.body.totalHours, 24);
    assert.equal(res.body.techName, "Alex Rivera", "a real name, not the raw tech id, for display in the approvals queue");
    requestId = res.body.id;
  });

  await t.test("a technician cannot submit a request on behalf of someone else", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      userId: "T1001",
      body: { techId: "T1002", type: "vacation", startDate: "2026-06-01", endDate: "2026-06-01", hoursPerDay: 8 },
    });
    assert.equal(res.status, 403);
  });

  await t.test("the request shows up as pending on the balance, not yet used", async () => {
    const res = await server.call("GET", "/api/time-off/balance/T1001", { userId: "T1001" });
    const vacation = res.body.types.find((t2) => t2.type === "vacation");
    assert.equal(vacation.pending, 24);
    assert.equal(vacation.used, 0);
    assert.equal(vacation.balance, 16); // 40 - 0 - 24
  });

  await t.test("it appears in Kevin's approvals queue (configured approver)", async () => {
    const res = await server.call("GET", "/api/time-off/approvals-queue", { token: kevinToken });
    assert.ok(res.body.some((r) => r.id === requestId));
  });

  await t.test("a technician without approver rights cannot approve", async () => {
    const res = await server.call("PATCH", `/api/time-off/requests/${requestId}`, { userId: "T1001", body: { status: "approved" } });
    assert.equal(res.status, 403);
  });

  await t.test("Kevin approves it; balance moves from pending to used", async () => {
    const res = await server.call("PATCH", `/api/time-off/requests/${requestId}`, { token: kevinToken, body: { status: "approved" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "approved");
    assert.equal(res.body.decidedBy, "KEVIN");

    const balanceRes = await server.call("GET", "/api/time-off/balance/T1001", { userId: "T1001" });
    const vacation = balanceRes.body.types.find((t2) => t2.type === "vacation");
    assert.equal(vacation.used, 24);
    assert.equal(vacation.pending, 0);
    assert.equal(vacation.balance, 16);
  });

  await t.test("the approved request shows on the Schedule calendar's time-off endpoint", async () => {
    const res = await server.call("GET", "/api/schedule/2026-06/time-off", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body["2026-06-01"]);
    assert.ok(res.body["2026-06-01"].some((e) => e.techId === "T1001" && e.type === "vacation"));
    assert.ok(res.body["2026-06-03"]);
    // Weekends in range, if any, should never appear.
  });

  await t.test("a pending request can be cancelled by its own requester", async () => {
    // "vacation" (not "sick") -- T1001's policy only accrues vacation and
    // floating_holiday (see the policy set up above); this test is about
    // the cancel action itself, not balance, so it just uses a type that
    // actually has hours on file. 16h left (40 accrued - 24 already used).
    const createRes = await server.call("POST", "/api/time-off/requests", {
      userId: "T1001",
      body: { type: "vacation", startDate: "2026-07-01", endDate: "2026-07-01", hoursPerDay: 8 },
    });
    const cancelRes = await server.call("PATCH", `/api/time-off/requests/${createRes.body.id}`, {
      userId: "T1001",
      body: { status: "cancelled" },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.status, "cancelled");
  });

  await t.test("a technician cannot see another technician's requests", async () => {
    const res = await server.call("GET", "/api/time-off/requests?techId=T1002", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("deleting a policy unassigns technicians rather than erroring", async () => {
    const delRes = await server.call("DELETE", `/api/time-off/policies/${policyId}`, { userId: "ADMIN" });
    assert.equal(delRes.status, 200);
    const balanceRes = await server.call("GET", "/api/time-off/balance/T1001", { userId: "ADMIN" });
    assert.equal(balanceRes.body.policyId, null);
    assert.equal(balanceRes.body.types.length, 0);
  });

  await t.test("approving a request writes it straight onto the real weekly timecard", () => {
    // requestId (approved earlier, by Kevin) was 2026-06-01 (Mon) to
    // 2026-06-03 (Wed), vacation, 8h/day -- three weekday rows, one week.
    const rows = raw
      .prepare("SELECT day, type, wom_code, hours FROM allocations WHERE tech_id = ? AND week_monday = ? ORDER BY day")
      .all("T1001", "2026-06-01");
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.type, "timeoff");
      assert.equal(r.wom_code, "vacation");
      assert.equal(r.hours, 8);
    }
    assert.deepEqual(rows.map((r) => r.day).sort(), ["Mon", "Tue", "Wed"]);
  });

  await t.test("a request spanning two weeks writes allocation rows into both", async () => {
    // The policy above was deleted (previous test) -- T1001's earlier
    // floating_holiday accrual event is still on file, it's just not
    // currently visible on any balance without a policy/rule covering that
    // type again (see computeTimeOffBalance's own ruleByType filter).
    // Re-assigning one here (no need to re-run accrual) surfaces it again.
    const freshPolicyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: { name: "Re-Assigned", rules: [{ type: "floating_holiday", frequency: "annually", accrueOnDay: 1, rateHours: 16, accrueUntil: "cap", capHours: 16, startRule: "calendar_year" }] },
    });
    await server.call("PATCH", "/api/time-off/technicians/T1001/policy", { userId: "ADMIN", body: { policyId: freshPolicyRes.body.id } });

    const createRes = await server.call("POST", "/api/time-off/requests", {
      userId: "T1001",
      // 2026-06-26 is a Friday (week of 06-22); 2026-06-29 is the following
      // Monday (week of 06-29) -- one request, two different week_monday rows.
      body: { type: "floating_holiday", startDate: "2026-06-26", endDate: "2026-06-29", hoursPerDay: 8 },
    });
    await server.call("PATCH", `/api/time-off/requests/${createRes.body.id}`, { token: kevinToken, body: { status: "approved" } });

    const week1 = raw.prepare("SELECT day FROM allocations WHERE tech_id = ? AND week_monday = ?").all("T1001", "2026-06-22");
    const week2 = raw.prepare("SELECT day FROM allocations WHERE tech_id = ? AND week_monday = ?").all("T1001", "2026-06-29");
    assert.deepEqual(week1.map((r) => r.day).sort(), ["Fri"]); // 2026-06-26 is a Friday in the week of 06-22
    assert.deepEqual(week2.map((r) => r.day).sort(), ["Mon"]); // 2026-06-29 is a Monday
  });

  await t.test("floating_holiday is a recognized time-off type on the normal weekly allocations route", async () => {
    const weekMonday = require("../server/utils/week").currentWeekMonday();
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${weekMonday}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "timeoff", timeOffType: "floating_holiday", hours: 8 }] },
    });
    assert.equal(res.status, 200);
  });
});

// Per Krista: "We should block until they have time on their balance" --
// a request (self-service or admin-on-behalf, same route) can't ask for
// more hours of a type than the technician currently has accrued and not
// already used/pending. A type with no policy/rule covering it at all
// reads as zero balance, same end result as a real shortfall.
test("Time Off: requests are blocked past the technician's own accrued balance", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  // A dedicated tech, not T1001 -- T1001 already carries vacation/
  // floating_holiday accrual history from the earlier test in this file
  // (same shared DB per test file), which would throw off the exact
  // balance numbers asserted here.
  raw
    .prepare("INSERT INTO technicians (id, name, pin, role, active, employment_status, hire_date) VALUES (?, ?, ?, 'tech', 1, 'active', ?)")
    .run("BALTEST", "Bal Test", "hash", "2020-01-01");
  const balTestToken = db.createSession("BALTEST");

  await t.test("no policy assigned at all -- any request is blocked", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      token: balTestToken,
      body: { type: "vacation", startDate: "2026-08-03", endDate: "2026-08-03", hoursPerDay: 8 },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no vacation balance on file/i);
  });

  let policyId;
  await t.test("a policy with a small cap -- a request within it is allowed", async () => {
    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: { name: "Small Cap", rules: [{ type: "vacation", frequency: "annually", accrueOnDay: 1, rateHours: 8, accrueUntil: "cap", capHours: 8, startRule: "calendar_year" }] },
    });
    policyId = policyRes.body.id;
    await server.call("PATCH", "/api/time-off/technicians/BALTEST/policy", { userId: "ADMIN", body: { policyId } });
    await server.call("POST", "/api/time-off/run-accrual", { userId: "ADMIN", body: { asOf: "2026-01-01" } });

    const balanceRes = await server.call("GET", "/api/time-off/balance/BALTEST", { userId: "ADMIN" });
    assert.equal(balanceRes.body.types.find((t2) => t2.type === "vacation").balance, 8);

    const res = await server.call("POST", "/api/time-off/requests", {
      token: balTestToken,
      body: { type: "vacation", startDate: "2026-08-03", endDate: "2026-08-03", hoursPerDay: 8 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  await t.test("a second request that would exceed the now-reduced balance is blocked", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      token: balTestToken,
      body: { type: "vacation", startDate: "2026-08-04", endDate: "2026-08-04", hoursPerDay: 8 },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not enough accrued vacation/i);
  });

  await t.test("admin submitting on the tech's behalf is held to the same cap", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      userId: "ADMIN",
      body: { techId: "BALTEST", type: "vacation", startDate: "2026-08-05", endDate: "2026-08-05", hoursPerDay: 8 },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a type the policy doesn't cover at all is still blocked, not silently allowed", async () => {
    const res = await server.call("POST", "/api/time-off/requests", {
      token: balTestToken,
      body: { type: "sick", startDate: "2026-08-03", endDate: "2026-08-03", hoursPerDay: 8 },
    });
    assert.equal(res.status, 400);
  });
});
