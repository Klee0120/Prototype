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

  await t.test("creating a policy with allowances, then reading it back", async () => {
    const res = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: {
        name: "2yr Policy",
        allowances: [
          { type: "vacation", yearlyHours: 80 },
          { type: "sick", yearlyHours: 40 },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.allowances.length, 2);
  });

  await t.test("a technician cannot manage policies", async () => {
    const res = await server.call("GET", "/api/time-off/policies", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  let policyId;
  await t.test("assigning a policy to a technician", async () => {
    const policyRes = await server.call("POST", "/api/time-off/policies", {
      userId: "ADMIN",
      body: { name: "New Hire", allowances: [{ type: "vacation", yearlyHours: 40 }, { type: "floating_holiday", yearlyHours: 16 }] },
    });
    policyId = policyRes.body.id;
    const assignRes = await server.call("PATCH", "/api/time-off/technicians/T1001/policy", { userId: "ADMIN", body: { policyId } });
    assert.equal(assignRes.status, 200);

    const balanceRes = await server.call("GET", "/api/time-off/balance/T1001", { userId: "ADMIN" });
    assert.equal(balanceRes.body.policyName, "New Hire");
    assert.equal(balanceRes.body.types.length, 2);
    const vacation = balanceRes.body.types.find((t2) => t2.type === "vacation");
    assert.equal(vacation.yearlyHours, 40);
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
    const createRes = await server.call("POST", "/api/time-off/requests", {
      userId: "T1001",
      body: { type: "sick", startDate: "2026-07-01", endDate: "2026-07-01", hoursPerDay: 8 },
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
});
