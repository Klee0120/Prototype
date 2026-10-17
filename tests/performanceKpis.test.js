const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const { startServer } = require("./helpers");

// Performance tab KPIs -- average time to generate a requested PO, vendor
// compliance cases resolved, and reclass request-to-submission turnaround,
// each attributed to whoever actually did the work (not just whoever a
// task happens to be assigned to right now). See db.getPerformanceKpis.

test("Performance KPIs: everyone with an active account starts at zero", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const res = await server.call("GET", "/api/admin/performance-kpis", { userId: "ADMIN" });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, "expected at least the seeded admin/techs");
  const admin = res.body.find((r) => r.id === "ADMIN");
  assert.ok(admin);
  assert.equal(admin.role, "admin");
  assert.equal(admin.poRequestsGenerated, 0);
  assert.equal(admin.poRequestsAvgHours, null);
  assert.equal(admin.vendorDocsCompleted, 0);
  assert.equal(admin.reclassSubmitted, 0);
  assert.equal(admin.reclassAvgHours, null);
});

test("Performance KPIs: PO generation is attributed to whoever actually generated it, not whoever it's assigned to", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  const reqRes = await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: { assignedTo: "ADMIN" } });
  const taskId = reqRes.body.id;
  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Perf Test Vendor" } });
  const vendorId = vendorRes.body.id;

  await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "task", relatedId: String(taskId), category: "po_document" },
    fileName: "po.pdf",
    mimeType: "application/pdf",
  });
  const genRes = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
    userId: "ADMIN",
    body: { vendorId, poEmail: "vendor@example.com" },
  });
  assert.equal(genRes.status, 200, JSON.stringify(genRes.body));

  // Backdate so there's a real, checkable turnaround figure.
  raw.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 3600000).toISOString(), taskId);

  const res = await server.call("GET", "/api/admin/performance-kpis", { userId: "ADMIN" });
  const admin = res.body.find((r) => r.id === "ADMIN");
  assert.equal(admin.poRequestsGenerated, 1);
  assert.ok(admin.poRequestsAvgHours > 5 && admin.poRequestsAvgHours < 7, `expected ~6h, got ${admin.poRequestsAvgHours}`);

  raw.close();
});

test("Performance KPIs: vendor compliance cases resolved and reclass turnaround", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Compliance Test Vendor" } });
  const vendorId = vendorRes.body.id;
  const caseRes = await server.call("POST", `/api/admin/vendors/${vendorId}/requests`, {
    userId: "ADMIN",
    body: { requestType: "Status Update", status: "Waiting on COI" },
  });
  const requestId = caseRes.body[0].id;
  await server.call("PATCH", `/api/admin/vendors/${vendorId}/requests/${requestId}`, {
    userId: "ADMIN",
    body: { requestType: "Status Update", status: "COI received" },
  });

  raw.prepare("INSERT INTO locations (code, name, territory) VALUES (?, ?, ?)").run("PERFLOC", "Perf Site", "Midwest");
  raw.prepare("INSERT INTO woms (code, description, status, location_code) VALUES (?, ?, 'open', ?)").run("WOM-PERF-1", "Perf job", "PERFLOC");
  const itemRes = await server.call("POST", "/api/admin/reclasses/items", {
    userId: "ADMIN",
    body: { fromWomNumber: "WOM-PERF-1", fromAmount: 300, comments: "perf test" },
  });
  const itemId = itemRes.body.id;
  raw.prepare("UPDATE reclass_items SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 3600000).toISOString(), itemId);
  const submitRes = await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, {
    userId: "ADMIN",
    body: { status: "submitted" },
  });
  assert.equal(submitRes.status, 200);
  assert.equal(submitRes.body.submittedBy, "ADMIN");
  assert.ok(submitRes.body.submittedAt);

  const res = await server.call("GET", "/api/admin/performance-kpis", { userId: "ADMIN" });
  const admin = res.body.find((r) => r.id === "ADMIN");
  // Only an explicit update counts as "resolved" -- creating the case in
  // the first place doesn't set updated_by (see db.addVendorRequest).
  assert.equal(admin.vendorDocsCompleted, 1);
  assert.equal(admin.reclassSubmitted, 1);
  assert.ok(admin.reclassAvgHours > 2.5 && admin.reclassAvgHours < 3.5, `expected ~3h, got ${admin.reclassAvgHours}`);

  // Editing it again while it stays submitted doesn't re-stamp submitted_at.
  const firstSubmittedAt = submitRes.body.submittedAt;
  await server.call("PATCH", `/api/admin/reclasses/items/${itemId}`, {
    userId: "ADMIN",
    body: { status: "submitted", comments: "updated comment" },
  });
  const afterRes = await server.call("GET", "/api/admin/reclasses/items", { userId: "ADMIN" });
  const afterItem = afterRes.body.find((i) => i.id === itemId);
  assert.equal(afterItem.submittedAt, firstSubmittedAt, "submitted_at shouldn't move on a later edit");

  raw.close();
});

test("Performance KPIs: from/to date range scopes by each metric's own completion date", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  const reqRes = await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: { assignedTo: "ADMIN" } });
  const taskId = reqRes.body.id;
  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Range Test Vendor" } });
  await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "task", relatedId: String(taskId), category: "po_document" },
    fileName: "po.pdf",
    mimeType: "application/pdf",
  });
  await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
    userId: "ADMIN",
    body: { vendorId: vendorRes.body.id, poEmail: "vendor@example.com" },
  });
  // Mark it generated a long time ago, outside any recent range.
  raw.prepare("UPDATE tasks SET po_generated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", taskId);

  const farFuture = await server.call("GET", "/api/admin/performance-kpis?from=2030-01-01", { userId: "ADMIN" });
  assert.equal(farFuture.body.find((r) => r.id === "ADMIN").poRequestsGenerated, 0);

  const coveringRange = await server.call("GET", "/api/admin/performance-kpis?from=2019-01-01&to=2021-01-01", { userId: "ADMIN" });
  assert.equal(coveringRange.body.find((r) => r.id === "ADMIN").poRequestsGenerated, 1);

  raw.close();
});

test("Performance KPIs: admin-only", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const res = await server.call("GET", "/api/admin/performance-kpis", { userId: "T1001" });
  assert.equal(res.status, 403);
});
