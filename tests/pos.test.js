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

  // The unflag: a reclass someone looked at and decided isn't actually
  // needed. Keeps the row (audit trail intact) instead of deleting it, but
  // stops counting as an open flag -- same treatment as confirmed_posted.
  await t.test("dismissing a flagged item clears the open flag and frees the PO to be flagged again", async () => {
    const poId = insertPo({ composite: "flag-4", poNumber: "PO60004", e1WomJobNumber: "100110066003", womNumber: null, lifecycleStatus: "active" });
    const first = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    const itemId = first.body.items[0].id;

    const dismissRes = await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, { userId: "ADMIN", body: { status: "dismissed" } });
    assert.equal(dismissRes.status, 200);
    assert.equal(dismissRes.body.status, "dismissed");

    const po = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(po.body.hasOpenReclassFlag, false, "a dismissed flag should no longer count as open");

    const second = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(second.body.flaggedCount, 1, "flagging again after dismissal should create a new entry");

    const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
    const dismissedItem = itemsRes.body.find((i) => i.id === itemId);
    assert.ok(dismissedItem, "the dismissed item should still exist, not be deleted");
    assert.equal(dismissedItem.status, "dismissed");
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

  // The flagged item needs to carry who to loop in -- the PO Tracker's own
  // Admin column for the PO this reclass traces back to -- so the flagged
  // list itself is a usable "potential reclass" worklist, not just coding
  // with no owner attached.
  await t.test("flagging a PO for reclass auto-fills the admin name from the PO's own Admin column", async () => {
    const poId = insertPo({ composite: "admin-1", poNumber: "PO70001", e1WomJobNumber: "100110070001", womNumber: null, lifecycleStatus: "active" });
    raw.prepare("UPDATE pos SET admin_name = ? WHERE id = ?").run("Jordan Smith", poId);

    const res = await server.call("POST", "/api/admin/reclasses/flag-po", { userId: "ADMIN", body: { poIds: [poId] } });
    assert.equal(res.body.items[0].adminName, "Jordan Smith");

    const itemsRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
    const item = itemsRes.body.find((i) => i.relatedPoId === poId);
    assert.equal(item.adminName, "Jordan Smith");
  });

  await t.test("flagging by WOM # (no direct PO link) still resolves the admin name via the tracker's wom_number field", async () => {
    const poId = insertPo({ composite: "admin-2", poNumber: "PO70002", e1WomJobNumber: "100110070002", womNumber: "WOM-7002", lifecycleStatus: "active" });
    raw.prepare("UPDATE pos SET admin_name = ? WHERE id = ?").run("Alex Rivera", poId);

    const res = await server.call("POST", "/api/admin/reclasses/items", {
      userId: "ADMIN",
      body: { fromWomNumber: "WOM-7002", fromAmount: 250, comments: "Noticed on search" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.adminName, "Alex Rivera", "should resolve via the WOM # even with no relatedPoId set");
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

// A PO whose vendor_number doesn't match any vendor profile on file (see
// listUnregisteredPoVendors) should task the admin who owns that PO to
// create one -- one task per vendor #, even if several POs share it.
test("Task Manager: unregistered PO vendor -> create vendor profile task", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, vendorNumber, vendorName, adminName, amount }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, vendor_number, vendor_name, admin_name, po_amount,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, vendorNumber, vendorName, adminName, amount, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("creates one task per unregistered vendor #, routed to the PO's admin when it matches a real account", async () => {
    insertPo({ composite: "unreg-1", poNumber: "PO70001", vendorNumber: "V9001", vendorName: "Acme Fire & Safety", adminName: "Krista Lee", amount: 500 });
    insertPo({ composite: "unreg-2", poNumber: "PO70002", vendorNumber: "V9001", vendorName: "Acme Fire & Safety", adminName: "Krista Lee", amount: 750 });

    db.refreshAllUnregisteredVendorTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const tasks = res.body.filter((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9001");
    assert.equal(tasks.length, 1, "two POs sharing the same unregistered vendor # should collapse into one task");
    assert.match(tasks[0].title, /Acme Fire & Safety/);
    assert.match(tasks[0].title, /V9001/);
    assert.equal(tasks[0].assignedTo, "ADMIN", "should route to Krista Lee's admin account by name match");
    assert.match(tasks[0].description, /2 Budget POs/);
  });

  await t.test("an admin_name that doesn't match any account creates an unassigned task with the raw name kept for manual routing", async () => {
    insertPo({ composite: "unreg-3", poNumber: "PO70010", vendorNumber: "V9002", vendorName: "Beta Mechanical", adminName: "Nobody Real", amount: 300 });

    db.refreshAllUnregisteredVendorTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = res.body.find((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9002");
    assert.ok(task);
    assert.equal(task.assignedTo, null);
    assert.match(task.description, /Nobody Real/);
  });

  await t.test("creating the vendor profile closes the task on the next refresh", async () => {
    insertPo({ composite: "unreg-4", poNumber: "PO70020", vendorNumber: "V9003", vendorName: "Gamma Electric", adminName: "Krista Lee", amount: 900 });
    db.refreshAllUnregisteredVendorTasks();

    let res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(res.body.some((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9003" && tk.status === "open"));

    const vendorRes = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Gamma Electric", jdeVendorNumber: "V9003" },
    });
    assert.equal(vendorRes.status, 201, JSON.stringify(vendorRes.body));

    db.refreshAllUnregisteredVendorTasks();
    res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(
      !res.body.some((tk) => tk.category === "po_vendor_unregistered" && tk.sourceRecordId === "V9003" && tk.status === "open"),
      "task should auto-complete once a matching vendor profile exists"
    );
  });

  raw.close();
});

// A GL posting against a PO whose object code or subsidiary doesn't match
// what's on file for that PO (gl_entries.subsidiary_mismatch/object_code_mismatch,
// computed at GL import time) should task the PO's admin to correct the
// Smartsheet coding -- the GL posting is the latest real-world truth.
test("Task Manager: PO/GL coding drift -> update Smartsheet coding task", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, objectCode, subsidiary, adminName }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, object_code, subsidiary, admin_name,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, objectCode, subsidiary, adminName, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  function insertGlEntry({ poId, objectAccount, subsidiary, subsidiaryMismatch, objectCodeMismatch, glDate }) {
    raw
      .prepare(
        `INSERT INTO gl_entries (matched_po_id, object_account, subsidiary, subsidiary_mismatch, object_code_mismatch, gl_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(poId, objectAccount, subsidiary, subsidiaryMismatch, objectCodeMismatch, glDate, now);
  }

  await t.test("a mismatched GL posting tasks the PO's admin, naming what differs", async () => {
    const poId = insertPo({ composite: "drift-1", poNumber: "PO80001", objectCode: "22067000", subsidiary: "100 Primary", adminName: "Krista Lee" });
    insertGlEntry({ poId, objectAccount: "22099000", subsidiary: "100 Primary", subsidiaryMismatch: 0, objectCodeMismatch: 1, glDate: "2026-01-15" });

    db.refreshAllPoCodingDriftTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = res.body.find((tk) => tk.relatedPoId === poId);
    assert.ok(task, "expected a coding-drift task for this PO");
    assert.match(task.title, /PO80001/);
    assert.match(task.description, /object code/);
    assert.match(task.description, /22099000/);
    assert.match(task.description, /22067000/);
    assert.equal(task.assignedTo, "ADMIN");
  });

  await t.test("a PO with no mismatched GL line gets no task", async () => {
    const poId = insertPo({ composite: "drift-2", poNumber: "PO80002", objectCode: "22067000", subsidiary: "100 Primary", adminName: "Krista Lee" });
    insertGlEntry({ poId, objectAccount: "22067000", subsidiary: "100 Primary", subsidiaryMismatch: 0, objectCodeMismatch: 0, glDate: "2026-01-15" });

    db.refreshAllPoCodingDriftTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(!res.body.some((tk) => tk.relatedPoId === poId));
  });

  await t.test("correcting the PO's coding auto-completes the task on the next refresh", async () => {
    const poId = insertPo({ composite: "drift-3", poNumber: "PO80003", objectCode: "22067000", subsidiary: "100 Primary", adminName: "Krista Lee" });
    insertGlEntry({ poId, objectAccount: "22099000", subsidiary: "100 Primary", subsidiaryMismatch: 0, objectCodeMismatch: 1, glDate: "2026-01-15" });
    db.refreshAllPoCodingDriftTasks();

    let res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(res.body.some((tk) => tk.relatedPoId === poId && tk.status === "open"));

    raw.prepare("UPDATE gl_entries SET object_code_mismatch = 0 WHERE matched_po_id = ?").run(poId);
    db.refreshAllPoCodingDriftTasks();

    res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    assert.ok(!res.body.some((tk) => tk.relatedPoId === poId && tk.status === "open"), "task should auto-complete once the GL line no longer mismatches");
  });

  await t.test("an admin_name that doesn't match any account routes unassigned with the raw name kept", async () => {
    const poId = insertPo({ composite: "drift-4", poNumber: "PO80004", objectCode: "22067000", subsidiary: "100 Primary", adminName: "Nobody Real" });
    insertGlEntry({ poId, objectAccount: "22099000", subsidiary: "100 Primary", subsidiaryMismatch: 0, objectCodeMismatch: 1, glDate: "2026-01-15" });

    db.refreshAllPoCodingDriftTasks();

    const res = await server.call("GET", "/api/tasks?view=team", { userId: "ADMIN" });
    const task = res.body.find((tk) => tk.relatedPoId === poId);
    assert.ok(task);
    assert.equal(task.assignedTo, null);
    assert.match(task.description, /Nobody Real/);
  });

  raw.close();
});

// Replaces the old bare "assign a region" shortcut: a PO with no location
// match should get a real Location tagged with its own E&F job #, not a
// region typed directly onto the PO record -- see db.js's tagLocationForPo.
test("PO Tracker: tag a location with a PO's E&F job # (replaces the old region dropdown)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, efJobNumber, vendorId }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, ef_job_number, vendor_id,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'needs_organization', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, efJobNumber, vendorId || null, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await t.test("tagging an existing location resolves this PO and every other PO sharing the job #", async () => {
    const locRes = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "TAGTEST1", name: "Tag Test Site", territory: "Midwest" },
    });
    assert.equal(locRes.status, 201);

    const poId1 = insertPo({ composite: "tag-1a", poNumber: "PO91001", efJobNumber: "900000001" });
    const poId2 = insertPo({ composite: "tag-1b", poNumber: "PO91002", efJobNumber: "900000001" });

    const tagRes = await server.call("PATCH", `/api/admin/pos/${poId1}/location-tag`, {
      userId: "ADMIN",
      body: { locationCode: "TAGTEST1" },
    });
    assert.equal(tagRes.status, 200, JSON.stringify(tagRes.body));
    assert.equal(tagRes.body.locationCode, "TAGTEST1");
    assert.equal(tagRes.body.region, "Midwest");

    const po2 = await server.call("GET", `/api/admin/pos/${poId2}`, { userId: "ADMIN" });
    assert.equal(po2.body.locationCode, "TAGTEST1", "a second PO sharing the same job # should resolve too, without being tagged itself");
  });

  await t.test("tagging an existing location with a matched vendor and real PO # auto-activates it", async () => {
    const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Tag Test Vendor" } });
    const poId = insertPo({ composite: "tag-2", poNumber: "91010", efJobNumber: "900000002", vendorId: vendorRes.body.id });
    await server.call("POST", "/api/locations", { userId: "ADMIN", body: { code: "TAGTEST2", name: "Tag Test Site 2" } });

    const tagRes = await server.call("PATCH", `/api/admin/pos/${poId}/location-tag`, { userId: "ADMIN", body: { locationCode: "TAGTEST2" } });
    assert.equal(tagRes.body.lifecycleStatus, "active", "PO #, location, and vendor all now matched -- should auto-activate");
  });

  await t.test("creating a new location inline tags and resolves in one step", async () => {
    const poId = insertPo({ composite: "tag-3", poNumber: "PO91020", efJobNumber: "900000003" });

    const tagRes = await server.call("PATCH", `/api/admin/pos/${poId}/location-tag`, {
      userId: "ADMIN",
      body: { newLocation: { code: "TAGTEST3", name: "Brand New Site", territory: "Southeast" } },
    });
    assert.equal(tagRes.status, 200, JSON.stringify(tagRes.body));
    assert.equal(tagRes.body.locationCode, "TAGTEST3");
    assert.equal(tagRes.body.region, "Southeast");

    const locRes = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const created = locRes.body.find((l) => l.code === "TAGTEST3");
    assert.ok(created);
    assert.equal(created.efJobNumber, "900000003");
  });

  await t.test("a PO with no E&F job # on file can't be tagged", async () => {
    const poId = insertPo({ composite: "tag-4", poNumber: "PO91030", efJobNumber: null });
    const tagRes = await server.call("PATCH", `/api/admin/pos/${poId}/location-tag`, { userId: "ADMIN", body: { locationCode: "TAGTEST1" } });
    assert.equal(tagRes.status, 400);
    assert.match(tagRes.body.error, /no E&F Contract Job #/);
  });

  await t.test("tagging a location that's already tied to a different job # is rejected", async () => {
    await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "TAGTEST5", name: "Already Tagged Site", efJobNumber: "900000005" },
    });
    const poId = insertPo({ composite: "tag-5", poNumber: "PO91040", efJobNumber: "900000099" });
    const tagRes = await server.call("PATCH", `/api/admin/pos/${poId}/location-tag`, { userId: "ADMIN", body: { locationCode: "TAGTEST5" } });
    assert.equal(tagRes.status, 400);
    assert.match(tagRes.body.error, /already tagged/);
  });

  await t.test("the old bare region routes are gone", async () => {
    const poId = insertPo({ composite: "tag-6", poNumber: "PO91050", efJobNumber: "900000006" });
    const res = await server.call("PATCH", `/api/admin/pos/${poId}/region`, { userId: "ADMIN", body: { region: "Midwest" } });
    assert.equal(res.status, 404);
    const bulkRes = await server.call("POST", "/api/admin/pos/bulk/assign-region", { userId: "ADMIN", body: { ids: [poId], region: "Midwest" } });
    assert.equal(bulkRes.status, 404);
  });

  raw.close();
});

// A PO's territory -- the Budget PO Tracker's own Admin column is a more
// reliable signal than its own location match (every row has an admin
// name; the location match often doesn't resolve), so a PO's territory
// comes from the matched admin's home location first, falling back to the
// PO's own location only when the admin name doesn't match a real account.
// See server/data/db.js's poTerritory.
test("PO Tracker: a PO's territory comes from its admin, falling back to its own location", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();

  function insertPo({ composite, poNumber, adminName, locationCode }) {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, admin_name, location_code,
         lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(composite, poNumber, adminName || null, locationCode || null, now, now, now, now);
    return Number(result.lastInsertRowid);
  }

  await server.call("POST", "/api/locations", { userId: "ADMIN", body: { code: "TERRTEST-EAST", name: "East HQ Site", territory: "East" } });
  await server.call("POST", "/api/locations", { userId: "ADMIN", body: { code: "TERRTEST-WEST", name: "West Depot", territory: "West" } });

  await server.call("POST", "/api/admin/admins", { userId: "ADMIN", body: { id: "TERRADMIN1", name: "Pat Eastward", pin: "1234" } });
  await server.call("PATCH", "/api/admin/admins/TERRADMIN1/basic-info", { userId: "ADMIN", body: { homeLocationCode: "TERRTEST-EAST" } });

  await t.test("a matched admin's territory wins even when the PO's own location disagrees", async () => {
    const poId = insertPo({ composite: "terr-1", poNumber: "PO92001", adminName: "Pat Eastward", locationCode: "TERRTEST-WEST" });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, "East");
  });

  await t.test("falls back to the PO's own location when the admin name doesn't match a real account", async () => {
    const poId = insertPo({ composite: "terr-2", poNumber: "PO92002", adminName: "Nobody Real", locationCode: "TERRTEST-WEST" });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, "West");
  });

  await t.test("falls back to the PO's own location when there's no admin name at all", async () => {
    const poId = insertPo({ composite: "terr-3", poNumber: "PO92003", adminName: null, locationCode: "TERRTEST-EAST" });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, "East");
  });

  await t.test("territory is null when neither the admin nor the location resolve one", async () => {
    const poId = insertPo({ composite: "terr-4", poNumber: "PO92004", adminName: "Nobody Real", locationCode: null });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, null);
  });

  await t.test("a matched admin with no home location on file falls back to the PO's own location", async () => {
    await server.call("POST", "/api/admin/admins", { userId: "ADMIN", body: { id: "TERRADMIN2", name: "No Home Set", pin: "1234" } });
    const poId = insertPo({ composite: "terr-5", poNumber: "PO92005", adminName: "No Home Set", locationCode: "TERRTEST-WEST" });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, "West");
  });

  await t.test("a terminated admin's name no longer drives territory -- falls back to the PO's own location", async () => {
    await server.call("POST", "/api/admin/admins", { userId: "ADMIN", body: { id: "TERRADMIN3", name: "Gone Fromhere", pin: "1234" } });
    await server.call("PATCH", "/api/admin/admins/TERRADMIN3/basic-info", { userId: "ADMIN", body: { homeLocationCode: "TERRTEST-EAST" } });
    await server.call("PATCH", "/api/admin/admins/TERRADMIN3/employment-status", { userId: "ADMIN", body: { status: "terminated" } });

    const poId = insertPo({ composite: "terr-6", poNumber: "PO92006", adminName: "Gone Fromhere", locationCode: "TERRTEST-WEST" });
    const res = await server.call("GET", `/api/admin/pos/${poId}`, { userId: "ADMIN" });
    assert.equal(res.body.territory, "West");
    assert.equal(res.body.adminMatched, false);
  });

  await t.test("adminMatched is true only for a name matching a currently-active admin", async () => {
    const matched = insertPo({ composite: "terr-7", poNumber: "PO92007", adminName: "Pat Eastward", locationCode: "TERRTEST-WEST" });
    const unmatched = insertPo({ composite: "terr-8", poNumber: "PO92008", adminName: "Nobody Real", locationCode: "TERRTEST-WEST" });
    const matchedRes = await server.call("GET", `/api/admin/pos/${matched}`, { userId: "ADMIN" });
    const unmatchedRes = await server.call("GET", `/api/admin/pos/${unmatched}`, { userId: "ADMIN" });
    assert.equal(matchedRes.body.adminMatched, true);
    assert.equal(unmatchedRes.body.adminMatched, false);
  });

  await t.test("adminUnmatched filter lists POs whose admin name isn't a currently-active admin, including terminated ones", async () => {
    const res = await server.call("GET", "/api/admin/pos?adminUnmatched=true", { userId: "ADMIN" });
    const composites = res.body.map((p) => p.id);
    const unmatchedRow = await server.call("GET", `/api/admin/pos`, { userId: "ADMIN" });
    const byComposite = (name) => unmatchedRow.body.find((p) => p.adminName === name);

    assert.ok(composites.includes(byComposite("Gone Fromhere").id), "terminated admin's PO should appear");
    assert.ok(composites.includes(byComposite("Nobody Real").id), "unknown admin name's PO should appear");
    assert.ok(!composites.includes(byComposite("Pat Eastward").id), "active matched admin's PO should not appear");
  });

  raw.close();
});
