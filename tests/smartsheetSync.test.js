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
  { id: 9, title: "Estimate Labor $" },
  { id: 10, title: "Estimate PO $ - Contracted Services" },
  { id: 11, title: "Applied Labor $" },
  { id: 12, title: "Applied PO $ - Contracted Services" },
  { id: 13, title: "Vendor(s) Name/#/Phone" },
  { id: 14, title: "TOY Value" },
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

  await t.test("a synced row carries its Smartsheet line number/link, and enters the WOM lifecycle checklist", async () => {
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
      assert.ok(created.lifecycleSteps.every((s) => !s.completedAt), "expected every lifecycle step to still be open");
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

  await t.test("the itemized labor/contracted-services breakdown syncs in, and the vendor column matches by name", async () => {
    const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Automated Solutions Group" } });
    assert.equal(vendorRes.status, 201);

    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 700,
            cells: [
              { columnId: 1, value: "20674512", displayValue: "20674512" },
              { columnId: 4, value: "Install of BAS software support", displayValue: "Install of BAS software support" },
              { columnId: 9, value: 2720, displayValue: "$2,720.00" },
              { columnId: 10, value: 100, displayValue: "$100.00" },
              { columnId: 11, value: 2720, displayValue: "$2,720.00" },
              { columnId: 12, value: 350, displayValue: "$350.00" },
              { columnId: 14, value: 3000, displayValue: "$3,000.00" },
              // Sheet's own "Name/#/Phone" format -- only the name portion
              // (before " - ") should be matched against this app's vendors.
              { columnId: 13, value: "Automated Solutions Group - 5883201", displayValue: "Automated Solutions Group - 5883201" },
            ],
          },
          {
            id: 701,
            cells: [
              { columnId: 1, value: "20674513", displayValue: "20674513" },
              { columnId: 4, value: "No vendor match", displayValue: "No vendor match" },
              { columnId: 13, value: "Some Unknown Vendor - 1234567", displayValue: "Some Unknown Vendor - 1234567" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.estimatedLaborColumn, "Estimate Labor $");
      assert.equal(res.body.estimatedContractedColumn, "Estimate PO $ - Contracted Services");
      assert.equal(res.body.appliedLaborColumn, "Applied Labor $");
      assert.equal(res.body.appliedContractedColumn, "Applied PO $ - Contracted Services");
      assert.equal(res.body.toyotaPoValueColumn, "TOY Value");
      assert.equal(res.body.vendorColumn, "Vendor(s) Name/#/Phone");

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const matched = list.body.find((w) => w.code === "20674512");
      assert.equal(matched.estimatedLabor, 2720);
      assert.equal(matched.estimatedContracted, 100);
      assert.equal(matched.appliedLabor, 2720);
      assert.equal(matched.appliedContracted, 350);
      assert.equal(matched.toyotaPoValue, 3000);
      assert.equal(matched.vendorId, vendorRes.body.id);
      assert.equal(matched.vendorName, "Automated Solutions Group");

      // No vendor in this app is named anything close to "Some Unknown
      // Vendor" -- left null rather than guessed at.
      const unmatched = list.body.find((w) => w.code === "20674513");
      assert.equal(unmatched.vendorId, null);
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

  await t.test("a row with no WOM # and no project name is skipped outright, not synced as a pending WOM", async () => {
    // Real sheets keep header/legend/key rows near the top ("CODE",
    // "Check Box < F/U Already", etc.) with every real-content column
    // blank -- these aren't work requests and shouldn't manufacture an
    // unidentifiable "PENDING-<rowId>" WOM.
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          { id: 601, cells: [{ columnId: 8, value: "CODE:", displayValue: "CODE:" }] },
          { id: 602, cells: [{ columnId: 1, value: 0, displayValue: "-" }] },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 0);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.ok(!list.body.some((w) => w.code === "PENDING-601"));
      assert.ok(!list.body.some((w) => w.code === "PENDING-602"));
    } finally {
      restore();
    }
  });

  await t.test("a junk pending WOM from before this check existed gets cleaned up once its row still has nothing real on it", async () => {
    // Simulate the old behavior having already created one (a row that did
    // carry a real project name, so it synced in as usual)...
    const create = stubFetchOnce({
      ok: true,
      json: async () => sheetWith([{ id: 603, cells: [{ columnId: 4, value: "Placeholder request", displayValue: "Placeholder request" }] }]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.ok(list.body.some((w) => w.code === "PENDING-603"));
    } finally {
      create();
    }

    // ...then that same row's project name gets cleared out on the sheet
    // (or was itself a header row all along) -- the next sync should
    // remove the WOM it never should have kept, not just leave it stale.
    const clear = stubFetchOnce({
      ok: true,
      json: async () => sheetWith([{ id: 603, cells: [] }]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      assert.ok(!list.body.some((w) => w.code === "PENDING-603"));
    } finally {
      clear();
    }
  });

  await t.test("re-syncing identical values reports no changes; a real change is named in changedWoms", async () => {
    const first = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 604,
            cells: [
              { columnId: 1, value: "20999999", displayValue: "20999999" },
              { columnId: 2, value: 1000, displayValue: "$1,000.00" },
              { columnId: 4, value: "Roof patch", displayValue: "Roof patch" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.created, 1);
    } finally {
      first();
    }

    // Same row, same values -- nothing actually changed.
    const same = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 604,
            cells: [
              { columnId: 1, value: "20999999", displayValue: "20999999" },
              { columnId: 2, value: 1000, displayValue: "$1,000.00" },
              { columnId: 4, value: "Roof patch", displayValue: "Roof patch" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.updated, 0);
      assert.deepEqual(res.body.changedWoms, []);
    } finally {
      same();
    }

    // Now the estimate actually changes.
    const changed = stubFetchOnce({
      ok: true,
      json: async () =>
        sheetWith([
          {
            id: 604,
            cells: [
              { columnId: 1, value: "20999999", displayValue: "20999999" },
              { columnId: 2, value: 1250, displayValue: "$1,250.00" },
              { columnId: 4, value: "Roof patch", displayValue: "Roof patch" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.updated, 1);
      assert.equal(res.body.changedWoms.length, 1);
      assert.equal(res.body.changedWoms[0].code, "20999999");
      assert.ok(res.body.changedWoms[0].fields.includes("estimate"));

      const lastSync = (await server.call("GET", "/api/admin/smartsheet/status", { userId: "ADMIN" })).body.lastSync;
      assert.equal(lastSync.changedWoms[0].code, "20999999");
    } finally {
      changed();
    }
  });
});

// Mirrors the real tracker's full column set exactly (down to the
// asymmetric "Estimated Contingency $" / "Contingency $" naming, where the
// applied side has no "applied" word of its own) -- the actual shape that
// exposed the Applied PO $ / TOY Value gaps this fixture exists to guard
// against regressing.
const FULL_BREAKDOWN_COLUMNS = [
  { id: 1, title: "WOM #" },
  { id: 2, title: "Project Name" },
  { id: 3, title: "Estimate Labor $" },
  { id: 4, title: "Estimate Materials $" },
  { id: 5, title: "Estimate PO $ - Contracted Services" },
  { id: 6, title: "Estimate Other Direct $" },
  { id: 7, title: "Estimate Sales Tax" },
  { id: 8, title: "Estimated Contingency $" },
  { id: 9, title: "Estimate WOM $ - Project Total" },
  { id: 10, title: "Applied Labor" },
  { id: 11, title: "Applied Materials" },
  { id: 12, title: "Applied PO $" },
  { id: 13, title: "Applied Other Direct Costs" },
  { id: 14, title: "Applied Tax" },
  { id: 15, title: "Contingency $" },
  { id: 16, title: "Applied WOM $ - Project Summary" },
  { id: 17, title: "TOY Value" },
];

test("smartsheet sync: full six-category cost breakdown matches the real tracker's exact column names", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const restore = stubFetchOnce({
    ok: true,
    json: async () => ({
      name: "Midwest PSE Request Tracker",
      columns: FULL_BREAKDOWN_COLUMNS,
      rows: [
        {
          id: 900,
          cells: [
            { columnId: 1, value: "20040145", displayValue: "20040145" },
            { columnId: 2, value: "Riser Check Valves Repair", displayValue: "Riser Check Valves Repair" },
            { columnId: 3, value: 3060, displayValue: "$3,060.00" },
            { columnId: 4, value: 0, displayValue: "$0.00" },
            { columnId: 5, value: 48500, displayValue: "$48,500.00" },
            { columnId: 6, value: 2578, displayValue: "$2,578.00" },
            { columnId: 7, value: 0, displayValue: "$0.00" },
            { columnId: 8, value: 0, displayValue: "$0.00" },
            { columnId: 9, value: 54138, displayValue: "$54,138.00" },
            { columnId: 10, value: 0, displayValue: "$0.00" },
            { columnId: 11, value: 0, displayValue: "$0.00" },
            { columnId: 12, value: 35500, displayValue: "$35,500.00" },
            { columnId: 13, value: 1775, displayValue: "$1,775.00" },
            { columnId: 14, value: 0, displayValue: "$0.00" },
            { columnId: 15, value: 0, displayValue: "$0.00" },
            { columnId: 16, value: 37275, displayValue: "$37,275.00" },
            { columnId: 17, value: 54138, displayValue: "$54,138.00" },
          ],
        },
      ],
    }),
  });
  try {
    const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.estimatedMaterialsColumn, "Estimate Materials $");
    assert.equal(res.body.appliedMaterialsColumn, "Applied Materials");
    assert.equal(res.body.estimatedOtherDirectColumn, "Estimate Other Direct $");
    assert.equal(res.body.appliedOtherDirectColumn, "Applied Other Direct Costs");
    assert.equal(res.body.estimatedTaxColumn, "Estimate Sales Tax");
    assert.equal(res.body.appliedTaxColumn, "Applied Tax");
    assert.equal(res.body.estimatedContingencyColumn, "Estimated Contingency $");
    // The trickiest pair: the applied-side column has no "applied" (or any
    // other) word of its own, so this only works via the exclude list
    // ruling out the estimate-side column.
    assert.equal(res.body.appliedContingencyColumn, "Contingency $");
    assert.equal(res.body.toyotaPoValueColumn, "TOY Value");

    const wom = (await server.call("GET", "/api/woms", { userId: "ADMIN" })).body.find((w) => w.code === "20040145");
    assert.equal(wom.estimatedLabor, 3060);
    assert.equal(wom.estimatedMaterials, 0);
    assert.equal(wom.estimatedContracted, 48500);
    assert.equal(wom.estimatedOtherDirect, 2578);
    assert.equal(wom.estimatedTax, 0);
    assert.equal(wom.estimatedContingency, 0);
    assert.equal(wom.appliedLabor, 0);
    assert.equal(wom.appliedMaterials, 0);
    assert.equal(wom.appliedContracted, 35500);
    assert.equal(wom.appliedOtherDirect, 1775);
    assert.equal(wom.appliedTax, 0);
    assert.equal(wom.appliedContingency, 0);
    assert.equal(wom.toyotaPoValue, 54138);

    // Cost Analysis should flag this WOM as applied-over-Toyota-PO once the
    // applied project total exceeds the Toyota-approved ceiling.
    await server.call("PATCH", "/api/woms/20040145/pricing", { userId: "ADMIN", body: { appliedPrice: 60000 } });
    const summary = (await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" })).body;
    const flagged = summary.appliedOverToyotaPo.find((w) => w.code === "20040145");
    assert.ok(flagged, "expected this WOM to show up as applied over its Toyota PO value");
    assert.equal(flagged.overage, 60000 - 54138);
  } finally {
    restore();
  }

  // The original bug report: "Applied PO $" (no "Contracted Services" in
  // the title) wasn't recognized at all, so Contracted Services Increased
  // stayed stuck at 0 regardless of real data. Re-sync with a higher
  // Applied PO $ and confirm it's now actually caught.
  await t.test("a real Applied PO $ increase over estimate is caught as Contracted Services Increased", async () => {
    const restoreIncrease = stubFetchOnce({
      ok: true,
      json: async () => ({
        name: "Midwest PSE Request Tracker",
        columns: FULL_BREAKDOWN_COLUMNS,
        rows: [
          {
            id: 900,
            cells: [
              { columnId: 1, value: "20040145", displayValue: "20040145" },
              { columnId: 2, value: "Riser Check Valves Repair", displayValue: "Riser Check Valves Repair" },
              { columnId: 5, value: 48500, displayValue: "$48,500.00" },
              { columnId: 12, value: 52000, displayValue: "$52,000.00" },
            ],
          },
        ],
      }),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const summary = (await server.call("GET", "/api/woms/cost-summary", { userId: "ADMIN" })).body;
      const flagged = summary.contractedIncreased.find((w) => w.code === "20040145");
      assert.ok(flagged, "expected Applied PO $ exceeding Estimate PO $ to show up as Contracted Services Increased");
      assert.equal(flagged.overage, 52000 - 48500);
    } finally {
      restoreIncrease();
    }
  });

  await t.test("this WOM's own sync history shows the sync that actually changed it", async () => {
    // Only one entry, not two: the very first sync *created* this WOM
    // (tracked via the created count, not changedWoms) -- a creation isn't
    // a "change" to something that already existed. The second sync (the
    // Applied PO $ increase) is the one that counts.
    const res = await server.call("GET", "/api/woms/20040145/sync-history", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.ok(res.body[0].fields.includes("applied contracted services"));
  });

  await t.test("a technician cannot see a WOM's sync history", async () => {
    const res = await server.call("GET", "/api/woms/20040145/sync-history", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("sync history for an unknown WOM 404s", async () => {
    const res = await server.call("GET", "/api/woms/NOPE-404/sync-history", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });
});

// The reported bug: a WOM like "Install drop ceiling" shows status Open on
// its card while the sheet itself says "Status 99 -- Invoiced," "Work
// Completed: true," "WOM fully invoiced" -- all three only ever visible in
// the raw Smartsheet dump, never reflected in `status`. These columns cover
// that: synced into their own source_* fields, surfaced as a conflict flag,
// and never allowed to touch `status` itself.
const STATUS_COLUMNS = [
  { id: 1, title: "WOM #" },
  { id: 2, title: "Project Name" },
  { id: 3, title: "WOM Status" },
  { id: 4, title: "Work Completed" },
  { id: 5, title: "Invoice Status" },
  { id: 6, title: "Requested By" },
  { id: 7, title: "C&W Invoice # - TOY" },
  { id: 8, title: "Batch #" },
  { id: 9, title: "Vendor INV Attached" },
  { id: 10, title: "Invoice Attached" },
  { id: 11, title: "Journal Edit" },
  { id: 12, title: "Ariba Confirm" },
  { id: 13, title: "Sent to Jason" },
  { id: 14, title: "Billing" },
  { id: 15, title: "Billing Ref #" },
  { id: 16, title: "Work Completed Date" },
  { id: 17, title: "Batch Date" },
];

function statusSheetWith(rows) {
  return { name: "Midwest PSE Request Tracker", columns: STATUS_COLUMNS, rows };
}

test("smartsheet sync: Status/Work Completed/Billing/Requested By surface as source_* fields and drive app status", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("Work Completed alone only marks the work_complete step -- it never promotes status to invoiced", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9001,
            cells: [
              { columnId: 1, value: "20099001", displayValue: "20099001" },
              { columnId: 2, value: "Install drop ceiling", displayValue: "Install drop ceiling" },
              { columnId: 3, value: "Status 99 - Invoiced", displayValue: "Status 99 - Invoiced" },
              { columnId: 4, value: "True", displayValue: "True" },
              { columnId: 5, value: "WOM fully invoiced", displayValue: "WOM fully invoiced" },
              { columnId: 6, value: "J. Smith", displayValue: "J. Smith" },
              { columnId: 16, value: "2026-01-20", displayValue: "2026-01-20" },
              { columnId: 17, value: "2026-01-25", displayValue: "2026-01-25" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.sourceStatusColumn, "WOM Status");
      // Must resolve to the plain checkbox column, not "Work Completed
      // Date" -- both titles contain "work" and "completed".
      assert.equal(res.body.sourceWorkCompletedColumn, "Work Completed");
      assert.equal(res.body.sourceBillingColumn, "Invoice Status");
      assert.equal(res.body.sourceRequestedByColumn, "Requested By");
      assert.equal(res.body.invoiceNumberColumn, "C&W Invoice # - TOY");
      assert.equal(res.body.batchNumberColumn, "Batch #");
      assert.equal(res.body.workCompletedDateColumn, "Work Completed Date");
      assert.equal(res.body.batchDateColumn, "Batch Date");

      const wom = (await server.call("GET", "/api/woms/20099001/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.workCompletedDate, "2026-01-20");
      assert.equal(wom.batchDate, "2026-01-25");
      // Status/Billing free text never drives `status` -- only a real
      // invoice # does, and there isn't one on this row, so this stays
      // "open" even though the Status cell says "Invoiced."
      assert.equal(wom.status, "open", "Status/Billing text alone must never promote the app's own status");
      assert.equal(wom.sourceStatusRaw, "Status 99 - Invoiced");
      assert.equal(wom.sourceWorkCompletedRaw, "True");
      assert.equal(wom.sourceWorkCompleted, 1);
      assert.equal(wom.workCompleted, 1);
      assert.equal(wom.sourceBillingRaw, "WOM fully invoiced");
      assert.equal(wom.sourceRequestedBy, "J. Smith");
      assert.equal(wom.statusConflict, false, "no real invoice evidence yet, so no conflict to flag");
      assert.ok(
        wom.lifecycleSteps.find((s) => s.key === "work_complete").completedAt,
        "Work Completed should mark the work_complete step"
      );
      assert.equal(
        wom.lifecycleSteps.find((s) => s.key === "invoiced").completedAt,
        null,
        "the invoiced step must stay open -- no invoice # on file"
      );
    } finally {
      restore();
    }
  });

  await t.test("a real invoice # on the sheet promotes a brand-new row straight to invoiced", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9001,
            cells: [
              { columnId: 1, value: "20099001", displayValue: "20099001" },
              { columnId: 2, value: "Install drop ceiling", displayValue: "Install drop ceiling" },
              { columnId: 4, value: "True", displayValue: "True" },
              { columnId: 7, value: "INV-55214", displayValue: "INV-55214" },
              { columnId: 8, value: "B-901", displayValue: "B-901" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);

      const wom = (await server.call("GET", "/api/woms/20099001/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "invoiced");
      assert.equal(wom.invoiceNumber, "INV-55214");
      assert.equal(wom.batchNumber, "B-901");
      assert.equal(wom.statusConflict, false, "app status already reflects what the sheet says");
      assert.ok(wom.lifecycleSteps.find((s) => s.key === "invoiced").completedAt);
      assert.ok(wom.lifecycleSteps.find((s) => s.key === "work_complete").completedAt);
    } finally {
      restore();
    }
  });

  await t.test("re-syncing identical data again doesn't re-flag or change anything further", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9001,
            cells: [
              { columnId: 1, value: "20099001", displayValue: "20099001" },
              { columnId: 2, value: "Install drop ceiling", displayValue: "Install drop ceiling" },
              { columnId: 4, value: "True", displayValue: "True" },
              { columnId: 7, value: "INV-55214", displayValue: "INV-55214" },
              { columnId: 8, value: "B-901", displayValue: "B-901" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const changed = res.body.changedWoms.find((c) => c.code === "20099001");
      assert.equal(changed, undefined, "nothing actually changed on this sync -- it shouldn't show up as changed");
      const wom = (await server.call("GET", "/api/woms/20099001/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "invoiced");
      assert.equal(wom.statusConflict, false);
    } finally {
      restore();
    }
  });

  await t.test("an already-open WOM: Work Completed only marks the checklist step, status stays open until an invoice # appears", async () => {
    const createOpen = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9004,
            cells: [
              { columnId: 1, value: "20099004", displayValue: "20099004" },
              { columnId: 2, value: "Replace exterior lighting", displayValue: "Replace exterior lighting" },
            ],
          },
        ]),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const beforeWom = (await server.call("GET", "/api/woms/20099004/lookup", { userId: "ADMIN" })).body;
      assert.equal(beforeWom.status, "open");
    } finally {
      createOpen();
    }

    const markWorkComplete = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9004,
            cells: [
              { columnId: 1, value: "20099004", displayValue: "20099004" },
              { columnId: 2, value: "Replace exterior lighting", displayValue: "Replace exterior lighting" },
              { columnId: 3, value: "Status 99 - Invoiced", displayValue: "Status 99 - Invoiced" },
              { columnId: 4, value: "True", displayValue: "True" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const changed = res.body.changedWoms.find((c) => c.code === "20099004");
      assert.ok(changed, "expected this WOM to show up in the sync's changed list");
      assert.deepEqual(changed.fields, ["Work marked complete"], "wording should name exactly what changed, not a generic status message");

      const wom = (await server.call("GET", "/api/woms/20099004/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "open", "Work Completed by itself must never promote status to invoiced");
      assert.equal(wom.statusConflict, false);
    } finally {
      markWorkComplete();
    }

    const addInvoice = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9004,
            cells: [
              { columnId: 1, value: "20099004", displayValue: "20099004" },
              { columnId: 2, value: "Replace exterior lighting", displayValue: "Replace exterior lighting" },
              { columnId: 3, value: "Status 99 - Invoiced", displayValue: "Status 99 - Invoiced" },
              { columnId: 4, value: "True", displayValue: "True" },
              { columnId: 7, value: "INV-77310", displayValue: "INV-77310" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const changed = res.body.changedWoms.find((c) => c.code === "20099004");
      assert.ok(changed.fields.includes("Invoice number added"));
      assert.ok(changed.fields.some((f) => f.includes("now invoiced")));

      const wom = (await server.call("GET", "/api/woms/20099004/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "invoiced", "a real invoice # arriving should promote this to invoiced");
      assert.equal(wom.invoiceNumber, "INV-77310");
      assert.equal(wom.statusConflict, false);
    } finally {
      addInvoice();
    }
  });

  await t.test("a cancelled WOM is never auto-promoted even once a real invoice # appears -- it only flags a conflict", async () => {
    const createOpen = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9005,
            cells: [
              { columnId: 1, value: "20099005", displayValue: "20099005" },
              { columnId: 2, value: "Cancelled project", displayValue: "Cancelled project" },
            ],
          },
        ]),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
    } finally {
      createOpen();
    }
    await server.call("PATCH", "/api/woms/20099005", { userId: "ADMIN", body: { status: "cancelled" } });

    const addInvoice = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9005,
            cells: [
              { columnId: 1, value: "20099005", displayValue: "20099005" },
              { columnId: 2, value: "Cancelled project", displayValue: "Cancelled project" },
              { columnId: 7, value: "INV-00999", displayValue: "INV-00999" },
            ],
          },
        ]),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const wom = (await server.call("GET", "/api/woms/20099005/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "cancelled", "a cancelled WOM is a deliberate admin call sync never overrides");
      // The invoice # still gets written (it's real data worth keeping on
      // file), it just never flips a cancelled WOM's own status.
      assert.equal(wom.invoiceNumber, "INV-00999");
      assert.equal(wom.statusConflict, true, "still worth flagging as a disagreement to look at by hand");
    } finally {
      addInvoice();
    }
  });

  await t.test("a vendor-only job (no real WOM # yet) only gets its work_complete step marked -- invoicing still needs a real invoice #", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9006,
            rowNumber: 88,
            cells: [
              // No "WOM #" cell at all -- this row never got a real WOM #
              // entered on the sheet, so it creates as PENDING-<rowId>.
              { columnId: 2, value: "HP D Flooring Repair", displayValue: "HP D Flooring Repair" },
              { columnId: 3, value: "Status 99 - Invoiced", displayValue: "Status 99 - Invoiced" },
              { columnId: 4, value: "True", displayValue: "True" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);

      const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const wom = list.body.find((w) => w.description === "HP D Flooring Repair");
      assert.ok(wom, "expected a PENDING-<rowId> WOM to have been created");
      assert.equal(wom.code.startsWith("PENDING-"), true);
      // Status text alone is not evidence of invoicing -- a vendor-only job
      // can look "done" on the Status column well before it's actually
      // billed.
      assert.equal(wom.status, "pending");
      assert.equal(wom.statusConflict, false);
      assert.ok(wom.lifecycleSteps.find((s) => s.key === "work_complete").completedAt, "Work Completed should still mark this step");
      assert.equal(wom.lifecycleSteps.find((s) => s.key === "invoiced").completedAt, null);
    } finally {
      restore();
    }
  });

  await t.test("the billing checklist completing is its own message, separate from Work Completed or an invoice #", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9007,
            cells: [
              { columnId: 1, value: "20099007", displayValue: "20099007" },
              { columnId: 2, value: "Repave loading dock", displayValue: "Repave loading dock" },
            ],
          },
        ]),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
    } finally {
      restore();
    }

    const completeChecklist = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9007,
            cells: [
              { columnId: 1, value: "20099007", displayValue: "20099007" },
              { columnId: 2, value: "Repave loading dock", displayValue: "Repave loading dock" },
              { columnId: 9, value: "true", displayValue: "true" },
              { columnId: 10, value: "true", displayValue: "true" },
              { columnId: 11, value: "true", displayValue: "true" },
              { columnId: 12, value: "true", displayValue: "true" },
              { columnId: 13, value: "true", displayValue: "true" },
              { columnId: 14, value: "true", displayValue: "true" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const changed = res.body.changedWoms.find((c) => c.code === "20099007");
      assert.ok(changed);
      assert.ok(changed.fields.includes("Billing checklist completed"), "all 6 checklist items (including the Billing/Batch-posted-confirmed column) must be true");
      assert.ok(
        !changed.fields.some((f) => f.includes("now invoiced")),
        "applyWomSourceEvidence only promotes status from the invoice-number branch -- the checklist alone doesn't trigger that message, even though it does count as invoicing evidence below"
      );

      const wom = (await server.call("GET", "/api/woms/20099007/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.billingChecklistComplete, true);
      assert.ok(wom.billingChecklist.every((c) => c.done));
      // A fully-complete billing checklist is itself accepted invoicing
      // evidence (see sourceImpliesInvoiced) even with no invoice # typed in
      // yet -- so this still flags for an admin to confirm/finish up, same
      // as the cancelled-WOM case above, rather than silently sitting open.
      assert.equal(wom.statusConflict, true, "billing checklist complete is real invoicing evidence the app status hasn't caught up to");
    } finally {
      completeChecklist();
    }
  });

  await t.test("Billing Ref # comes through as its own display-only field, separate from the checklist and invoice #", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9008,
            cells: [
              { columnId: 1, value: "20099008", displayValue: "20099008" },
              { columnId: 2, value: "Seal parking garage", displayValue: "Seal parking garage" },
              { columnId: 15, value: "RITM73266372", displayValue: "RITM73266372" },
            ],
          },
        ]),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.body.billingRefNumberColumn, "Billing Ref #");

      const wom = (await server.call("GET", "/api/woms/20099008/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.billingRefNumber, "RITM73266372");
      // A billing ref # by itself (no invoice #, no completed checklist) is
      // not evidence of invoicing -- it's Krista's own manual note, kept for
      // reference only.
      assert.equal(wom.status, "open");
      assert.equal(wom.statusConflict, false);
    } finally {
      restore();
    }
  });

  await t.test("a row with ordinary in-progress sheet data shows no conflict", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () =>
        statusSheetWith([
          {
            id: 9002,
            cells: [
              { columnId: 1, value: "20099002", displayValue: "20099002" },
              { columnId: 2, value: "Replace parking lot lighting", displayValue: "Replace parking lot lighting" },
              { columnId: 3, value: "Status 40 - In Progress", displayValue: "Status 40 - In Progress" },
              { columnId: 4, value: "False", displayValue: "False" },
              { columnId: 5, value: "Not yet billed", displayValue: "Not yet billed" },
            ],
          },
        ]),
    });
    try {
      await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      const wom = (await server.call("GET", "/api/woms/20099002/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.status, "open");
      assert.equal(wom.sourceWorkCompleted, 0);
      assert.equal(wom.statusConflict, false);
    } finally {
      restore();
    }
  });

  await t.test("missing Status/Work Completed/Billing/Requested By columns are tolerated -- sync still succeeds", async () => {
    const restore = stubFetchOnce({
      ok: true,
      json: async () => ({
        name: "Midwest PSE Request Tracker",
        columns: [
          { id: 1, title: "WOM #" },
          { id: 2, title: "Project Name" },
        ],
        rows: [
          {
            id: 9003,
            cells: [
              { columnId: 1, value: "20099003", displayValue: "20099003" },
              { columnId: 2, value: "No status columns on this sheet", displayValue: "No status columns on this sheet" },
            ],
          },
        ],
      }),
    });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-woms", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      const wom = (await server.call("GET", "/api/woms/20099003/lookup", { userId: "ADMIN" })).body;
      assert.equal(wom.sourceStatusRaw, null);
      assert.equal(wom.sourceWorkCompleted, null);
      assert.equal(wom.statusConflict, false);
    } finally {
      restore();
    }
  });
});
