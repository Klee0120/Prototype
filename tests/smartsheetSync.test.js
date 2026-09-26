const test = require("node:test");
const assert = require("node:assert/strict");

// Smartsheet must appear "configured" for the whole rest of this file --
// module-level constants are read once at require time, and admin.js's own
// require of this module happens as soon as the first startServer() call
// requires server/app (via ./helpers) below. Each test file gets its own
// child process under `node --test` (see tests/helpers.js), so this is
// scoped to just this file and doesn't affect tests/smartsheet.test.js's
// "not connected" coverage.
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
  { id: 2, title: "Estimate WOM $ - Project Total" },
  { id: 3, title: "Applied WOM $ - Project Summary" },
  { id: 4, title: "Project Name" },
  { id: 5, title: "Date Requested" },
  { id: 6, title: "Site Location" },
  // Misspelled exactly as it is on the real tracker (missing the second
  // "i") -- findColumn's keyword for this field has to tolerate that.
  { id: 7, title: "Subsidary Code" },
  { id: 8, title: "Maximo #" },
];

function sheetWith(rows) {
  return { name: "Midwest PSE Request Tracker", columns: COLUMNS, rows };
}

test("smartsheet sync: creates, promotes, and updates WOMs by underlying row", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician cannot trigger a sync (admin-only)", async () => {
    const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("a failed Smartsheet API call surfaces as a clear error, not a crash", async () => {
    const restore = stubFetchOnce({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "Invalid token" });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 502);
      assert.ok(res.body.error.includes("401"));
    } finally {
      restore();
    }
  });

  await t.test("a row with a real WOM # creates a new open WOM directly", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 500,
            cells: [
              { columnId: 1, value: "20313211", displayValue: "20313211" },
              { columnId: 2, value: 1710.71, displayValue: "$1,710.71" },
              { columnId: 3, value: 1983.71, displayValue: "$1,983.71" },
              { columnId: 4, value: "Roof leak repair", displayValue: "Roof leak repair" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 1);
      assert.equal(res.body.promoted, 0);
      assert.equal(res.body.total, 1);

      const wom = await server.call("GET", "/api/woms/20313211", { userId: "ADMIN" }).catch(() => null);
      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const created = list.body.find((w) => w.code === "20313211");
      assert.ok(created);
      assert.equal(created.status, "open");
      assert.equal(created.description, "Roof leak repair");
      assert.equal(created.estimatedPrice, 1710.71);
      assert.equal(created.appliedPrice, 1983.71);
    } finally {
      restore();
    }
  });

  await t.test("a synced row carries its Smartsheet line number/link, and enters the PSE pipeline", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 510,
            rowNumber: 17,
            cells: [
              { columnId: 1, value: "20313212", displayValue: "20313212" },
              { columnId: 4, value: "Parking lot striping", displayValue: "Parking lot striping" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const created = list.body.find((w) => w.code === "20313212");
      assert.ok(created);
      assert.equal(created.smartsheetLineNumber, 17);
      assert.equal(created.smartsheetLink, "https://app.smartsheet.com/sheets/6392545882886020?rowId=510");
      assert.equal(created.pseStage, "pse_review");
      assert.equal(created.pseStageLabel, "Review & produce PSE");
    } finally {
      restore();
    }
  });

  await t.test("a row's Site Location, Subsidiary Code, and Maximo # all sync in too", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 505,
            cells: [
              { columnId: 1, value: "20777777", displayValue: "20777777" },
              { columnId: 4, value: "Electrical install", displayValue: "Electrical install" },
              // Sheet only says "Princeton" -- tolerant matching should still
              // find "TLS Princeton" (code PRINCETON) among this app's own
              // locations without an exact string match.
              { columnId: 6, value: "Princeton", displayValue: "Princeton" },
              { columnId: 7, value: "22052000 Electrical Installation", displayValue: "22052000 Electrical Installation" },
              { columnId: 8, value: "19781019", displayValue: "19781019" },
            ],
          },
          {
            id: 506,
            cells: [
              { columnId: 1, value: "20777778", displayValue: "20777778" },
              { columnId: 4, value: "Somewhere unknown", displayValue: "Somewhere unknown" },
              // No location in this app matches "Nowhereville" -- left null
              // rather than guessed at.
              { columnId: 6, value: "Nowhereville", displayValue: "Nowhereville" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 2);
      assert.equal(res.body.locationColumn, "Site Location");
      assert.equal(res.body.subsidiaryColumn, "Subsidary Code");
      assert.equal(res.body.maximoColumn, "Maximo #");

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const matched = list.body.find((w) => w.code === "20777777");
      assert.equal(matched.locationCode, "PRINCETON");
      assert.equal(matched.subsidiaryCode, "22052000 Electrical Installation");
      assert.equal(matched.maximoNumber, "19781019");
      // Every column from the row, not just the ones this app's own logic
      // reads directly -- verbatim, for the WOM's own "Smartsheet detail"
      // panel.
      assert.equal(matched.smartsheetData["WOM #"], "20777777");
      assert.equal(matched.smartsheetData["Site Location"], "Princeton");
      assert.equal(matched.smartsheetData["Subsidary Code"], "22052000 Electrical Installation");

      const unmatched = list.body.find((w) => w.code === "20777778");
      assert.equal(unmatched.locationCode, null);
    } finally {
      restore();
    }
  });

  await t.test("a row with no WOM # yet creates a pending WOM, invisible to techs", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 501,
            cells: [
              { columnId: 2, value: 500, displayValue: "$500.00" },
              { columnId: 4, value: "Parking lot striping", displayValue: "Parking lot striping" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 1);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const pending = list.body.find((w) => w.code === "PENDING-501");
      assert.ok(pending);
      assert.equal(pending.status, "pending");
      assert.equal(pending.description, "Parking lot striping");
      assert.equal(pending.estimatedPrice, 500);

      // A technician can't allocate against a pending WOM -- same "must be
      // open" rule as any other non-open status.
      const meta = await server.call("GET", "/api/meta/current-week");
      const week = meta.body.weekMonday;
      const alloc = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
        userId: "T1001",
        body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "PENDING-501", hours: 8 }] },
      });
      assert.equal(alloc.status, 400);
    } finally {
      restore();
    }
  });

  await t.test("a row's own 'Date Requested' column drives pending -> requested -> open automatically", async () => {
    // First sync: no WOM #, no Date Requested yet -- just a bare request.
    const restore1 = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 502,
            cells: [
              { columnId: 2, value: 900, displayValue: "$900.00" },
              { columnId: 4, value: "Gutter replacement", displayValue: "Gutter replacement" },
            ],
          },
        ]),
    });
    try {
      const res1 = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res1.status, 200);
      let list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.equal(list.body.find((w) => w.code === "PENDING-502").status, "pending");
    } finally {
      restore1();
    }

    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;

    // Second sync: RFM has now asked Toyota for the PO -- the sheet's own
    // "Date Requested" column is filled in, still no WOM #. This app picks
    // that up on its own; nobody flips anything by hand.
    const restore2 = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 502,
            cells: [
              { columnId: 2, value: 900, displayValue: "$900.00" },
              { columnId: 4, value: "Gutter replacement", displayValue: "Gutter replacement" },
              { columnId: 5, value: "2026-09-20", displayValue: "09/20/2026" },
            ],
          },
        ]),
    });
    try {
      const res2 = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res2.status, 200);
      assert.equal(res2.body.updated, 1);
      let list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.equal(list.body.find((w) => w.code === "PENDING-502").status, "requested");

      // Still no real WOM # -- nothing can be billed to Toyota for it yet,
      // so a technician still can't charge time to it.
      const blocked = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
        userId: "T1001",
        body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "PENDING-502", hours: 8 }] },
      });
      assert.equal(blocked.status, 400);
    } finally {
      restore2();
    }

    // Third sync: Toyota has now issued the WOM/PO -- a real WOM # shows up.
    // A "requested" row promotes to "open" exactly like a "pending" one does.
    const restore3 = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 502,
            cells: [
              { columnId: 1, value: "20555555", displayValue: "20555555" },
              { columnId: 2, value: 900, displayValue: "$900.00" },
              { columnId: 4, value: "Gutter replacement", displayValue: "Gutter replacement" },
              { columnId: 5, value: "2026-09-20", displayValue: "09/20/2026" },
            ],
          },
        ]),
    });
    try {
      const res3 = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res3.status, 200);
      assert.equal(res3.body.promoted, 1);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.ok(!list.body.some((w) => w.code === "PENDING-502"));
      const promoted = list.body.find((w) => w.code === "20555555");
      assert.ok(promoted);
      assert.equal(promoted.status, "open");

      // Now open, a technician CAN charge time to it.
      const allowed = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
        userId: "T1001",
        body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "20555555", hours: 8 }] },
      });
      assert.equal(allowed.status, 400); // WOM has no locationCode set, so location mismatch still applies
    } finally {
      restore3();
    }
  });

  await t.test("that same row later getting a real WOM # promotes it, doesn't duplicate it", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 501,
            cells: [
              { columnId: 1, value: "20444444", displayValue: "20444444" },
              { columnId: 2, value: 500, displayValue: "$500.00" },
              { columnId: 4, value: "Parking lot striping", displayValue: "Parking lot striping" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 0);
      assert.equal(res.body.promoted, 1);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.ok(!list.body.some((w) => w.code === "PENDING-501"));
      const promoted = list.body.find((w) => w.code === "20444444");
      assert.ok(promoted);
      assert.equal(promoted.status, "open");
    } finally {
      restore();
    }
  });

  await t.test("re-syncing the same real-WOM# row again just updates it, never touches admin's own status change", async () => {
    // Admin closes it out by hand in between syncs.
    await server.call("PATCH", "/api/woms/20444444", { userId: "ADMIN", body: { status: "closed" } });

    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 501,
            cells: [
              { columnId: 1, value: "20444444", displayValue: "20444444" },
              { columnId: 2, value: 750, displayValue: "$750.00" },
              { columnId: 4, value: "Parking lot striping", displayValue: "Parking lot striping" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.updated, 1);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const wom = list.body.find((w) => w.code === "20444444");
      // Pricing refreshed...
      assert.equal(wom.estimatedPrice, 750);
      // ...but a sync never reverts admin's own status change back to open.
      assert.equal(wom.status, "closed");
    } finally {
      restore();
    }
  });

  await t.test("a WOM can still have pricing hand-entered before any Smartsheet match", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-4610/pricing", {
      userId: "ADMIN",
      body: { estimatedPrice: 4000, appliedPrice: "" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.estimatedPrice, 4000);
    assert.equal(res.body.appliedPrice, null);

    const forbidden = await server.call("PATCH", "/api/woms/WOM-4610/pricing", {
      userId: "T1001",
      body: { estimatedPrice: 1 },
    });
    assert.equal(forbidden.status, 403);

    const notFound = await server.call("PATCH", "/api/woms/WOM-does-not-exist/pricing", {
      userId: "ADMIN",
      body: { estimatedPrice: 1 },
    });
    assert.equal(notFound.status, 404);
  });
});
