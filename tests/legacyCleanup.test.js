const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

test("legacy cleanup: leftover tasks from the retired PSE stage machine get removed", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");

  await t.test("a task with an old PSE-stage workflow_rule is deleted by cleanupLegacyPseWorkflowTasks", async () => {
    // Insert directly via a second connection to the same file -- there's
    // no current route that can create a task shaped like this anymore
    // (the code that used to is fully removed), which is exactly why any
    // leftover one is permanently stuck without this cleanup.
    const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
    raw
      .prepare(
        `INSERT INTO tasks (source_key, title, description, category, priority, status, source, workflow_rule,
         related_wom_code, is_exception, created_at, last_status_change_at)
         VALUES (?, ?, '', 'wom_workflow', 'normal', 'open', 'wom_workflow', ?, ?, 0, datetime('now'), datetime('now'))`
      )
      .run("WOM-LEGACYTEST-PRODUCE-PSE", "Produce PSE for LEGACYTEST", "pse_review", "LEGACYTEST");
    raw.close();

    const before = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(before.body.some((t2) => t2.title === "Produce PSE for LEGACYTEST"), "expected the inserted legacy task to be visible before cleanup");

    const removed = db.cleanupLegacyPseWorkflowTasks();
    assert.ok(removed >= 1);

    const after = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(!after.body.some((t2) => t2.title === "Produce PSE for LEGACYTEST"), "expected the legacy task to be gone after cleanup");
  });

  await t.test("a current wom_lifecycle task is never touched by the cleanup", async () => {
    // A real lifecycle task created through the normal route.
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "LEGACYTEST2", description: "Test job", locationCode: "PRINCETON" },
    });
    assert.equal(create.status, 201);
    await server.call("PATCH", "/api/woms/LEGACYTEST2/details", {
      userId: "ADMIN",
      body: { description: "Test job", locationCode: "PRINCETON" },
    });

    const removed = db.cleanupLegacyPseWorkflowTasks();
    assert.equal(removed, 0, "no legacy rows left, and the current lifecycle task must not be caught by the cleanup");

    const tasks = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(tasks.body.some((t2) => t2.sourceKey === "WOM-LEGACYTEST2-LIFECYCLE"), "the current lifecycle task should still exist, untouched");
  });
});
