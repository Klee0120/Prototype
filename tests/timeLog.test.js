const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// The floating time-tracker widget: start/stop timers per category, plus
// (new) instant fixed-duration quick-logs for short, interrupt-driven
// tasks (entering a PO a tech just requested, attaching one to the
// Tracker) where starting/stopping a stopwatch would be its own overhead.
// Admin-only throughout.
test("Time Log: categories, start/stop timers, and instant quick-logs", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("a technician cannot reach any time-log route", async () => {
    const res = await server.call("GET", "/api/admin/time-log/categories", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("GET /categories returns the fixed timer category list", async () => {
    const res = await server.call("GET", "/api/admin/time-log/categories", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c) => c.key === "po_invoice"));
  });

  await t.test("GET /instant-categories returns the fixed instant-log list with durations", async () => {
    const res = await server.call("GET", "/api/admin/time-log/instant-categories", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const poEntered = res.body.find((c) => c.key === "po_entered_tech_ordered");
    const poAttached = res.body.find((c) => c.key === "po_attached_tracker");
    assert.equal(poEntered.minutes, 2);
    assert.equal(poEntered.label, "PO Entered (Tech Ordered)");
    assert.equal(poAttached.minutes, 1);
  });

  await t.test("nothing is running yet", async () => {
    const res = await server.call("GET", "/api/admin/time-log/current", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });

  let runningId;
  await t.test("starting a category begins a running timer", async () => {
    const res = await server.call("POST", "/api/admin/time-log/start", { userId: "ADMIN", body: { category: "vendor_onboarding" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "vendor_onboarding");
    assert.equal(res.body.endedAt, null);
    runningId = res.body.id;
  });

  await t.test("an invalid instant-log category is rejected", async () => {
    const res = await server.call("POST", "/api/admin/time-log/instant", { userId: "ADMIN", body: { category: "not_a_real_key" } });
    assert.equal(res.status, 400);
  });

  let instantEntry;
  await t.test("logging an instant entry does NOT touch the running timer", async () => {
    const res = await server.call("POST", "/api/admin/time-log/instant", { userId: "ADMIN", body: { category: "po_entered_tech_ordered" } });
    assert.equal(res.status, 201);
    instantEntry = res.body;
    assert.equal(instantEntry.category, "po_entered_tech_ordered");
    assert.ok(instantEntry.endedAt, "an instant entry is already complete, not open-ended");
    assert.notEqual(instantEntry.id, runningId);

    // The running timer (vendor_onboarding) must still be running, untouched.
    const current = await server.call("GET", "/api/admin/time-log/current", { userId: "ADMIN" });
    assert.equal(current.body.id, runningId);
    assert.equal(current.body.endedAt, null);
  });

  await t.test("the instant entry's duration matches its fixed 2-minute definition", () => {
    const row = raw.prepare("SELECT started_at, ended_at FROM time_log_entries WHERE id = ?").get(instantEntry.id);
    const minutes = (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000;
    assert.equal(minutes, 2);
  });

  await t.test("a second instant category (1 minute) logs independently", async () => {
    const res = await server.call("POST", "/api/admin/time-log/instant", { userId: "ADMIN", body: { category: "po_attached_tracker" } });
    assert.equal(res.status, 201);
    const row = raw.prepare("SELECT started_at, ended_at FROM time_log_entries WHERE id = ?").get(res.body.id);
    const minutes = (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000;
    assert.equal(minutes, 1);
  });

  await t.test("a reference note can be attached to the instant entry afterward, without reopening it", async () => {
    const res = await server.call("PATCH", `/api/admin/time-log/${instantEntry.id}`, {
      userId: "ADMIN",
      body: { note: "Request# 2000093218, Maximo# 445566" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, "Request# 2000093218, Maximo# 445566");
    assert.equal(res.body.endedAt, instantEntry.endedAt, "attaching a note never reopens/extends the entry");
  });

  let poId;
  await t.test("a real PO can be linked to the instant entry the same way a running entry links one", async () => {
    const result = raw
      .prepare(
        `INSERT INTO pos (composite_key, po_number, po_amount, status, lifecycle_status, first_imported_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Open', 'active', ?, ?, ?, ?)`
      )
      .run("tl-1", "PO99001", 500, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    poId = Number(result.lastInsertRowid);

    const res = await server.call("PATCH", `/api/admin/time-log/${instantEntry.id}`, { userId: "ADMIN", body: { relatedPoId: poId } });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedPoId, poId);
  });

  await t.test("stopping the still-running timer works normally after all the instant logging in between", async () => {
    const res = await server.call("POST", "/api/admin/time-log/stop", { userId: "ADMIN", body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, runningId);
    assert.ok(res.body.endedAt);

    const current = await server.call("GET", "/api/admin/time-log/current", { userId: "ADMIN" });
    assert.equal(current.body, null);
  });

  await t.test("listing entries returns both the timer segment and both instant logs", async () => {
    const res = await server.call("GET", "/api/admin/time-log", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const categories = res.body.map((e) => e.category);
    assert.ok(categories.includes("vendor_onboarding"));
    assert.ok(categories.includes("po_entered_tech_ordered"));
    assert.ok(categories.includes("po_attached_tracker"));
  });
});
