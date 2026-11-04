const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");

const { startServer } = require("./helpers");

// Closes the loop a manual copy-paste reference opens: the request-po
// confirmation screen tells whoever submitted it to put "PO Request Task
// #<id>" into the Smartsheet form's Description field (see
// renderRequestPoConfirmation in techHome.js/pos.js) -- once the real PO
// shows up in a tracker import carrying that same text in its own
// Description column, the import should link the two automatically.

const HEADERS = [
  "Date Requested", "Description", "Requestor", "PO Number", "E&F Contract Job #", "PO Amount",
  "Change Order", "Status", "Vendor Name", "Vendor Number", "PPS Job Number", "E1 WOM Job #",
  "WOM Number", "Asset Number", "Maximo WO#", "Object Code", "Subsidiary", "PPS Subsidiary",
  "Admin", "Urgent", "Urgent Reason/Notes",
];

function importRow(server, description, poNumber, vendorName) {
  const rows = [
    HEADERS,
    ["2026-01-01", description, "Jane Doe", poNumber, null, 100, null, "Open", vendorName, "1001", null, null, null, null, null, null, "100 Primary", null, "Krista Lee", null, null],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "PO Tracking");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return server.upload("/api/admin/pos/import", {
    userId: "ADMIN",
    fields: {},
    fileName: "po-tracker.xlsx",
    fileContent: buffer,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

test("PO Tracker import: links a po_request task via its 'PO Request Task #<id>' reference in Description", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const requestRes = await server.call("POST", "/api/tasks/request-po", {
    userId: "T1001",
    body: { assignedTo: "ADMIN", note: "Need a PO for a general parts order" },
  });
  assert.equal(requestRes.status, 201);
  const taskId = requestRes.body.id;

  await t.test("a row whose Description carries the reference links the task to that PO", async () => {
    const importRes = await importRow(server, `New vendor order. PO Request Task #${taskId}`, "PO95001", "Linked Vendor Co");
    assert.equal(importRes.status, 200, JSON.stringify(importRes.body));

    const taskRes = await server.call("GET", `/api/tasks/${taskId}`, { userId: "ADMIN" });
    assert.equal(taskRes.status, 200);
    assert.ok(taskRes.body.matchedPoId, "expected matchedPoId to be set");
    assert.equal(taskRes.body.matchedPoNumber, "PO95001");
    assert.equal(taskRes.body.matchedPoVendorName, "Linked Vendor Co");

    const auditRes = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    assert.ok(
      auditRes.body.some((a) => a.action === "PO_REQUEST_TASK_MATCHED" && a.details.includes(`task #${taskId}`)),
      "expected an audit entry for the match"
    );
  });

  await t.test("re-importing the same row again doesn't duplicate the audit entry", async () => {
    const before = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const beforeCount = before.body.filter((a) => a.action === "PO_REQUEST_TASK_MATCHED").length;

    await importRow(server, `New vendor order. PO Request Task #${taskId}`, "PO95001", "Linked Vendor Co");

    const after = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const afterCount = after.body.filter((a) => a.action === "PO_REQUEST_TASK_MATCHED").length;
    assert.equal(afterCount, beforeCount, "already-linked task/PO pair shouldn't re-match on every import");
  });

  await t.test("a Description with no reference links nothing", async () => {
    const otherTaskRes = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { assignedTo: "ADMIN" },
    });
    const otherTaskId = otherTaskRes.body.id;

    await importRow(server, "No reference here at all", "PO95002", "Unrelated Vendor");

    const taskRes = await server.call("GET", `/api/tasks/${otherTaskId}`, { userId: "ADMIN" });
    assert.equal(taskRes.body.matchedPoId, null);
  });

  await t.test("a reference to a non-existent task id doesn't error the import", async () => {
    const importRes = await importRow(server, "PO Request Task #999999", "PO95003", "Another Vendor");
    assert.equal(importRes.status, 200, JSON.stringify(importRes.body));
  });

  await t.test("a reference to a real task that isn't a po_request task is ignored", async () => {
    const manualTaskRes = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Some manual task", category: "manual" },
    });
    assert.equal(manualTaskRes.status, 201);
    const manualTaskId = manualTaskRes.body.id;

    const importRes = await importRow(server, `PO Request Task #${manualTaskId}`, "PO95004", "Yet Another Vendor");
    assert.equal(importRes.status, 200, JSON.stringify(importRes.body));

    const taskRes = await server.call("GET", `/api/tasks/${manualTaskId}`, { userId: "ADMIN" });
    assert.equal(taskRes.body.matchedPoId, null);
  });
});
