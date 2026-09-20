const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("audit: actions are recorded and only admins can read the log", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("a technician cannot read the audit log", async () => {
    await server.call("POST", "/api/auth/login", { body: { id: "T1001", pin: "1234" } });
    const res = await server.call("GET", "/api/audit", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("login, save, and submit each write an audit entry", async () => {
    await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", womCode: "GEN-ADMIN", hours: 40 }] },
    });
    await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });

    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const actions = res.body.map((e) => e.action);
    assert.ok(actions.includes("LOGIN"));
    assert.ok(actions.includes("ALLOCATIONS_SAVED"));
    assert.ok(actions.includes("WEEK_SUBMITTED"));
    assert.ok(actions.includes("WEEK_APPROVED"));
  });

  await t.test("entries are returned newest first", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const ids = res.body.map((e) => e.id);
    const sorted = [...ids].sort((a, b) => b - a);
    assert.deepEqual(ids, sorted);
  });
});
