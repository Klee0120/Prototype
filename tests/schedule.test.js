const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("schedule: read-only who's-where-this-week grid", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("requires a logged-in session", async () => {
    const res = await server.call("GET", `/api/schedule/${week}`);
    assert.equal(res.status, 401);
  });

  await t.test("a technician (not just admin) can view the schedule", async () => {
    const res = await server.call("GET", `/api/schedule/${week}`, { userId: "T1002" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((r) => r.techId === "T1001"));
  });

  await t.test("shows E&F, WOM, and time-off assignments with readable labels", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Tue", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", type: "timeoff", timeOffType: "vacation", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const res = await server.call("GET", `/api/schedule/${week}`, { userId: "T1002" });
    const row = res.body.find((r) => r.techId === "T1001");
    assert.ok(row, "expected T1001 in the schedule");

    assert.equal(row.days.Mon.length, 1);
    assert.equal(row.days.Mon[0].kind, "ef");
    assert.match(row.days.Mon[0].label, /Princeton/i);

    assert.equal(row.days.Tue.length, 1);
    assert.equal(row.days.Tue[0].kind, "wom");
    assert.match(row.days.Tue[0].label, /WOM-4471/);

    assert.equal(row.days.Wed.length, 1);
    assert.equal(row.days.Wed[0].kind, "timeoff");
    assert.equal(row.days.Wed[0].label, "Vacation");

    assert.equal(row.days.Thu.length, 0);
  });

  await t.test("only exposes id/name/day assignments, not the rest of the roster profile", async () => {
    const res = await server.call("GET", `/api/schedule/${week}`, { userId: "T1002" });
    const row = res.body.find((r) => r.techId === "T1001");
    const keys = Object.keys(row).sort();
    assert.deepEqual(keys, ["days", "techId", "techName"]);
  });

  await t.test("an inactive technician doesn't show up in the schedule", async () => {
    const deactivate = await server.call("PATCH", "/api/admin/technicians/T1003/employment-status", {
      userId: "ADMIN",
      body: { status: "inactive" },
    });
    assert.equal(deactivate.status, 200);

    const res = await server.call("GET", `/api/schedule/${week}`, { userId: "T1002" });
    assert.ok(!res.body.some((r) => r.techId === "T1003"));

    // Restore for hygiene, in case tests are ever reordered.
    await server.call("PATCH", "/api/admin/technicians/T1003/employment-status", {
      userId: "ADMIN",
      body: { status: "active" },
    });
  });
});
