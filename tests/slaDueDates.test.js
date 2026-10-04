const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// Both new automated-task SLA clocks (a PO discrepancy's 3 days, a
// ready-to-invoice WOM's 24h) should behave like every other task's due
// date -- set once off the triggering event, never reset by a later lazy
// refresh (preserveDueAtOnUpdate) -- and just show up overdue the normal
// way once that date passes, no separate escalation mechanism.

test("SLA due dates: PO discrepancy tasks get a 3-day due date that doesn't reset", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, vendorNumber, vendorName, adminName }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, vendor_number, vendor_name, admin_name,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, vendorNumber, vendorName, adminName, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("an unregistered-vendor task gets a due date about 3 days out", async () => {
    insertPo({ composite: "sla-1", poNumber: "PO91001", vendorNumber: "V9501", vendorName: "Sla Test Vendor", adminName: "Krista Lee" });
    db.refreshAllUnregisteredVendorTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = res.body.find((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9501");
    assert.ok(task, "expected a task for the unregistered vendor");
    assert.ok(task.dueAt, "expected a due date to be set");
    const hoursOut = (new Date(task.dueAt) - Date.now()) / 3600000;
    assert.ok(hoursOut > 71 && hoursOut < 73, `expected ~72h out, got ${hoursOut}h`);
  });

  await t.test("a later refresh (e.g. the next page load) doesn't push the due date back out", async () => {
    let res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const before = res.body.find((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9501").dueAt;

    db.refreshAllUnregisteredVendorTasks();
    db.refreshAllUnregisteredVendorTasks();

    res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const after = res.body.find((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9501").dueAt;
    assert.equal(after, before, "due date should be set once off the first detection, not reset on every refresh");
  });

  raw.close();
});

test("SLA due dates: a WOM ready to invoice gets a 24h task that doesn't reset and auto-completes", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("no task exists before the WOM's work is marked complete", async () => {
    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(!res.body.some((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502"));
  });

  await t.test("marking work complete creates a wom_invoicing task due ~24h out", async () => {
    raw.prepare("UPDATE woms SET source_work_completed = 1 WHERE code = ?").run("WOM-4502");
    db.refreshAllWomInvoicingTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = res.body.find((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502");
    assert.ok(task, "expected a wom_invoicing task");
    assert.ok(task.dueAt);
    const hoursOut = (new Date(task.dueAt) - Date.now()) / 3600000;
    assert.ok(hoursOut > 23 && hoursOut < 25, `expected ~24h out, got ${hoursOut}h`);
    assert.match(task.title, /WOM-4502/);
  });

  await t.test("a later refresh doesn't push the due date back out", async () => {
    let res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const before = res.body.find((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502").dueAt;

    db.refreshAllWomInvoicingTasks();

    res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const after = res.body.find((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502").dueAt;
    assert.equal(after, before);
  });

  await t.test("fully invoicing the WOM auto-completes the task", async () => {
    raw.prepare("UPDATE woms SET invoice_number = ?, batch_number = ? WHERE code = ?").run("INV-9001", "B-901", "WOM-4502");
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "wom", relatedId: "WOM-4502", category: "invoice" },
      fileName: "toyota-invoice.pdf",
      mimeType: "application/pdf",
    });

    db.refreshAllWomInvoicingTasks();

    const openRes = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(
      !openRes.body.some((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502"),
      "should no longer appear as an open task"
    );

    const completedRes = await server.call("GET", "/api/tasks?view=completed", { userId: "ADMIN" });
    const task = completedRes.body.find((tk) => tk.category === "wom_invoicing" && tk.relatedWomCode === "WOM-4502");
    assert.ok(task, "the task row itself should still exist, now completed");
    assert.equal(task.status, "completed");
  });

  raw.close();
});
