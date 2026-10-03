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

  // A lightweight, one-click "needs a reclass eventually" flag -- distinct
  // from the full Flag a Finding form. Admin notices a gap on a PO (any
  // reason, not just the WOM-link one above) and marks it for their running
  // monthly list without detailing the From/To coding right away.
  await t.test("flagging a PO for reclass logs a lightweight finding and shows up as an open flag", async () => {
    const poId = insertPo({ composite: "flag-1", poNumber: "PO60001", e1WomJobNumber: "100110066000", womNumber: null, lifecycleStatus: "active" });

    const flagRes = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(flagRes.status, 200);
    assert.equal(flagRes.body.flaggedCount, 1);
    assert.equal(flagRes.body.skippedCount, 0);
    assert.match(flagRes.body.items[0].comments, /PO60001/);
    assert.equal(flagRes.body.items[0].status, "flagged");
    assert.equal(flagRes.body.items[0].toJobNumber, null, "the To side should be left blank for the admin to detail later");

    const itemsRes = await server.call("GET", "/api/admin/reclasses/items?status=flagged", { userId: "ADMIN" });
    assert.ok(itemsRes.body.some((i) => i.relatedPoId === poId));

    const po = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(po.body.hasOpenReclassFlag, true);
  });

  await t.test("flagging the same PO again while an open flag exists is a no-op", async () => {
    const poId = insertPo({ composite: "flag-2", poNumber: "PO60002", e1WomJobNumber: "100110066001", womNumber: null, lifecycleStatus: "active" });

    const first = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(first.body.flaggedCount, 1);

    const second = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(second.body.flaggedCount, 0);
    assert.equal(second.body.skippedCount, 1);

    const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
    assert.equal(itemsRes.body.filter((i) => i.relatedPoId === poId).length, 1, "only one reclass item should exist for this PO");
  });

  await t.test("once the flagged item is marked confirmed_posted, the PO can be flagged again", async () => {
    const poId = insertPo({ composite: "flag-3", poNumber: "PO60003", e1WomJobNumber: "100110066002", womNumber: null, lifecycleStatus: "active" });
    const first = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    const itemId = first.body.items[0].id;

    await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, { userId: "ADMIN", body: { status: "confirmed_posted" } });

    const po = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(po.body.hasOpenReclassFlag, false, "a confirmed_posted flag should no longer count as open");

    const second = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(second.body.flaggedCount, 1, "flagging again after the prior one is resolved should create a new entry");
  });

  // A reclass getting confirmed posted means whatever it corrected also
  // needs to be reflected in Smartsheet -- a separate manual step this app
  // can't verify, so it tasks the PO's own Admin column (matched to a real
  // admin account by name).
  await t.test("confirming a reclass posted tasks the PO's own admin to update Smartsheet", async () => {
    raw.prepare(`INSERT INTO pos (composite_key, po_number, admin_name, e1_wom_job_number, wom_number, lifecycle_status,
      first_imported_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run("ss-1", "PO70001", "Krista Lee", "100110077000", null, now, now, now, now);
    const poRow = raw.prepare("SELECT id FROM pos WHERE po_number = ?").get("PO70001");

    const flagRes = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poRow.id] } });
    const itemId = flagRes.body.items[0].id;

    await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, { userId: "ADMIN", body: { status: "confirmed_posted" } });

    // This PO also matches the WOM-link-gap condition (e1_wom_job_number
    // set, wom_number blank), so it gets a *second*, unrelated task too
    // ("Confirm WOM # for..."); disambiguate by workflowRule rather than
    // just the PO number substring, which both titles contain.
    const tasksRes = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = tasksRes.body.find((tk) => tk.workflowRule === "reclass_smartsheet" && tk.title.includes("PO70001"));
    assert.ok(task, "expected a Smartsheet-update task for PO70001's reclass");
    assert.equal(task.assignedTo, "ADMIN", "should be assigned to the admin account matching the PO's Admin column (Krista Lee)");
    assert.match(task.title, /Update Smartsheet/);
  });

  await t.test("an unmatched Admin name still creates the task, unassigned, with the raw name kept for manual routing", async () => {
    raw.prepare(`INSERT INTO pos (composite_key, po_number, admin_name, e1_wom_job_number, wom_number, lifecycle_status,
      first_imported_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run("ss-2", "PO70002", "Someone Not In The System", "100110077002", null, now, now, now, now);
    const poRow = raw.prepare("SELECT id FROM pos WHERE po_number = ?").get("PO70002");

    const flagRes = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poRow.id] } });
    const itemId = flagRes.body.items[0].id;

    await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, { userId: "ADMIN", body: { status: "confirmed_posted" } });

    const tasksRes = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = tasksRes.body.find((tk) => tk.workflowRule === "reclass_smartsheet" && tk.title.includes("PO70002"));
    assert.ok(task, "expected the task to still be created even with no admin match");
    assert.equal(task.assignedTo, null);
    assert.match(task.description, /Someone Not In The System/);
  });

  await t.test("bulk-flagging multiple POs at once (the 4-row filtered-list use case)", async () => {
    const ids = [
      insertPo({ composite: "bulk-1", poNumber: "PO60010", e1WomJobNumber: "100110066010", womNumber: null, lifecycleStatus: "active" }),
      insertPo({ composite: "bulk-2", poNumber: "PO60011", e1WomJobNumber: "100110066011", womNumber: null, lifecycleStatus: "active" }),
      insertPo({ composite: "bulk-3", poNumber: "PO60012", e1WomJobNumber: "100110066012", womNumber: null, lifecycleStatus: "active" }),
      insertPo({ composite: "bulk-4", poNumber: "PO60013", e1WomJobNumber: "100110066013", womNumber: null, lifecycleStatus: "active" }),
    ];

    const res = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: ids } });
    assert.equal(res.status, 200);
    assert.equal(res.body.flaggedCount, 4);
  });

  raw.close();
});

