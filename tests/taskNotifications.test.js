const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("tasks: per-reason email notification preferences (tech and admin alike)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("defaults are all off", async () => {
    const res = await server.call("GET", "/api/technicians/T1001/task-notification-prefs", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.prefs, {
      notify_task_assigned: false,
      notify_task_urgent: false,
      notify_task_wom: false,
      notify_task_po_discrepancy: false,
    });
    assert.ok(Array.isArray(res.body.reasons) && res.body.reasons.length === 4);
  });

  await t.test("a technician cannot read someone else's prefs", async () => {
    const res = await server.call("GET", "/api/technicians/T1002/task-notification-prefs", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("an admin can read anyone's prefs, including another admin's", async () => {
    const res = await server.call("GET", "/api/technicians/T1001/task-notification-prefs", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const selfRes = await server.call("GET", "/api/technicians/ADMIN/task-notification-prefs", { userId: "ADMIN" });
    assert.equal(selfRes.status, 200);
  });

  await t.test("turning one on without an email on file is rejected", async () => {
    // ADMIN (Krista Lee) has no email in seed data, unlike the technicians.
    const res = await server.call("PATCH", "/api/technicians/ADMIN/task-notification-prefs", {
      userId: "ADMIN",
      body: { notify_task_assigned: true },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /email/i);
  });

  await t.test("rejects an unknown reason key", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1001/task-notification-prefs", {
      userId: "T1001",
      body: { not_a_real_reason: true },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can turn their own reasons on and off; partial updates don't clobber the rest", async () => {
    const on = await server.call("PATCH", "/api/technicians/T1001/task-notification-prefs", {
      userId: "T1001",
      body: { notify_task_assigned: true, notify_task_urgent: true },
    });
    assert.equal(on.status, 200);
    assert.equal(on.body.prefs.notify_task_assigned, true);
    assert.equal(on.body.prefs.notify_task_urgent, true);
    assert.equal(on.body.prefs.notify_task_wom, false);

    const partial = await server.call("PATCH", "/api/technicians/T1001/task-notification-prefs", {
      userId: "T1001",
      body: { notify_task_wom: true },
    });
    assert.equal(partial.status, 200);
    // Still true from the earlier call -- a partial update must not reset it.
    assert.equal(partial.body.prefs.notify_task_assigned, true);
    assert.equal(partial.body.prefs.notify_task_wom, true);
  });

  await t.test("a technician cannot change someone else's prefs", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1002/task-notification-prefs", {
      userId: "T1001",
      body: { notify_task_assigned: true },
    });
    assert.equal(res.status, 403);
  });

  await t.test("an admin can turn on prefs for a technician", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1002/task-notification-prefs", {
      userId: "ADMIN",
      body: { notify_task_po_discrepancy: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.prefs.notify_task_po_discrepancy, true);
  });

  await t.test("admins get the same settings too, not just technicians (once they have an email on file)", async () => {
    const withEmail = await server.call("PATCH", "/api/admin/admins/ADMIN/basic-info", {
      userId: "ADMIN",
      body: { email: "krista.lee@example.com" },
    });
    assert.equal(withEmail.status, 200);

    const res = await server.call("PATCH", "/api/technicians/ADMIN/task-notification-prefs", {
      userId: "ADMIN",
      body: { notify_task_urgent: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.prefs.notify_task_urgent, true);
  });

  await t.test("the change is audited", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const entry = audit.body.find((e) => e.action === "TASK_NOTIFICATION_PREFS_CHANGED");
    assert.ok(entry);
  });

  await t.test("an unknown person 404s on both routes", async () => {
    const getRes = await server.call("GET", "/api/technicians/NOBODY/task-notification-prefs", { userId: "ADMIN" });
    assert.equal(getRes.status, 404);
    const patchRes = await server.call("PATCH", "/api/technicians/NOBODY/task-notification-prefs", {
      userId: "ADMIN",
      body: { notify_task_assigned: true },
    });
    assert.equal(patchRes.status, 404);
  });
});

test("tasks: assigning a task never fails even when the assignee is opted into every email reason", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("opt T1001 into every reason", async () => {
    const res = await server.call("PATCH", "/api/technicians/T1001/task-notification-prefs", {
      userId: "T1001",
      body: {
        notify_task_assigned: true,
        notify_task_urgent: true,
        notify_task_wom: true,
        notify_task_po_discrepancy: true,
      },
    });
    assert.equal(res.status, 200);
  });

  // SMTP isn't configured in tests, so this exercises the fire-and-forget
  // mailer.sendMail() call (matching every reason at once: urgent + WOM)
  // without actually sending anything -- the point is creating the task
  // never fails or hangs on it.
  await t.test("creating an urgent task on a WOM, assigned straight to T1001, still succeeds", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: {
        title: "Chase down missing WOM paperwork",
        priority: "high",
        assignedTo: "T1001",
        relatedWomCode: "WOM-4390",
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.assignedTo, "T1001");
  });

  await t.test("reassigning an existing task to T1001 also still succeeds", async () => {
    const created = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Unassigned task to hand off" },
    });
    assert.equal(created.status, 201);

    const reassigned = await server.call("PATCH", `/api/tasks/${created.body.id}/assign`, {
      userId: "ADMIN",
      body: { assignedTo: "T1001" },
    });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.assignedTo, "T1001");
  });

  await t.test("re-saving the same assignee (no actual hand-off) still succeeds", async () => {
    const created = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Already assigned to T1001", assignedTo: "T1001" },
    });
    const resaved = await server.call("PATCH", `/api/tasks/${created.body.id}/assign`, {
      userId: "ADMIN",
      body: { assignedTo: "T1001" },
    });
    assert.equal(resaved.status, 200);
  });
});
