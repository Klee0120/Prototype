const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const { startServer } = require("./helpers");

// Two different situations create a po_request task: a tech actually
// asking for one ("tech_requested", the default/original flow), or an
// admin generating a PO after the fact because AP already has a vendor
// invoice with no PO on file at all ("ap_invoice_backfill" -- nobody
// requested this, it's reactive admin work closing a gap). They measure
// different things (see getPoRequestTurnaroundStats), so they're tracked
// as a distinct origin rather than lumped into one bucket.

test("PO request origin: ap_invoice_backfill is admin-only and produces a distinct title", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("omitting origin defaults to tech_requested", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { assignedTo: "ADMIN" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.poOrigin, "tech_requested");
  });

  await t.test("a technician cannot log an AP-invoice backfill", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { assignedTo: "ADMIN", origin: "ap_invoice_backfill" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("an admin can, and it gets a distinct title and origin", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "ADMIN",
      body: { assignedTo: "ADMIN", note: "Vendor X invoice, no PO on file", origin: "ap_invoice_backfill" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.poOrigin, "ap_invoice_backfill");
    assert.match(res.body.title, /AP Invoice Received/);
  });

  await t.test("rejects a nonsense origin value", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "ADMIN",
      body: { assignedTo: "ADMIN", origin: "something_else" },
    });
    assert.equal(res.status, 400);
  });
});

test("PO turnaround KPIs: tech-requested and AP-invoice-backfill are kept in separate buckets", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("admin-only", async () => {
    const res = await server.call("GET", "/api/tasks/po-turnaround-kpis", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("counts and averages only completed (po_generated_at set) requests, split by origin", async () => {
    const techReq = await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: { assignedTo: "ADMIN" } });
    const apReq = await server.call("POST", "/api/tasks/request-po", {
      userId: "ADMIN",
      body: { assignedTo: "ADMIN", origin: "ap_invoice_backfill" },
    });
    // A still-open request (no po_generated_at yet) shouldn't count at all.
    await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: { assignedTo: "ADMIN" } });

    const now = new Date();
    const techCreatedAt = new Date(now.getTime() - 10 * 3600000).toISOString(); // 10h turnaround
    const apCreatedAt = new Date(now.getTime() - 50 * 3600000).toISOString(); // 50h turnaround
    raw.prepare("UPDATE tasks SET created_at = ?, po_generated_at = ? WHERE id = ?").run(techCreatedAt, now.toISOString(), techReq.body.id);
    raw.prepare("UPDATE tasks SET created_at = ?, po_generated_at = ? WHERE id = ?").run(apCreatedAt, now.toISOString(), apReq.body.id);

    const res = await server.call("GET", "/api/tasks/po-turnaround-kpis", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.techRequested.count, 1);
    assert.ok(Math.abs(res.body.techRequested.avgHours - 10) < 0.1, `expected ~10h, got ${res.body.techRequested.avgHours}`);
    assert.equal(res.body.apInvoiceBackfill.count, 1);
    assert.ok(Math.abs(res.body.apInvoiceBackfill.avgHours - 50) < 0.1, `expected ~50h, got ${res.body.apInvoiceBackfill.avgHours}`);
  });

  raw.close();
});
