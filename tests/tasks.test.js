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

test("task engine: WOM sync generates, updates, and completes workflow tasks with stable source keys", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a synced WOM's pse_review stage creates a reviewer task with a deterministic source key", async () => {
    await syncOneOpenWom(server, "40000001", 950);
    const res = await server.call("GET", "/api/tasks?view=team&role=reviewer", { userId: "ADMIN" });
    const task = res.body.find((t2) => t2.relatedWomCode === "40000001");
    assert.ok(task, "expected a workflow task for the synced WOM");
    assert.equal(task.sourceKey, "WOM-40000001-PRODUCE-PSE");
    assert.equal(task.source, "wom_workflow");
    assert.equal(task.category, "wom_workflow");
  });

  await t.test("re-syncing the same row doesn't duplicate the task", async () => {
    await syncOneOpenWom(server, "40000001", 950);
    const res = await server.call("GET", "/api/tasks?role=reviewer&status=open", { userId: "ADMIN" });
    const matches = res.body.filter((t2) => t2.relatedWomCode === "40000001");
    assert.equal(matches.length, 1);
  });

  await t.test("advancing the PSE stage completes the old stage's task and creates the new one", async () => {
    const advance = await server.call("POST", "/api/woms/40000001/pse/actions/mark_pse_produced", { userId: "ADMIN" });
    assert.equal(advance.status, 200);

    const produced = await server.call("GET", "/api/tasks?status=completed", { userId: "ADMIN" });
    const oldTask = produced.body.find((t2) => t2.sourceKey === "WOM-40000001-PRODUCE-PSE");
    assert.ok(oldTask, "expected the pse_review task to be auto-completed");
    assert.equal(oldTask.status, "completed");

    const followUp = await server.call("GET", "/api/tasks?role=reviewer", { userId: "ADMIN" });
    const newTask = followUp.body.find((t2) => t2.sourceKey === "WOM-40000001-TOYOTA-APPROVAL");
    assert.ok(newTask, "expected the awaiting_toyota_approval task to be created");
  });

  await t.test("marking work complete flags check_expenses as an exception when a hold is active", async () => {
    // Fast-forward through the rest of the pipeline to ready_to_schedule.
    await server.call("POST", "/api/woms/40000001/pse/actions/toyota_approved", { userId: "ADMIN" });
    await server.call("POST", "/api/woms/40000001/pse/actions/generated_with_po", { userId: "ADMIN" });
    await server.call("POST", "/api/woms/40000001/complete", { userId: "T1001" });
    await server.call("POST", "/api/woms/40000001/pse/hold", { userId: "ADMIN", body: { holdReason: "vendor_invoice" } });

    const res = await server.call("GET", "/api/tasks?view=exceptions", { userId: "ADMIN" });
    const exceptionTask = res.body.find((t2) => t2.relatedWomCode === "40000001");
    assert.ok(exceptionTask, "expected an exception task for the held WOM");
    assert.equal(exceptionTask.sourceKey, "WOM-40000001-REVIEW-EXPENSES");
  });

  await t.test("WOM status history recorded both the status and pse_stage transitions", async () => {
    const res = await server.call("GET", "/api/woms/40000001/history", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((h) => h.field === "pse_stage" && h.new_value === "pse_review"));
    assert.ok(res.body.some((h) => h.field === "pse_stage" && h.new_value === "check_expenses"));
    assert.ok(res.body.every((h) => h.detected_at));
  });

  await t.test("a technician can't view WOM history", async () => {
    const res = await server.call("GET", "/api/woms/40000001/history", { userId: "T1001" });
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
