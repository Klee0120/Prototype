const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SMARTSHEET_API_TOKEN = "test-token";
process.env.SMARTSHEET_SHEET_ID = "6392545882886020";

const { startServer } = require("./helpers");

function stubFetchOnce(response) {
  const original = global.fetch;
  global.fetch = async (url, ...rest) => {
    if (typeof url === "string" && url.startsWith("https://api.smartsheet.com/")) return response;
    return original(url, ...rest);
  };
  return () => {
    global.fetch = original;
  };
}

const COLUMNS = [
  { id: 1, title: "WOM #" },
  { id: 4, title: "Project Name" },
];

function sheetWith(rows) {
  return { name: "Midwest PSE Request Tracker", columns: COLUMNS, rows };
}

async function syncOneOpenWom(server, code, rowId) {
  const restore = stubFetchOnce({
    ok: true,
    json: async () =>
      sheetWith([{ id: rowId, cells: [{ columnId: 1, value: code, displayValue: code }, { columnId: 4, value: "Test job", displayValue: "Test job" }] }]),
  });
  try {
    const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    return res.body;
  } finally {
    restore();
  }
}

test("task engine: manual tasks, statuses, comments, and role scoping", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let taskId;

  await t.test("admin creates a manual task assigned to a technician", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Check the ladder", description: "Inspect before next job", assignedTo: "T1001", priority: "high" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, "Check the ladder");
    assert.equal(res.body.assignedTo, "T1001");
    assert.ok(res.body.assignedToName, "expected the assignee's name to be resolved");
    assert.equal(res.body.status, "open");
    assert.equal(res.body.source, "manual");
    assert.ok(res.body.createdAt);
    taskId = res.body.id;
  });

  await t.test("title is required", async () => {
    const res = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { description: "no title" } });
    assert.equal(res.status, 400);
  });

  await t.test("an unknown WOM code is rejected", async () => {
    const res = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "x", relatedWomCode: "NOPE" } });
    assert.equal(res.status, 400);
  });

  await t.test("the assigned technician sees it under My Work", async () => {
    const res = await server.call("GET", "/api/tasks?view=my", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((t2) => t2.id === taskId));
  });

  await t.test("a different technician does not see it under My Work", async () => {
    const res = await server.call("GET", "/api/tasks?view=my", { userId: "T1002" });
    assert.ok(!res.body.some((t2) => t2.id === taskId));
  });

  await t.test("a technician can't fetch a task that isn't theirs", async () => {
    const res = await server.call("GET", `/api/tasks/${taskId}`, { userId: "T1002" });
    assert.equal(res.status, 403);
  });

  await t.test("the assigned technician can move it to in_progress, setting startedAt", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/status`, { userId: "T1001", body: { status: "in_progress" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "in_progress");
    assert.ok(res.body.startedAt);
  });

  await t.test("an invalid status is rejected", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/status`, { userId: "T1001", body: { status: "bogus" } });
    assert.equal(res.status, 400);
  });

  await t.test("the technician completes it, setting completedAt", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/status`, { userId: "T1001", body: { status: "completed" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "completed");
    assert.ok(res.body.completedAt);
  });

  await t.test("it now shows up under the Completed view but not My Work", async () => {
    const completed = await server.call("GET", "/api/tasks?view=completed", { userId: "T1001" });
    assert.ok(completed.body.some((t2) => t2.id === taskId));
    const my = await server.call("GET", "/api/tasks?view=my", { userId: "T1001" });
    assert.ok(!my.body.some((t2) => t2.id === taskId));
  });

  await t.test("a technician can comment on their own task", async () => {
    const res = await server.call("POST", `/api/tasks/${taskId}/comments`, { userId: "T1001", body: { body: "Done, ladder is fine." } });
    assert.equal(res.status, 201);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].body, "Done, ladder is fine.");
  });

  await t.test("an empty comment is rejected", async () => {
    const res = await server.call("POST", `/api/tasks/${taskId}/comments`, { userId: "T1001", body: { body: "   " } });
    assert.equal(res.status, 400);
  });

  await t.test("a technician creating their own task can't assign it to someone else", async () => {
    const res = await server.call("POST", "/api/tasks", { userId: "T1002", body: { title: "Self task", assignedTo: "T1003" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.assignedTo, "T1002");
    assert.equal(res.body.assignedRole, "tech");
  });

  await t.test("only an admin can reassign a task", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/assign`, { userId: "T1001", body: { assignedTo: "T1002" } });
    assert.equal(res.status, 403);
  });

  await t.test("admin reassigns the task", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/assign`, { userId: "ADMIN", body: { assignedTo: "T1002" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.assignedTo, "T1002");
  });

  await t.test("assigning to an unknown employee is rejected", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/assign`, { userId: "ADMIN", body: { assignedTo: "NOBODY" } });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can't view the admin-only Unassigned queue", async () => {
    const res = await server.call("GET", "/api/tasks?view=unassigned", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can filter tasks by assignee", async () => {
    const res = await server.call("GET", "/api/tasks?assignedTo=T1002", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.every((t2) => t2.assignedTo === "T1002"));
  });

  await t.test("admin's dashboard summary counts high-priority open tasks", async () => {
    const res = await server.call("GET", "/api/tasks/summary", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.highPriority === "number");
    assert.ok(typeof res.body.overdue === "number");
    assert.ok(typeof res.body.dueToday === "number");
    assert.ok(typeof res.body.waiting === "number");
    assert.ok(typeof res.body.recurring === "number");
    assert.ok(typeof res.body.exceptions === "number");
  });

  await t.test("an emergency-priority task always reads as the top urgency tier and counts as high priority", async () => {
    const before = await server.call("GET", "/api/tasks/summary", { userId: "ADMIN" });
    const res = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "Urgent PO entered", priority: "emergency" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.priority, "emergency");
    assert.equal(res.body.urgency, "emergency");

    const after = await server.call("GET", "/api/tasks/summary", { userId: "ADMIN" });
    assert.equal(after.body.highPriority, before.body.highPriority + 1);
  });

  await t.test("an invalid priority is rejected", async () => {
    const res = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "x", priority: "bogus" } });
    assert.equal(res.status, 400);
  });
});

