const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("allocation: a technician must confirm their own week before it submits", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  async function fillWeek(techId, userId) {
    const detail = await server.call("GET", `/api/technicians/${techId}/weeks/${week}`, { userId });
    const allocations = Object.entries(detail.body.ukgHoursByDay)
      .filter(([, hours]) => hours > 0)
      .map(([day, hours]) => ({ day, type: "ef", locationCode: "CINCINNATI", hours }));
    return server.call("PUT", `/api/technicians/${techId}/weeks/${week}/allocations`, { userId, body: { allocations } });
  }

  await t.test("submitting your own week without confirming is rejected", async () => {
    const put = await fillWeek("T1001", "T1001");
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 400);
    assert.match(submit.body.error, /confirm/i);

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.status, "draft", "the week should still be unsubmitted");
  });

  await t.test("confirmed: false is treated the same as not confirming at all", async () => {
    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, {
      userId: "T1001",
      body: { confirmed: false },
    });
    assert.equal(submit.status, 400);
  });

  await t.test("confirming lets it submit, and records the attestation timestamp", async () => {
    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, {
      userId: "T1001",
      body: { confirmed: true },
    });
    assert.equal(submit.status, 200);

    const detail = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(detail.body.status, "submitted");
    assert.ok(detail.body.techConfirmedAt, "expected techConfirmedAt to be set");
  });

  await t.test("the audit entry notes the technician's own confirmation", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = audit.body.find((e) => e.action === "WEEK_SUBMITTED" && /confirming allocations reflect work performed/.test(e.details));
    assert.ok(entry, "expected a WEEK_SUBMITTED entry noting the technician's confirmation");
  });

  await t.test("an admin submitting on a technician's behalf needs no confirmation, and leaves techConfirmedAt unset", async () => {
    const put = await fillWeek("T1002", "ADMIN");
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${week}/submit`, { userId: "ADMIN" });
    assert.equal(submit.status, 200);

    const detail = await server.call("GET", `/api/technicians/T1002/weeks/${week}`, { userId: "ADMIN" });
    assert.equal(detail.body.status, "submitted");
    assert.equal(detail.body.techConfirmedAt, null);
  });
});
