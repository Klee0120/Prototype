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
