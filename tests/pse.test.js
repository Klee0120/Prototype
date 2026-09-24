const test = require("node:test");
const assert = require("node:assert/strict");

// Same reasoning as tests/smartsheetSync.test.js -- each test file gets its
// own child process, so this is scoped to just this file.
process.env.SMARTSHEET_API_TOKEN = "test-token";
process.env.SMARTSHEET_SHEET_ID = "6392545882886020";

const { startServer } = require("./helpers");

function stubFetchOnce(response) {
  const original = global.fetch;
  global.fetch = async (url, ...rest) => {
    if (typeof url === "string" && url.startsWith("https://api.smartsheet.com/")) return response;
    return original(url, ...rest);
  };
  return () => {
    global.fetch = original;
  };
}

const COLUMNS = [
  { id: 1, title: "WOM #" },
  { id: 4, title: "Project Name" },
];

function sheetWith(rows) {
  return { name: "Midwest PSE Request Tracker", columns: COLUMNS, rows };
}

async function syncOneOpenWom(server, code, rowId) {
  const restore = stubFetchOnce({
    ok: true,
    json: async () =>
      sheetWith([{ id: rowId, cells: [{ columnId: 1, value: code, displayValue: code }, { columnId: 4, value: "Test job", displayValue: "Test job" }] }]),
  });
  try {
    const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
    assert.equal(res.status, 200);
  } finally {
    restore();
  }
}

