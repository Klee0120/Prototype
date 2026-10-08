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

// Follow-up round: Enter WOM (5 min) / Enter PO Invoice-Found (15 min),
// the new plain timer categories (Order Supplies, Uniform Ordering,
// Timekeeping - Enter UKG), the Vendor Correspondence end-of-day
// self-reported log, and assigning a technician to a Timekeeping segment.
test("Time Log: Enter WOM/Invoice-Found durations, new timer categories, estimated log, and tech-link", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("the new timer categories exist alongside the originals", async () => {
    const res = await server.call("GET", "/api/admin/time-log/categories", { userId: "ADMIN" });
    const keys = res.body.map((c) => c.key);
    assert.ok(keys.includes("order_supplies"));
    assert.ok(keys.includes("uniform_ordering"));
    assert.ok(keys.includes("timekeeping_ukg"));
    assert.ok(keys.includes("timekeeping"));
  });

  await t.test("Enter WOM logs a fixed 5-minute instant entry", async () => {
    const res = await server.call("POST", "/api/admin/time-log/instant", { userId: "ADMIN", body: { category: "enter_wom" } });
    assert.equal(res.status, 201);
    const row = raw.prepare("SELECT started_at, ended_at FROM time_log_entries WHERE id = ?").get(res.body.id);
    const minutes = (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000;
    assert.equal(minutes, 5);
  });

  await t.test("Enter PO (Invoice Found, Missed Order) logs a fixed 15-minute instant entry", async () => {
    const res = await server.call("POST", "/api/admin/time-log/instant", { userId: "ADMIN", body: { category: "enter_po_invoice_found" } });
    assert.equal(res.status, 201);
    const row = raw.prepare("SELECT started_at, ended_at FROM time_log_entries WHERE id = ?").get(res.body.id);
    const minutes = (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000;
    assert.equal(minutes, 15);
  });

  await t.test("GET /estimated-categories returns Vendor Correspondence", async () => {
    const res = await server.call("GET", "/api/admin/time-log/estimated-categories", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((c) => c.key === "vendor_correspondence"));
  });

  await t.test("an estimated log rejects a non-positive or missing minutes value", async () => {
    const zero = await server.call("POST", "/api/admin/time-log/estimated", { userId: "ADMIN", body: { category: "vendor_correspondence", minutes: 0 } });
    assert.equal(zero.status, 400);
    const missing = await server.call("POST", "/api/admin/time-log/estimated", { userId: "ADMIN", body: { category: "vendor_correspondence" } });
    assert.equal(missing.status, 400);
  });

  await t.test("an estimated log rejects an unreasonably large minutes value", async () => {
    const res = await server.call("POST", "/api/admin/time-log/estimated", { userId: "ADMIN", body: { category: "vendor_correspondence", minutes: 10000 } });
    assert.equal(res.status, 400);
  });

  await t.test("a self-reported 45-minute Vendor Correspondence entry logs with that exact duration", async () => {
    const res = await server.call("POST", "/api/admin/time-log/estimated", {
      userId: "ADMIN",
      body: { category: "vendor_correspondence", minutes: 45, note: "Called three vendors re: COI renewals" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "vendor_correspondence");
    assert.ok(res.body.endedAt, "an estimated entry is already complete, not open-ended");
    assert.equal(res.body.note, "Called three vendors re: COI renewals");
    const row = raw.prepare("SELECT started_at, ended_at FROM time_log_entries WHERE id = ?").get(res.body.id);
    const minutes = (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000;
    assert.equal(minutes, 45);
  });

  await t.test("an estimated log never touches a running timer", async () => {
    const start = await server.call("POST", "/api/admin/time-log/start", { userId: "ADMIN", body: { category: "ops_meeting" } });
    const runningId = start.body.id;
    await server.call("POST", "/api/admin/time-log/estimated", { userId: "ADMIN", body: { category: "vendor_correspondence", minutes: 20 } });
    const current = await server.call("GET", "/api/admin/time-log/current", { userId: "ADMIN" });
    assert.equal(current.body.id, runningId);
    assert.equal(current.body.endedAt, null);
    await server.call("POST", "/api/admin/time-log/stop", { userId: "ADMIN", body: {} });
  });

  await t.test("starting a Timekeeping (Review of Tech) segment can assign a tech", async () => {
    const res = await server.call("POST", "/api/admin/time-log/start", {
      userId: "ADMIN",
      body: { category: "timekeeping", relatedTechId: "T1001" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.relatedTechId, "T1001");
  });

  await t.test("the tech assignment can be changed while the segment is still running", async () => {
    const current = await server.call("GET", "/api/admin/time-log/current", { userId: "ADMIN" });
    const res = await server.call("PATCH", `/api/admin/time-log/${current.body.id}`, { userId: "ADMIN", body: { relatedTechId: "T1002" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedTechId, "T1002");
  });

  await t.test("stopping can also set (or confirm) the tech assignment", async () => {
    const res = await server.call("POST", "/api/admin/time-log/stop", { userId: "ADMIN", body: { relatedTechId: "T1003" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedTechId, "T1003");
    assert.ok(res.body.endedAt);
  });

  await t.test("Timekeeping - Enter UKG also supports a tech assignment, same as Timekeeping Review", async () => {
    const res = await server.call("POST", "/api/admin/time-log/start", {
      userId: "ADMIN",
      body: { category: "timekeeping_ukg", relatedTechId: "T1001" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.relatedTechId, "T1001");
    await server.call("POST", "/api/admin/time-log/stop", { userId: "ADMIN", body: {} });
  });

  await t.test("an unrelated category (e.g. Order Supplies/Parts) still accepts a relatedTechId field but it's simply unused context", async () => {
    // relatedTechId is stored whenever given -- the widget just never shows
    // the tech-link UI for a category that isn't Timekeeping/UKG. Confirms
    // the backend doesn't reject it outright for other categories.
    const res = await server.call("POST", "/api/admin/time-log/start", {
      userId: "ADMIN",
      body: { category: "order_supplies" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.relatedTechId, null);
    await server.call("POST", "/api/admin/time-log/stop", { userId: "ADMIN", body: {} });
  });
});