test("task engine: editing a hand-added task (title/type/priority/due date/related WOM, vendor, employee)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let taskId;
  let vendorId;

  await t.test("set up: a manual task and a vendor to relate it to", async () => {
    const taskRes = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "Update COI", description: "old desc" } });
    assert.equal(taskRes.status, 201);
    taskId = taskRes.body.id;

    const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Acme Fire & Safety" } });
    assert.equal(vendorRes.status, 201);
    vendorId = vendorRes.body.id;
  });

  await t.test("admin edits title, type, priority, due date, and links a vendor", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, {
      userId: "ADMIN",
      body: {
        title: "Update COI -- renewal",
        description: "new desc",
        category: "vendor_compliance",
        priority: "high",
        dueAt: "2026-11-01",
        dueTime: "09:00",
        relatedVendorId: vendorId,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "Update COI -- renewal");
    assert.equal(res.body.description, "new desc");
    assert.equal(res.body.category, "vendor_compliance");
    assert.equal(res.body.priority, "high");
    assert.equal(res.body.dueAt, "2026-11-01T09:00");
    assert.equal(res.body.relatedVendorId, vendorId);
    assert.equal(res.body.relatedVendorName, "Acme Fire & Safety");
  });

  await t.test("fields left out of the request keep their current value", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "ADMIN", body: { priority: "urgent" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.priority, "urgent");
    assert.equal(res.body.title, "Update COI -- renewal", "title should be unchanged");
    assert.equal(res.body.relatedVendorId, vendorId, "vendor link should be unchanged");
  });

  await t.test("linking an employee instead, and clearing the vendor", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, {
      userId: "ADMIN",
      body: { relatedVendorId: null, relatedTechId: "T1001" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedVendorId, null);
    assert.equal(res.body.relatedTechId, "T1001");
    assert.ok(res.body.relatedTechName, "expected the related employee's name to be resolved");
  });

  await t.test("linking to a real WOM", async () => {
    await server.call("POST", "/api/woms", { userId: "ADMIN", body: { code: "WOM-EDIT-1", description: "Edit-link test" } });
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "ADMIN", body: { relatedWomCode: "WOM-EDIT-1" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedWomCode, "WOM-EDIT-1");
  });

  await t.test("an unknown WOM code is rejected", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "ADMIN", body: { relatedWomCode: "NOPE-1" } });
    assert.equal(res.status, 400);
  });

  await t.test("an invalid priority is rejected", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "ADMIN", body: { priority: "bogus" } });
    assert.equal(res.status, 400);
  });

  await t.test("clearing the title is rejected", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "ADMIN", body: { title: "" } });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can edit their own hand-added task", async () => {
    const own = await server.call("POST", "/api/tasks", { userId: "T1001", body: { title: "My own follow-up" } });
    assert.equal(own.status, 201);
    const res = await server.call("PATCH", `/api/tasks/${own.body.id}`, { userId: "T1001", body: { title: "My own follow-up (updated)" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "My own follow-up (updated)");
  });

  await t.test("a technician can't edit someone else's hand-added task", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}`, { userId: "T1002", body: { title: "hijacked" } });
    assert.equal(res.status, 403);
  });

  await t.test("a technician can't edit an automated WOM-workflow task", async () => {
    await syncOneOpenWom(server, "20500001", 9001);
    const list = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const autoTask = list.body.find((x) => x.relatedWomCode === "20500001");
    assert.ok(autoTask, "expected the WOM sync to have created a workflow task");
    const res = await server.call("PATCH", `/api/tasks/${autoTask.id}`, { userId: "T1001", body: { title: "hijacked" } });
    assert.equal(res.status, 403);
  });

  await t.test("editing an unknown task 404s", async () => {
    const res = await server.call("PATCH", "/api/tasks/999999", { userId: "ADMIN", body: { title: "x" } });
    assert.equal(res.status, 404);
  });
});

test("task engine: overdue, waiting, and exception views", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let overdueId;

  await t.test("create an overdue task and a waiting task", async () => {
    const overdue = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Overdue thing", assignedTo: "T1001", dueAt: "2000-01-01" },
    });
    assert.equal(overdue.status, 201);
    overdueId = overdue.body.id;

    const waiting = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "Waiting thing", assignedTo: "T1001" } });
    await server.call("PATCH", `/api/tasks/${waiting.body.id}/status`, { userId: "ADMIN", body: { status: "waiting" } });
  });

  await t.test("the overdue task shows up under Overdue", async () => {
    const res = await server.call("GET", "/api/tasks?view=overdue", { userId: "ADMIN" });
    assert.ok(res.body.some((t2) => t2.id === overdueId));
    assert.equal(res.body.find((t2) => t2.id === overdueId).urgency, "urgent");
  });

  await t.test("the waiting task shows up under Waiting", async () => {
    const res = await server.call("GET", "/api/tasks?view=waiting", { userId: "ADMIN" });
    assert.ok(res.body.some((t2) => t2.status === "waiting"));
  });
});

test("task engine: recurring tasks are idempotent within the same period", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  let recurringIds;

  await t.test("first load generates the recurring tasks", async () => {
    const res = await server.call("GET", "/api/tasks?view=recurring", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
    recurringIds = res.body.map((t2) => t2.id).sort();
  });

  await t.test("loading again does not create duplicates", async () => {
    const res = await server.call("GET", "/api/tasks?view=recurring", { userId: "ADMIN" });
    assert.deepEqual(res.body.map((t2) => t2.id).sort(), recurringIds);
  });

  await t.test("completing one and reloading does not un-complete it", async () => {
    const target = recurringIds[0];
    await server.call("PATCH", `/api/tasks/${target}/status`, { userId: "ADMIN", body: { status: "completed" } });
    const res = await server.call("GET", "/api/tasks?view=recurring", { userId: "ADMIN" });
    assert.equal(res.body.find((t2) => t2.id === target).status, "completed");
  });
});

test("task engine: WOM sync creates one persistent lifecycle task that tracks the checklist's next step", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a synced WOM gets one lifecycle task, assigned to the reviewer role (its first step)", async () => {
    await syncOneOpenWom(server, "40000001", 950);
    const res = await server.call("GET", "/api/tasks?view=team&role=reviewer", { userId: "ADMIN" });
    const task = res.body.find((t2) => t2.relatedWomCode === "40000001");
    assert.ok(task, "expected a lifecycle task for the synced WOM");
    assert.equal(task.sourceKey, "WOM-40000001-LIFECYCLE");
    assert.equal(task.source, "wom_workflow");
    assert.equal(task.category, "wom_workflow");
    assert.equal(task.assignedRole, "reviewer");
    // Nothing's been sent to Toyota yet -- this should read as High so it
    // doesn't get buried behind Normal-priority tasks with an earlier due
    // date.
    assert.equal(task.priority, "high");
  });

  await t.test("re-syncing the same row doesn't duplicate the task", async () => {
    await syncOneOpenWom(server, "40000001", 950);
    const res = await server.call("GET", "/api/tasks?view=team&role=reviewer&status=open", { userId: "ADMIN" });
    const matches = res.body.filter((t2) => t2.relatedWomCode === "40000001");
    assert.equal(matches.length, 1);
  });

  await t.test("completing the reviewer step moves the same task's role to financial (its next step)", async () => {
    const advance = await server.call("POST", "/api/woms/40000001/lifecycle/sent_to_toyota", {
      userId: "ADMIN",
      body: { toyotaEmail: "toyota@example.com" },
    });
    assert.equal(advance.status, 200);
    assert.equal(advance.body.lifecycleSteps.find((s) => s.key === "sent_to_toyota").completedAt !== null, true);

    const res = await server.call("GET", "/api/tasks?view=team&role=financial", { userId: "ADMIN" });
    const task = res.body.find((t2) => t2.sourceKey === "WOM-40000001-LIFECYCLE");
    assert.ok(task, "expected the same task to now show under the financial role");
    assert.equal(task.status, "open");
    // Sent to Toyota now, no change order, no PO-less contracted spend yet
    // -- back down to Normal.
    assert.equal(task.priority, "normal");
  });

  await t.test("a hand-entered Maximo/PO # auto-completes 'Create WOM & PO' and advances the task to the tech role", async () => {
    const res = await server.call("PATCH", "/api/woms/40000001/details", {
      userId: "ADMIN",
      body: { description: "Test job", maximoNumber: "PO-999", locationCode: "PRINCETON" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.lifecycleSteps.find((s) => s.key === "wom_po_created").completedAt);

    const tasks = await server.call("GET", "/api/tasks?view=team&role=tech", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.sourceKey === "WOM-40000001-LIFECYCLE");
    assert.ok(task, "expected the task to now be assigned to the tech role (Schedule vendor)");
  });

  await t.test("a tech putting the WOM on their calendar auto-completes 'Schedule vendor'", async () => {
    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/schedule-wom`, {
      userId: "T1001",
      body: { day: "Mon", allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "40000001", hours: 4 }] },
    });
    assert.equal(put.status, 200);

    // The check runs lazily on the next task-list read (same pattern as
    // ensureRecurringTasks), not on the allocation write itself.
    const res = await server.call("GET", "/api/woms/40000001/lookup", { userId: "ADMIN" });
    await server.call("GET", "/api/tasks", { userId: "ADMIN" });
    const after = await server.call("GET", "/api/woms/40000001/lookup", { userId: "ADMIN" });
    assert.ok(!res.body.lifecycleSteps.find((s) => s.key === "vendor_scheduled").completedAt, "should not be complete before the catch-up read");
    assert.ok(after.body.lifecycleSteps.find((s) => s.key === "vendor_scheduled").completedAt, "should be complete after the catch-up read");
  });

  await t.test("tech-complete auto-completes 'Work complete' and applied cost auto-completes 'Post applied cost'", async () => {
    const complete = await server.call("POST", "/api/woms/40000001/complete", { userId: "T1001" });
    assert.equal(complete.status, 200);
    assert.ok(complete.body.lifecycleSteps.find((s) => s.key === "work_complete").completedAt);

    const pricing = await server.call("PATCH", "/api/woms/40000001/pricing", { userId: "ADMIN", body: { appliedPrice: 500 } });
    assert.equal(pricing.status, 200);
    assert.ok(pricing.body.lifecycleSteps.find((s) => s.key === "cost_applied").completedAt);
  });

  await t.test("'Review charges' can be completed by either role -- a technician can't take it", async () => {
    const asTech = await server.call("POST", "/api/woms/40000001/lifecycle/charges_reviewed", { userId: "T1001" });
    assert.equal(asTech.status, 403);

    const asAdmin = await server.call("POST", "/api/woms/40000001/lifecycle/charges_reviewed", { userId: "ADMIN" });
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.lifecycleSteps.find((s) => s.key === "charges_reviewed").completedAt);
  });

  await t.test("invoicing requires both a batch # and an invoice #", async () => {
    const missing = await server.call("POST", "/api/woms/40000001/lifecycle/invoiced", { userId: "ADMIN", body: { batchNumber: "B1" } });
    assert.equal(missing.status, 400);
  });

  await t.test("invoicing completes the checklist, flips the WOM to invoiced, and completes the task", async () => {
    const res = await server.call("POST", "/api/woms/40000001/lifecycle/invoiced", {
      userId: "ADMIN",
      body: { batchNumber: "B1", invoiceNumber: "INV-1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "invoiced");
    assert.equal(res.body.batchNumber, "B1");
    assert.equal(res.body.invoiceNumber, "INV-1");
    assert.ok(res.body.lifecycleSteps.every((s) => s.completedAt), "expected every step to be complete");

    const tasks = await server.call("GET", "/api/tasks?view=team&status=completed", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.sourceKey === "WOM-40000001-LIFECYCLE");
    assert.ok(task, "expected the lifecycle task to be marked completed");
  });

  await t.test("completing an already-done step is rejected", async () => {
    const res = await server.call("POST", "/api/woms/40000001/lifecycle/charges_reviewed", { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("completing an unknown step is rejected", async () => {
    const res = await server.call("POST", "/api/woms/40000001/lifecycle/nope", { userId: "ADMIN" });
    assert.equal(res.status, 400);
  });

  await t.test("trying to manually complete an auto-trigger step is rejected", async () => {
    const res = await server.call("POST", "/api/woms/40000001/lifecycle/wom_po_created", { userId: "ADMIN" });
    assert.equal(res.status, 400);
  });

  await t.test("a technician can't view WOM history", async () => {
    const res = await server.call("GET", "/api/woms/40000001/history", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("a cost overage after 'Post applied cost' flags the task as a Toyota change order, High priority", async () => {
    await syncOneOpenWom(server, "40000004", 960);
    // A Maximo/PO # already on file -- isolates this test to the change-
    // order condition specifically, without also tripping the separate
    // "needs change order or PO" case for having no PO at all.
    await server.call("PATCH", "/api/woms/40000004/details", {
      userId: "ADMIN",
      body: { description: "Test job", maximoNumber: "PO-4004" },
    });
    await server.call("PATCH", "/api/woms/40000004/pricing", { userId: "ADMIN", body: { estimatedPrice: 1000, appliedPrice: 1000 } });
    // Not scoped to any one role -- applying pricing this early auto-
    // completes "Post applied cost" out of order (ahead of sent_to_toyota),
    // which per the furthest-progress rule can legitimately move the task's
    // queue role forward too; the role itself isn't what this test is about.
    let tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    let task = tasks.body.find((t2) => t2.sourceKey === "WOM-40000004-LIFECYCLE");
    assert.equal(task.priority, "high", "still pending sent_to_toyota, no overage yet");
    assert.ok(!task.title.includes("change order"));

    // The applied cost comes in higher than what was originally estimated
    // -- Toyota needs to sign off on the difference.
    const res = await server.call("PATCH", "/api/woms/40000004/pricing", { userId: "ADMIN", body: { estimatedPrice: 1000, appliedPrice: 1400 } });
    assert.equal(res.status, 200);

    tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    task = tasks.body.find((t2) => t2.sourceKey === "WOM-40000004-LIFECYCLE");
    assert.equal(task.priority, "high");
    assert.ok(task.title.includes("Needs change order or PO"));
    assert.equal(task.assignedRole, "reviewer", "a Toyota paperwork gap routes straight to RFM");
    assert.equal(task.isException, true);

    // Correcting the applied price back in line clears the flag -- it's
    // re-derived live every time, not stamped once and stuck.
    const corrected = await server.call("PATCH", "/api/woms/40000004/pricing", { userId: "ADMIN", body: { estimatedPrice: 1000, appliedPrice: 1000 } });
    assert.equal(corrected.status, 200);
    tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    task = tasks.body.find((t2) => t2.sourceKey === "WOM-40000004-LIFECYCLE");
    assert.ok(!task.title.includes("change order"));
    assert.equal(task.isException, false);
  });
});

test("WOM lifecycle: a step completing out of order moves the task's queue role forward", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a WOM synced in with a Maximo/PO # already on file routes straight to the tech queue, not RFM", async () => {
    // Most of the existing backlog looks exactly like this on day one of
    // the checklist feature: Toyota's already approved a real PO, but
    // nobody's gone back and clicked "Send PSE to Toyota" in this app to
    // log it. The task should reflect the real progress (PO's in hand,
    // waiting on a tech to schedule it) rather than getting stuck showing
    // as the RFM's problem forever just because step 1's box was never
    // checked.
    const created = await syncOneOpenWom(server, "70000001", 990);
    await server.call("PATCH", "/api/woms/70000001/details", {
      userId: "ADMIN",
      body: { description: "Test job", maximoNumber: "PO-777", locationCode: "PRINCETON" },
    });

    const tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.sourceKey === "WOM-70000001-LIFECYCLE");
    assert.ok(task, "expected a lifecycle task for the synced WOM");
    assert.equal(task.assignedRole, "tech", "wom_po_created is done, so the next real gap is scheduling the vendor");

    const wom = await server.call("GET", "/api/woms/70000001/lookup", { userId: "ADMIN" });
    assert.ok(wom.body.lifecycleSteps.find((s) => s.key === "wom_po_created").completedAt);
    assert.ok(!wom.body.lifecycleSteps.find((s) => s.key === "sent_to_toyota").completedAt, "sent_to_toyota is still genuinely unlogged");
  });

  await t.test("once every step after the gap is also done, the task falls back to the lingering earlier gap instead of closing", async () => {
    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/schedule-wom`, {
      userId: "T1001",
      body: { day: "Mon", allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "70000001", hours: 4 }] },
    });
    assert.equal(put.status, 200);
    await server.call("GET", "/api/tasks", { userId: "ADMIN" }); // lazy catch-up
    await server.call("POST", "/api/woms/70000001/complete", { userId: "T1001" });
    await server.call("PATCH", "/api/woms/70000001/pricing", { userId: "ADMIN", body: { appliedPrice: 400 } });
    await server.call("POST", "/api/woms/70000001/lifecycle/charges_reviewed", { userId: "ADMIN" });
    const invoiced = await server.call("POST", "/api/woms/70000001/lifecycle/invoiced", {
      userId: "ADMIN",
      body: { batchNumber: "B9", invoiceNumber: "INV-9" },
    });
    assert.equal(invoiced.status, 200);

    // Every step except sent_to_toyota is now done -- the task must NOT
    // silently complete (it's still missing that one record), and it
    // should fall back to routing to whoever owns that lingering gap.
    const tasks = await server.call("GET", "/api/tasks?view=team&status=open", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.sourceKey === "WOM-70000001-LIFECYCLE");
    assert.ok(task, "expected the lifecycle task to still be open, not completed");
    assert.equal(task.assignedRole, "reviewer");
  });
});

test("WOM lifecycle: a vendor-only job with a request date and applied cost but no PO -- real-world shape", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const COLUMNS_WITH_REQUESTED_DATE = [
    { id: 1, title: "WOM #" },
    { id: 3, title: "Applied WOM $ - Project Summary" },
    { id: 4, title: "Project Name" },
    { id: 5, title: "Date Requested" },
  ];
  function sheetWithDateRequested(rows) {
    return { name: "Midwest PSE Request Tracker", columns: COLUMNS_WITH_REQUESTED_DATE, rows };
  }

  await t.test(
    "a WOM with a Date Requested and an applied cost, but no Maximo #, auto-completes everything except " +
      "wom_po_created and flags a Toyota paperwork gap",
    async () => {
      const restore = stubFetchOnce({
        ok: true,
        json: async () =>
          sheetWithDateRequested([
            {
              id: 900,
              cells: [
                { columnId: 1, value: "20552227", displayValue: "20552227" },
                { columnId: 3, value: 450, displayValue: "$450.00" },
                { columnId: 4, value: "Vendor-only repair job", displayValue: "Vendor-only repair job" },
                { columnId: 5, value: "2026-08-15", displayValue: "8/15/2026" },
              ],
            },
          ]),
      });
      try {
        const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
        assert.equal(res.status, 200);
      } finally {
        restore();
      }

      const wom = await server.call("GET", "/api/woms/20552227/lookup", { userId: "ADMIN" });
      assert.equal(wom.status, 200);
      const stepDone = (key) => Boolean(wom.body.lifecycleSteps.find((s) => s.key === key).completedAt);
      // A request date on file is proof enough Toyota already approved
      // this, even though nobody clicked "Send PSE to Toyota" in this app.
      assert.ok(stepDone("sent_to_toyota"), "sent_to_toyota should auto-complete from the tracker's own Date Requested column");
      // No Maximo/PO # ever arrived for this row -- correctly still open,
      // and exactly what should get flagged below.
      assert.ok(!stepDone("wom_po_created"));
      // Cost has been applied -- for a vendor-only job with no internal
      // technician hours ever logged against it, that alone is proof the
      // work was scheduled and finished.
      assert.ok(stepDone("vendor_scheduled"), "an applied cost implies the vendor was scheduled, even with no internal allocation on file");
      assert.ok(stepDone("work_complete"), "an applied cost implies the work is done");
      assert.ok(stepDone("cost_applied"));
      assert.ok(!stepDone("charges_reviewed"));
      assert.ok(!stepDone("invoiced"));

      const tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
      const task = tasks.body.find((t2) => t2.sourceKey === "WOM-20552227-LIFECYCLE");
      assert.ok(task, "expected a lifecycle task for this WOM");
      assert.ok(task.title.includes("Needs change order or PO"), "an applied cost with no PO on file is a Toyota paperwork gap");
      assert.equal(task.assignedRole, "reviewer", "a Toyota paperwork gap routes straight to RFM regardless of checklist progress");
      assert.equal(task.priority, "high");
      assert.equal(task.isException, true);

      // Once a real Maximo/PO # lands, the gap closes and the task moves on
      // to the next genuinely open step -- Review charges, a shared step
      // with no role gate.
      const patched = await server.call("PATCH", "/api/woms/20552227/details", {
        userId: "ADMIN",
        body: { description: "Vendor-only repair job", maximoNumber: "PO-22227" },
      });
      assert.equal(patched.status, 200);
      const after = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
      const taskAfter = after.body.find((t2) => t2.sourceKey === "WOM-20552227-LIFECYCLE");
      assert.ok(!taskAfter.title.includes("Needs change order or PO"));
      assert.equal(taskAfter.assignedRole, null, "Review charges has no single role -- either RFM or Admin can take it");
      // Work is already done -- invoicing what's left is still worth
      // flagging, even with no paperwork gap anymore.
      assert.equal(taskAfter.priority, "high");
    }
  );
});

test("WOM lifecycle: recording the Toyota email/date sent, and the cost summary", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  await syncOneOpenWom(server, "40000002", 951);

  await t.test("sent_to_toyota without an email is rejected -- it's required to complete this step", async () => {
    const res = await server.call("POST", "/api/woms/40000002/lifecycle/sent_to_toyota", { userId: "ADMIN" });
    assert.equal(res.status, 400);
  });

  await t.test("sent_to_toyota records the Toyota email and sent date", async () => {
    const res = await server.call("POST", "/api/woms/40000002/lifecycle/sent_to_toyota", {
      userId: "ADMIN",
      body: { toyotaEmail: "toyota.contact@toyota.com", sentAt: "2026-03-01T09:00:00.000Z" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseToyotaEmail, "toyota.contact@toyota.com");
    assert.equal(res.body.pseToyotaSentAt, "2026-03-01T09:00:00.000Z");
  });

  // Rescheduling when a step needs to be followed up later isn't a
  // lifecycle-specific concept anymore -- it's just editing the one
  // persistent task's own due date, the same as any other task (see the
  // general PATCH /api/tasks/:id edit tests).

  await t.test("cost summary totals estimated/applied across every non-cancelled WOM", async () => {
    await syncOneOpenWom(server, "40000003", 952);
    await server.call("PATCH", "/api/woms/40000002/pricing", { userId: "ADMIN", body: { estimatedPrice: 5000, appliedPrice: 3000 } });
    await server.call("PATCH", "/api/woms/40000003/pricing", { userId: "ADMIN", body: { estimatedPrice: 1000, appliedPrice: 1500 } });

    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.totalEstimated >= 6000);
    assert.ok(res.body.totalApplied >= 4500);
  });

  await t.test("a WOM with estimate > applied counts as overquoted, with the overage amount", async () => {
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const entry = res.body.overquoted.find((o) => o.code === "40000002");
    assert.ok(entry, "expected 40000002 (est 5000 > applied 3000) in the overquoted list");
    assert.equal(entry.overage, 2000);
    // 40000003 (est 1000 < applied 1500) should NOT be in the overquoted list.
    assert.ok(!res.body.overquoted.some((o) => o.code === "40000003"));
  });

  await t.test("a WOM with an applied price but no Maximo #/PO shows up in appliedNoPo", async () => {
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    assert.ok(res.body.appliedNoPo.some((o) => o.code === "40000002"));
  });

  await t.test("a technician can't view the cost summary", async () => {
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});

test("WOM lifecycle: labor/contracted-services breakdown and vendor cost analysis", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const ITEMIZED_COLUMNS = [
    { id: 1, title: "WOM #" },
    { id: 4, title: "Project Name" },
    { id: 8, title: "Maximo #" },
    { id: 9, title: "Estimate Labor $" },
    { id: 10, title: "Estimate PO $ - Contracted Services" },
    { id: 11, title: "Applied Labor $" },
    { id: 12, title: "Applied PO $ - Contracted Services" },
    { id: 13, title: "Vendor(s) Name/#/Phone" },
  ];
  function itemizedSheet(rows) {
    return { name: "Midwest PSE Request Tracker", columns: ITEMIZED_COLUMNS, rows };
  }
  async function syncItemizedRow(rowId, fields) {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        itemizedSheet([
          {
            id: rowId,
            cells: [
              { columnId: 1, value: fields.code, displayValue: fields.code },
              { columnId: 4, value: fields.description || "Test job", displayValue: fields.description || "Test job" },
              ...(fields.maximoNumber ? [{ columnId: 8, value: fields.maximoNumber, displayValue: fields.maximoNumber }] : []),
              ...(fields.estimatedLabor != null ? [{ columnId: 9, value: fields.estimatedLabor, displayValue: String(fields.estimatedLabor) }] : []),
              ...(fields.estimatedContracted != null
                ? [{ columnId: 10, value: fields.estimatedContracted, displayValue: String(fields.estimatedContracted) }]
                : []),
              ...(fields.appliedLabor != null ? [{ columnId: 11, value: fields.appliedLabor, displayValue: String(fields.appliedLabor) }] : []),
              ...(fields.appliedContracted != null
                ? [{ columnId: 12, value: fields.appliedContracted, displayValue: String(fields.appliedContracted) }]
                : []),
              ...(fields.vendorText ? [{ columnId: 13, value: fields.vendorText, displayValue: fields.vendorText }] : []),
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      return res.body;
    } finally {
      restore();
    }
  }

  let vendorId;
  await t.test("setup: create the vendor these WOMs will match by name", async () => {
    const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Acme Mechanical" } });
    assert.equal(res.status, 201);
    vendorId = res.body.id;
  });

  await t.test("applied labor over estimated labor shows up in laborOvercharged", async () => {
    await syncItemizedRow(800, { code: "60000001", estimatedLabor: 1000, appliedLabor: 1600 });
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const entry = res.body.laborOvercharged.find((o) => o.code === "60000001");
    assert.ok(entry, "expected 60000001 in laborOvercharged");
    assert.equal(entry.overage, 600);
  });

  await t.test("applied contracted-services over estimate shows up in contractedIncreased, with the matched vendor", async () => {
    await syncItemizedRow(801, {
      code: "60000002",
      estimatedContracted: 500,
      appliedContracted: 900,
      vendorText: "Acme Mechanical - 5551234",
    });
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const entry = res.body.contractedIncreased.find((o) => o.code === "60000002");
    assert.ok(entry, "expected 60000002 in contractedIncreased");
    assert.equal(entry.overage, 400);
    assert.equal(entry.vendorId, vendorId);
    assert.equal(entry.vendorName, "Acme Mechanical");
  });

  await t.test("a WOM with contracted spend applied but no Toyota PO on file is High priority, even once sent to Toyota", async () => {
    // Complete sent_to_toyota first, so the assertion below is actually
    // testing the contracted-no-PO condition and not just riding along on
    // "hasn't been sent to Toyota yet" also being High.
    const sent = await server.call("POST", "/api/woms/60000002/lifecycle/sent_to_toyota", {
      userId: "ADMIN",
      body: { toyotaEmail: "toyota@example.com" },
    });
    assert.equal(sent.status, 200);

    const tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = tasks.body.find((t2) => t2.sourceKey === "WOM-60000002-LIFECYCLE");
    assert.ok(task, "expected a lifecycle task for 60000002");
    assert.equal(task.priority, "high");
  });

  await t.test("a second WOM over quote with the same vendor makes them show up in vendorsOverchargingRepeatedly", async () => {
    await syncItemizedRow(802, {
      code: "60000003",
      estimatedContracted: 200,
      appliedContracted: 300,
      vendorText: "Acme Mechanical - 5551234",
    });
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const entry = res.body.vendorsOverchargingRepeatedly.find((v) => v.vendorId === vendorId);
    assert.ok(entry, "expected Acme Mechanical to show up as a repeat overcharger");
    assert.equal(entry.count, 2);
    assert.equal(entry.totalOverage, 500);
  });

  await t.test("vendorContractedSpend totals every WOM's applied contracted cost for that vendor, overage or not", async () => {
    // A third WOM for the same vendor that did NOT run over its estimate --
    // still counts toward total business done with them.
    await syncItemizedRow(803, {
      code: "60000004",
      estimatedContracted: 1000,
      appliedContracted: 1000,
      vendorText: "Acme Mechanical - 5551234",
    });
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const spend = res.body.vendorContractedSpend.find((v) => v.vendorId === vendorId);
    assert.ok(spend);
    assert.equal(spend.womCount, 3);
    assert.equal(spend.totalAppliedContracted, 900 + 300 + 1000);
  });

  await t.test("the vendor's own profile shows the same contracted spend total and no last-invoiced date yet", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.equal(vendor.totalContractedApplied, 900 + 300 + 1000);
    assert.equal(vendor.contractedWomCount, 3);
    assert.equal(vendor.lastInvoicedAt, null);
  });

  await t.test("invoicing one of the vendor's WOMs sets the vendor's lastInvoicedAt", async () => {
    await syncItemizedRow(801, { code: "60000002", maximoNumber: "PO-1", estimatedContracted: 500, appliedContracted: 900 });
    const complete = await server.call("POST", "/api/woms/60000002/complete", { userId: "T1001" });
    assert.equal(complete.status, 200);
    await server.call("POST", "/api/woms/60000002/lifecycle/charges_reviewed", { userId: "ADMIN" });
    const invoiced = await server.call("POST", "/api/woms/60000002/lifecycle/invoiced", {
      userId: "ADMIN",
      body: { batchNumber: "B2", invoiceNumber: "INV-2" },
    });
    assert.equal(invoiced.status, 200);

    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    assert.ok(vendor.lastInvoicedAt, "expected a last-invoiced date now that one of this vendor's WOMs is invoiced");
  });

  await t.test("a WOM with no vendor match at all doesn't appear in any vendor rollup", async () => {
    await syncItemizedRow(804, { code: "60000005", estimatedContracted: 100, appliedContracted: 200, vendorText: "Totally Unknown Co - 9999" });
    const res = await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" });
    const entry = res.body.contractedIncreased.find((o) => o.code === "60000005");
    assert.ok(entry);
    assert.equal(entry.vendorId, null);
    assert.equal(entry.vendorName, null);
  });
});

test("smartsheet sync: task/exception counters and the persisted last-sync summary", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a sync that enters a new WOM into the pipeline reports one task created", async () => {
    const result = await syncOneOpenWom(server, "50000001", 970);
    assert.equal(result.tasksCreated, 1);
    assert.equal(result.tasksCompleted, 0);
    assert.ok(result.lastSync);
    assert.equal(result.lastSync.tasks_created, 1);
  });

  await t.test("status now reflects the persisted last sync", async () => {
    const res = await server.call("GET", "/api/admin/smartsheet/status", { userId: "ADMIN" });
    assert.ok(res.body.lastSync);
    assert.equal(res.body.lastSync.tasks_created, 1);
  });
});

// A user-defined recurring task ("remind me every Monday and Wednesday")
// is a template, not a single task row -- ensureRecurringTasks (called
// lazily on every GET, same lazy-on-read pattern the app's own fixed
// recurring responsibilities already use) upserts today's occurrence
// whenever today's weekday is in the template's days.
test("tasks: user-defined recurring tasks", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const today = new Date().getDay();
  const notToday = (today + 3) % 7;

  await t.test("a technician can't create a recurring task", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "T1001",
      body: { title: "Weekly thing", recurring: true, recurrenceDays: [today] },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects an empty recurrenceDays array", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Weekly thing", recurring: true, recurrenceDays: [] },
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects an out-of-range weekday number", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Weekly thing", recurring: true, recurrenceDays: [7] },
    });
    assert.equal(res.status, 400);
  });

  await t.test("creating a recurring task that includes today generates today's occurrence immediately", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Check the mail", recurring: true, recurrenceDays: [today], assignedRole: "admin" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.recurring, true);
    assert.ok(res.body.todayTask, "expected today's occurrence to already exist");
    assert.equal(res.body.todayTask.title, "Check the mail");
    assert.equal(res.body.todayTask.category, "recurring");
  });

  await t.test("creating a recurring task that excludes today does not generate an occurrence yet", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Not today's thing", recurring: true, recurrenceDays: [notToday] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.todayTask, null);
  });

  await t.test("the generated occurrence shows up on the unassigned admin-role board", async () => {
    const res = await server.call("GET", "/api/tasks?view=unassigned&role=admin", { userId: "ADMIN" });
    assert.ok(res.body.some((t) => t.title === "Check the mail"));
  });

  await t.test("re-fetching the task list doesn't duplicate today's occurrence", async () => {
    await server.call("GET", "/api/tasks", { userId: "ADMIN" });
    await server.call("GET", "/api/tasks", { userId: "ADMIN" });
    const res = await server.call("GET", "/api/tasks?view=unassigned&role=admin", { userId: "ADMIN" });
    assert.equal(res.body.filter((t) => t.title === "Check the mail").length, 1);
  });

  await t.test("completing today's occurrence doesn't get re-opened by the next fetch, same as other recurring tasks", async () => {
    const list = await server.call("GET", "/api/tasks?view=unassigned&role=admin", { userId: "ADMIN" });
    const occurrence = list.body.find((t) => t.title === "Check the mail");
    await server.call("PATCH", `/api/tasks/${occurrence.id}/status`, { userId: "ADMIN", body: { status: "completed" } });
    await server.call("GET", "/api/tasks", { userId: "ADMIN" });
    const after = await server.call("GET", `/api/tasks?view=completed`, { userId: "ADMIN" });
    assert.ok(after.body.some((t) => t.id === occurrence.id && t.status === "completed"));
  });

  await t.test("rejects a malformed dueTime", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Bad time", dueTime: "25:99" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a plain (non-recurring) task combines dueAt date and dueTime into one timestamp", async () => {
    const res = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Timed task", dueAt: "2026-05-01", dueTime: "14:30" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.dueAt, "2026-05-01T14:30");
  });
});

test("tasks: sorted by priority tier first, then due date", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a High-priority task with a later due date still sorts above a Normal one due sooner", async () => {
    const normalSooner = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Normal, due soon", assignedTo: "T1003", priority: "normal", dueAt: "2026-01-01" },
    });
    assert.equal(normalSooner.status, 201);

    const highLater = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "High, due later", assignedTo: "T1003", priority: "high", dueAt: "2026-12-01" },
    });
    assert.equal(highLater.status, 201);

    const res = await server.call("GET", "/api/tasks?view=team&assignedTo=T1003", { userId: "ADMIN" });
    const ids = res.body.map((t2) => t2.id);
    assert.ok(ids.indexOf(highLater.body.id) < ids.indexOf(normalSooner.body.id), "expected the High task to sort before the Normal one");
  });

  await t.test("Emergency still sorts above High regardless of due date", async () => {
    const high = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "High, due soon", assignedTo: "T1002", priority: "high", dueAt: "2026-01-01" },
    });
    const emergency = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Emergency, due later", assignedTo: "T1002", priority: "emergency", dueAt: "2026-12-01" },
    });
    const res = await server.call("GET", "/api/tasks?view=team&assignedTo=T1002", { userId: "ADMIN" });
    const ids = res.body.map((t2) => t2.id);
    assert.ok(ids.indexOf(emergency.body.id) < ids.indexOf(high.body.id));
  });
});

test("tasks: an admin can look up another role's queue while still on the My Work view", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("filtering by role=tech under the default (My Work) view isn't silently scoped to the admin's own roles", async () => {
    // An admin's own roles never include "tech" -- before the fix, adding
    // an explicit role filter on top of the default view="my" scope ANDed
    // the two together and always returned nothing for a role the viewer
    // doesn't personally have, even though the task genuinely exists.
    const created = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Unclaimed tech task", assignedRole: "tech" },
    });
    assert.equal(created.status, 201);

    const withoutView = await server.call("GET", "/api/tasks?role=tech", { userId: "ADMIN" });
    assert.ok(
      withoutView.body.some((t2) => t2.id === created.body.id),
      "expected the unclaimed tech task to show up when looking it up by role, even on the default view"
    );
  });

  await t.test("filtering by a specific person also isn't scoped to the admin's own roles", async () => {
    const created = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "For T1002 specifically", assignedTo: "T1002" },
    });
    assert.equal(created.status, 201);

    const res = await server.call("GET", "/api/tasks?assignedTo=T1002", { userId: "ADMIN" });
    assert.ok(res.body.some((t2) => t2.id === created.body.id));
  });
});