test("PSE pipeline: stage transitions, roles, holds, and the schedule-block flag", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  // Kevin doesn't exist until a subtest below creates him -- helpers.js's
  // userId shortcut only knows the seeded demo accounts, so log in for real
  // once he exists and reuse this token, same pattern admin.test.js uses
  // for a freshly-created admin account.
  let kevinToken;

  await t.test("a WOM synced from Smartsheet enters the pipeline at pse_review", async () => {
    await syncOneOpenWom(server, "30000001", 900);
    const res = await server.call("GET", "/api/woms/30000001/lookup", { userId: "ADMIN" });
    assert.equal(res.body.pseStage, "pse_review");
    assert.equal(res.body.pseStageLabel, "Review & produce PSE");
  });

  await t.test("before a reviewer is designated, any admin can take a reviewer action", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/mark_pse_produced", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "awaiting_toyota_approval");
    assert.ok(res.body.pseFollowupAt, "expected a follow-up date to be set");
  });

  await t.test("designates Kevin as the PSE reviewer", async () => {
    const create = await server.call("POST", "/api/admin/admins", { userId: "ADMIN", body: { id: "KEVIN", name: "Kevin", pin: "5555" } });
    assert.equal(create.status, 201);

    const setReviewer = await server.call("PATCH", "/api/admin/admins/KEVIN/pse-reviewer", { userId: "ADMIN", body: { isPseReviewer: true } });
    assert.equal(setReviewer.status, 200);
    assert.equal(setReviewer.body.isPseReviewer, true);

    const admins = await server.call("GET", "/api/admin/admins", { userId: "ADMIN" });
    assert.equal(admins.body.find((a) => a.id === "ADMIN").isPseReviewer, false);

    const login = await server.call("POST", "/api/auth/login", { body: { id: "KEVIN", pin: "5555" } });
    assert.equal(login.status, 200);
    kevinToken = login.body.token;
  });

  await t.test("once a reviewer is set, a non-reviewer admin can't take a reviewer-only action", async () => {
    // Re-uses the same WOM (still at awaiting_toyota_approval).
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/toyota_approved", { userId: "ADMIN" });
    assert.equal(res.status, 403);
  });

  await t.test("a technician can't call any PSE endpoint", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/toyota_approved", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("an action from the wrong stage is rejected", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/mark_invoiced", { token: kevinToken });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Awaiting Toyota approval/);
  });

  await t.test("an unknown action is rejected", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/nope", { token: kevinToken });
    assert.equal(res.status, 400);
  });

  await t.test("Kevin can snooze the follow-up without changing stage", async () => {
    const before = await server.call("GET", "/api/woms/30000001/lookup", { userId: "ADMIN" });
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/snooze_followup", { token: kevinToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "awaiting_toyota_approval");
    assert.notEqual(res.body.pseFollowupAt, before.body.pseFollowupAt);
  });

  await t.test("Kevin approves Toyota, moving it to Admin's list", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/toyota_approved", { token: kevinToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "generate_wom_po");
    assert.equal(res.body.pseFollowupAt, null);
  });

  await t.test("Kevin (reviewer) can't take a financial-only action", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/generated_with_po", { token: kevinToken });
    assert.equal(res.status, 403);
  });

  await t.test("Admin generates the WOM/PO but it's still missing the Toyota PO -- goes back to Kevin", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/generated_missing_po", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "awaiting_toyota_po");
    assert.ok(res.body.pseFollowupAt);
  });

  await t.test("Kevin confirms the PO arrived -- ready to schedule (no block set)", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/po_received", { token: kevinToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "ready_to_schedule");
    assert.equal(res.body.pseFollowupAt, null);
  });

  await t.test("marking the WOM complete (as a tech) advances it to check_expenses", async () => {
    const res = await server.call("POST", "/api/woms/30000001/complete", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "closed");
    assert.equal(res.body.pseStage, "check_expenses");
  });

  await t.test("Admin can put it on hold with a fixed reason", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/hold", { userId: "ADMIN", body: { holdReason: "vendor_invoice" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseHoldReason, "vendor_invoice");
    assert.equal(res.body.pseStage, "check_expenses");
  });

  await t.test("an invalid hold reason is rejected", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/hold", { userId: "ADMIN", body: { holdReason: "bogus" } });
    assert.equal(res.status, 400);
  });

  await t.test("holding with 'other' keeps the free-text note; a fixed reason doesn't", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/hold", {
      userId: "ADMIN",
      body: { holdReason: "other", holdNote: "waiting on RFM sign-off" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseHoldNote, "waiting on RFM sign-off");
  });

  await t.test("clearing the hold", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/hold", { userId: "ADMIN", body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseHoldReason, null);
    assert.equal(res.body.pseHoldNote, null);
  });

  await t.test("Admin sends it for Status 95 approval", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/send_status95", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "pending_status95_approval");
  });

  await t.test("Kevin rejects it (not sufficient), sending it back to check_expenses", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/reject_status95", { token: kevinToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "check_expenses");
  });

  await t.test("Admin re-sends, and Kevin approves this time", async () => {
    await server.call("POST", "/api/woms/30000001/pse/actions/send_status95", { userId: "ADMIN" });
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/approve_status95", { token: kevinToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "ready_to_invoice");
  });

  await t.test("Admin marks it invoiced -- closes the pipeline and flips WOM status to invoiced", async () => {
    const res = await server.call("POST", "/api/woms/30000001/pse/actions/mark_invoiced", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.pseStage, "closed");
    assert.equal(res.body.status, "invoiced");
  });

  await t.test("a closed WOM never shows up in anyone's task list", async () => {
    const asAdmin = await server.call("GET", "/api/woms/pse/tasks", { userId: "ADMIN" });
    const asKevin = await server.call("GET", "/api/woms/pse/tasks", { token: kevinToken });
    assert.ok(!asAdmin.body.tasks.some((w) => w.code === "30000001"));
    assert.ok(!asKevin.body.tasks.some((w) => w.code === "30000001"));
  });

  await t.test("the schedule-block flag routes a ready-to-issue WOM back to Kevin instead of ready_to_schedule", async () => {
    await syncOneOpenWom(server, "30000002", 901);
    await server.call("POST", "/api/woms/30000002/pse/actions/mark_pse_produced", { token: kevinToken });
    await server.call("POST", "/api/woms/30000002/pse/actions/toyota_approved", { token: kevinToken });

    const block = await server.call("POST", "/api/woms/30000002/pse/schedule-block", { userId: "ADMIN", body: { blocked: true } });
    assert.equal(block.status, 200);
    assert.equal(block.body.pseScheduleBlock, true);

    const generated = await server.call("POST", "/api/woms/30000002/pse/actions/generated_with_po", { userId: "ADMIN" });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.pseStage, "schedule_blocked");

    const cleared = await server.call("POST", "/api/woms/30000002/pse/actions/clear_schedule_block", { token: kevinToken });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.pseStage, "ready_to_schedule");
  });

  await t.test("PSE tasks are split by role: Kevin sees reviewer stages, Admin sees financial stages", async () => {
    // 30000002 is currently ready_to_schedule (role: null) -- shows up for neither.
    const asAdmin = await server.call("GET", "/api/woms/pse/tasks", { userId: "ADMIN" });
    const asKevin = await server.call("GET", "/api/woms/pse/tasks", { token: kevinToken });
    assert.ok(!asAdmin.body.tasks.some((w) => w.code === "30000002"));
    assert.ok(!asKevin.body.tasks.some((w) => w.code === "30000002"));
    assert.equal(asAdmin.body.reviewerAdminId, "KEVIN");
  });
});
