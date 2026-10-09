const test = require("node:test");
const assert = require("node:assert/strict");
const smartsheet = require("../server/utils/smartsheet");
const { startServer } = require("./helpers");

test("smartsheet: simplifySheet reshapes Smartsheet's column-id-keyed cells", () => {
  const raw = {
    name: "WOM Tracker",
    columns: [
      { id: 1, title: "WOM #" },
      { id: 2, title: "Description" },
      { id: 3, title: "Estimated Price" },
    ],
    rows: [
      {
        id: 100,
        cells: [
          { columnId: 1, value: "WOM-4471", displayValue: "WOM-4471" },
          { columnId: 2, value: "HVAC Replacement", displayValue: "HVAC Replacement" },
          { columnId: 3, value: 12500, displayValue: "$12,500" },
        ],
      },
      {
        id: 101,
        cells: [
          { columnId: 1, value: "WOM-4502", displayValue: "WOM-4502" },
          // Description cell missing entirely on this row -- shouldn't
          // throw, just leaves that key out of the row's object.
          { columnId: 3, value: 8000, displayValue: "$8,000" },
        ],
      },
    ],
  };

  const simplified = smartsheet.simplifySheet(raw);
  assert.equal(simplified.sheetName, "WOM Tracker");
  assert.deepEqual(simplified.columns, ["WOM #", "Description", "Estimated Price"]);
  assert.equal(simplified.rows.length, 2);
  assert.equal(simplified.rows[0]["WOM #"], "WOM-4471");
  assert.equal(simplified.rows[0]["Estimated Price"], "$12,500");
  assert.equal(simplified.rows[1]["WOM #"], "WOM-4502");
  assert.equal(simplified.rows[1].Description, undefined);
});

test("smartsheet: findColumn is tolerant of exact punctuation/wrapping", () => {
  const columns = ["WOM #", "Estimate WOM $ - Project Total", "Applied WOM $ - Project Summary", "Technician"];
  assert.equal(smartsheet.findColumn(columns, ["estimate", "wom", "$"]), "Estimate WOM $ - Project Total");
  assert.equal(smartsheet.findColumn(columns, ["applied", "wom", "$"]), "Applied WOM $ - Project Summary");
  assert.equal(smartsheet.findColumn(columns, ["nonexistent"]), null);
});

test("smartsheet: admin routes when not yet connected (the default, un-configured state)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // The test environment never sets SMARTSHEET_API_TOKEN/SMARTSHEET_SHEET_ID,
  // so this exercises the same "not connected yet" path every real
  // deployment starts in before an admin sets those two env vars.
  assert.equal(smartsheet.isConfigured(), false);

  await t.test("status reports not connected", async () => {
    const res = await server.call("GET", "/api/admin/smartsheet/status", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, false);
  });

  await t.test("preview 409s with a clear reason instead of a crash", async () => {
    const res = await server.call("GET", "/api/admin/smartsheet/preview", { userId: "ADMIN" });
    assert.equal(res.status, 409);
    assert.ok(res.body.error.toLowerCase().includes("smartsheet"));
  });

  await t.test("a technician cannot view either (admin-only)", async () => {
    const status = await server.call("GET", "/api/admin/smartsheet/status", { userId: "T1001" });
    assert.equal(status.status, 403);
    const preview = await server.call("GET", "/api/admin/smartsheet/preview", { userId: "T1001" });
    assert.equal(preview.status, 403);
  });
});