// "Subsidiary" and "PPS Subsidiary" are two separate columns on the real
// sheet, but a given row only ever has one filled in -- both mean the exact
// same thing (confirmed directly), so the import needs to read whichever
// one is actually populated into the single `subsidiary` field used
// everywhere else in the app.
test("PO Tracker import: Subsidiary and PPS Subsidiary coalesce into one field", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const XLSX = require("xlsx");

  const headers = [
    "Date Requested", "Description", "Requestor", "PO Number", "E&F Contract Job #", "PO Amount",
    "Change Order", "Status", "Vendor Name", "Vendor Number", "PPS Job Number", "E1 WOM Job #",
    "WOM Number", "Asset Number", "Maximo WO#", "Object Code", "Subsidiary", "PPS Subsidiary",
    "Admin", "Urgent", "Urgent Reason/Notes",
  ];
  const rows = [
    headers,
    // Row with "Subsidiary" filled, "PPS Subsidiary" blank.
    ["2026-01-01", "Normal subsidiary row", "Jane Doe", "PO90001", null, 100, null, "Open", "Vendor A", "1001", null, null, null, null, null, null, "100 Primary", null, "Krista Lee", null, null],
    // Row with "PPS Subsidiary" filled, "Subsidiary" blank -- the gap this fixes.
    ["2026-01-02", "PPS subsidiary row", "John Smith", "PO90002", null, 200, null, "Open", "Vendor B", "1002", null, null, null, null, null, null, null, "200 Janitorial", "Krista Lee", null, null],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PO Tracking");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const importRes = await server.upload("/api/admin/pos/import", {
    userId: "ADMIN",
    fields: {},
    fileName: "po-tracker.xlsx",
    fileContent: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(importRes.status, 200, JSON.stringify(importRes.body));

  const listRes = await server.call("GET", "/api/admin/pos?lifecycleStatus=needs_organization&search=PO90001", { userId: "ADMIN" });
  const po1 = listRes.body.find((p) => p.poNumber === "PO90001");
  assert.ok(po1, "expected PO90001 to have imported");
  assert.equal(po1.subsidiary, "100 Primary");

  const listRes2 = await server.call("GET", "/api/admin/pos?lifecycleStatus=needs_organization&search=PO90002", { userId: "ADMIN" });
  const po2 = listRes2.body.find((p) => p.poNumber === "PO90002");
  assert.ok(po2, "expected PO90002 to have imported");
  assert.equal(po2.subsidiary, "200 Janitorial", "PPS Subsidiary should fill the subsidiary field when Subsidiary itself is blank");
});
