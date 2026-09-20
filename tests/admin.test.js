const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

async function submitFullWeek(server, techId, week, ukgHours) {
  await server.call("PUT", `/api/technicians/${techId}/weeks/${week}/allocations`, {
    userId: techId,
    body: { allocations: [{ day: "Mon", womCode: "GEN-ADMIN", hours: ukgHours }] },
  });
  return server.call("POST", `/api/technicians/${techId}/weeks/${week}/submit`, { userId: techId });
}

test("admin: review, approve, reject, unlock", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("non-admin cannot access the admin review list", async () => {
    const res = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("cannot approve a week that hasn't been submitted", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("approve locks a submitted week", async () => {
    const submit = await submitFullWeek(server, "T1001", week, 40);
    assert.equal(submit.status, 200);

    const approve = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, "approved");

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.status, "approved");
    assert.equal(detail.body.locked, true);
  });

  await t.test("cannot approve the same week twice", async () => {
    const res = await server.call("POST", `/api/admin/weeks/T1001/${week}/approve`, { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("unlock returns an approved week to draft and editable", async () => {
    const unlock = await server.call("POST", `/api/admin/weeks/T1001/${week}/unlock`, { userId: "ADMIN" });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.status, "draft");

    const edit = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [] },
    });
    assert.equal(edit.status, 200);
  });

  await t.test("reject returns a submitted week to the technician with a note", async () => {
    const submit = await submitFullWeek(server, "T1002", week, 37.5);
    assert.equal(submit.status, 200);

    const reject = await server.call("POST", `/api/admin/weeks/T1002/${week}/reject`, {
      userId: "ADMIN",
      body: { note: "Wrong WOM, please redo." },
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const detail = await server.call("GET", `/api/technicians/T1002/weeks/${week}`, { userId: "T1002" });
    assert.equal(detail.body.status, "rejected");
    assert.equal(detail.body.locked, false);
    assert.equal(detail.body.note, "Wrong WOM, please redo.");
  });

  await t.test("admin review list reflects current statuses and hour totals", async () => {
    const res = await server.call("GET", `/api/admin/weeks/${week}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const t1001 = res.body.find((r) => r.technician.id === "T1001");
    const t1002 = res.body.find((r) => r.technician.id === "T1002");
    assert.equal(t1001.status, "draft");
    assert.equal(t1002.status, "rejected");
    assert.equal(t1002.ukgHours, 37.5);
  });
});
