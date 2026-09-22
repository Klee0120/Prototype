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

// Only fakes calls to the Smartsheet API itself -- everything else (the
// test harness's own HTTP calls to the local test server, e.g. logging in)
// goes through the real fetch untouched.
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

// Mirrors the real "Midwest PSE Request Tracker" sheet's shape: a WOM # column
// plus separate Estimate/Applied WOM $ columns with their own exact (and
// not-quite-guessable) punctuation.
const SAMPLE_SHEET = {
  name: "Midwest PSE Request Tracker",
  columns: [
    { id: 1, title: "WOM #" },
    { id: 2, title: "Estimate WOM $ - Project Total" },
    { id: 3, title: "Applied WOM $ - Project Summary" },
  ],
  rows: [
    // Matches a real seeded WOM -- should update.
    {
      id: 100,
      cells: [
        { columnId: 1, value: "WOM-4471", displayValue: "WOM-4471" },
        { columnId: 2, value: 1710.71, displayValue: "$1,710.71" },
        { columnId: 3, value: 1983.71, displayValue: "$1,983.71" },
      ],
    },
    // No WOM # cell at all yet -- still just a request, should skip.
    {
      id: 101,
      cells: [{ columnId: 2, value: 500, displayValue: "$500.00" }],
    },
    // WOM # of "0" -- not a real assignment, should skip.
    {
      id: 102,
      cells: [
        { columnId: 1, value: "0", displayValue: "0" },
        { columnId: 2, value: 100, displayValue: "$100.00" },
      ],
    },
    // A WOM # this app has no matching record for -- should skip.
    {
      id: 103,
      cells: [
        { columnId: 1, value: "99999999", displayValue: "99999999" },
        { columnId: 2, value: 1, displayValue: "$1.00" },
      ],
    },
  ],
};

test("smartsheet sync: pulls WOM pricing by exact WOM # match", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician cannot trigger a sync (admin-only)", async () => {
    const res = await server.call("POST", "/api/admin/smartsheet/sync-wom-pricing", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("a failed Smartsheet API call surfaces as a clear error, not a crash", async () => {
    const restore = stubFetchOnce({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "Invalid token" });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-wom-pricing", { userId: "ADMIN" });
      assert.equal(res.status, 502);
      assert.ok(res.body.error.includes("401"));
    } finally {
      restore();
    }
  });

  await t.test("syncs the matching WOM, skips the rest, and reports why", async () => {
    const restore = stubFetchOnce({ ok: true, json: async () => SAMPLE_SHEET });
    try {
      const res = await server.call("POST", "/api/admin/smartsheet/sync-wom-pricing", { userId: "ADMIN" });
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 4);
      assert.equal(res.body.matched, 1);
      // Rows 101 (no WOM # cell) and 102 (WOM # of "0") -- neither is a
      // real assignment yet.
      assert.equal(res.body.skippedNoWomNumber, 2);
      // Row 103 -- a WOM # with no matching record here.
      assert.equal(res.body.skippedNoMatch, 1);
      assert.equal(res.body.womColumn, "WOM #");
      assert.equal(res.body.estimateColumn, "Estimate WOM $ - Project Total");
      assert.equal(res.body.appliedColumn, "Applied WOM $ - Project Summary");

      const woms = await server.call("GET", "/api/woms", { userId: "ADMIN" });
      const updated = woms.body.find((w) => w.code === "WOM-4471");
      assert.equal(updated.estimatedPrice, 1710.71);
      assert.equal(updated.appliedPrice, 1983.71);
      assert.ok(updated.smartsheetSyncedAt);

      // Untouched by this sync -- no matching row pointed at it.
      const other = woms.body.find((w) => w.code === "WOM-4502");
      assert.equal(other.estimatedPrice, null);
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
