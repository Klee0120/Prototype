const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// PO <-> WOM link gap: the real PO Request Tracking export carries "E1 WOM
// Job #" and "WOM Number" as two separate columns, so a PO can be coded as
// WOM-type work in E1 without a WOM Number ever being recorded against it.
// See server/data/db.js's poMissingWomLink/refreshPoWomLinkTask.
test("PO Tracker: POs cut with WOM coding but no WOM # listed", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, e1WomJobNumber, womNumber, lifecycleStatus }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, e1_wom_job_number, wom_number, lifecycle_status,
         first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(composite, poNumber, e1WomJobNumber, womNumber, lifecycleStatus, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("listPos womLinkMissing filter finds only active POs with E1 WOM coding and no WOM #", () => {
    const gapId = insertPo({ composite: "gap-1", poNumber: "PO50001", e1WomJobNumber: "100110033928", womNumber: null, lifecycleStatus: "active" });
    insertPo({ composite: "fine-1", poNumber: "PO50002", e1WomJobNumber: "100110033929", womNumber: "WOM-9001", lifecycleStatus: "active" });
    insertPo({ composite: "nonwom-1", poNumber: "PO50003", e1WomJobNumber: null, womNumber: null, lifecycleStatus: "active" });
    // Same gap, but still Needs Organization -- shouldn't count as a gap worth flagging yet.
    insertPo({ composite: "gap-needs-org", poNumber: "PO50004", e1WomJobNumber: "100110033930", womNumber: null, lifecycleStatus: "needs_organization" });

    // Plain data filter, deliberately not lifecycle-scoped on its own -- the
    // POs tab ANDs it with whichever subtab (Active/Needs Organization) is
    // selected, same as the existing vendorUnmatched/regionUnassigned filters.
    const missing = db.listPos({ womLinkMissing: true });
    const ids = missing.map((p) => p.id);
    assert.ok(ids.includes(gapId), "expected the active PO with E1 WOM coding and no WOM # to show up");
    assert.ok(!missing.some((p) => p.poNumber === "PO50002"), "a PO with a WOM # recorded should not show up");
    assert.ok(!missing.some((p) => p.poNumber === "PO50003"), "a PO with no E1 WOM coding at all should not show up");
    assert.ok(missing.some((p) => p.poNumber === "PO50004"), "a needs_organization PO with the same gap should still show up in this plain data filter");

    const activeOnly = db.listPos({ womLinkMissing: true, lifecycleStatus: "active" });
    assert.ok(!activeOnly.some((p) => p.poNumber === "PO50004"), "combined with the Active subtab's own filter, the needs_organization PO drops out");
  });

  await t.test("refreshAllPoWomLinkTasks creates a task for an active PO with the gap, and skips a needs_organization one", async () => {
    const gapId = insertPo({ composite: "gap-2", poNumber: "PO50010", e1WomJobNumber: "100110044000", womNumber: null, lifecycleStatus: "active" });
    const needsOrgId = insertPo({ composite: "gap-needs-org-2", poNumber: "PO50011", e1WomJobNumber: "100110044001", womNumber: null, lifecycleStatus: "needs_organization" });

    db.refreshAllPoWomLinkTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const task = res.body.find((tk) => tk.relatedPoId === gapId);
    assert.ok(task, "expected a task linked to the gap PO");
    assert.match(task.title, /PO50010/);
    assert.equal(task.status, "open");

    assert.ok(!res.body.some((tk) => tk.relatedPoId === needsOrgId), "a needs_organization PO should not get a task yet");
  });

  await t.test("fixing the WOM # auto-completes the task on the next refresh", async () => {
    const gapId = insertPo({ composite: "gap-3", poNumber: "PO50020", e1WomJobNumber: "100110055000", womNumber: null, lifecycleStatus: "active" });
    db.refreshAllPoWomLinkTasks();

    let res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(res.body.some((tk) => tk.relatedPoId === gapId && tk.status === "open"));

    raw.prepare("UPDATE pos SET wom_number = ? WHERE id = ?").run("WOM-9010", gapId);
    db.refreshAllPoWomLinkTasks();

    res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(!res.body.some((tk) => tk.relatedPoId === gapId && tk.status === "open"), "task should no longer be open once the WOM # is filled in");
  });

  raw.close();
});
