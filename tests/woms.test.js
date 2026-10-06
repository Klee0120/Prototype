const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("woms: open/closed status management", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("any logged-in user can list WOMs", async () => {
    const res = await server.call("GET", "/api/woms", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((w) => w.code === "WOM-4390" && w.status === "closed"));
  });

  await t.test("WOM Lookup: any logged-in user can see all-time hours by technician", async () => {
    const res = await server.call("GET", "/api/woms/WOM-4471/lookup", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, "WOM-4471");
    assert.equal(res.body.totalHours, 16);
    assert.deepEqual(res.body.hoursByTechnician, [{ techId: "T1001", techName: "Alex Rivera", hours: 16 }]);
  });

  await t.test("WOM Lookup 404s for an unknown WOM", async () => {
    const res = await server.call("GET", "/api/woms/NOPE/lookup", { userId: "T1001" });
    assert.equal(res.status, 404);
  });

  await t.test("a technician cannot change WOM status", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "T1001", body: { status: "closed" } });
    assert.equal(res.status, 403);
  });

  await t.test("a technician cannot create a WOM", async () => {
    const res = await server.call("POST", "/api/woms", { userId: "T1001", body: { code: "X", description: "x" } });
    assert.equal(res.status, 403);
  });

  await t.test("admin can close and reopen a WOM", async () => {
    const close = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "closed" } });
    assert.equal(close.status, 200);
    assert.equal(close.body.status, "closed");

    const reopen = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "open" } });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.body.status, "open");
  });

  await t.test("closing a WOM flags it as needing a manual Smartsheet update", async () => {
    const close = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "closed" } });
    assert.equal(close.status, 200);
    assert.equal(close.body.smartsheetReflectedAt, null);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const wom = list.body.find((w) => w.code === "WOM-4471");
    assert.equal(wom.smartsheetReflectedAt, null);
  });

  await t.test("a technician cannot mark a WOM reflected in Smartsheet", async () => {
    const res = await server.call("POST", "/api/woms/WOM-4471/smartsheet-reflected", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("marking a closed WOM reflected in Smartsheet sets a timestamp", async () => {
    const res = await server.call("POST", "/api/woms/WOM-4471/smartsheet-reflected", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.smartsheetReflectedAt);
  });

  await t.test("marking an already-reflected (non-closed) WOM reflected again is rejected", async () => {
    const reopen = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "open" } });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.body.smartsheetReflectedAt, null);

    const res = await server.call("POST", "/api/woms/WOM-4471/smartsheet-reflected", { userId: "ADMIN" });
    assert.equal(res.status, 409);
  });

  await t.test("reopening and re-closing a WOM needs its own fresh Smartsheet update", async () => {
    const close = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "closed" } });
    assert.equal(close.status, 200);
    assert.equal(close.body.smartsheetReflectedAt, null);

    const reflect = await server.call("POST", "/api/woms/WOM-4471/smartsheet-reflected", { userId: "ADMIN" });
    assert.equal(reflect.status, 200);
    assert.ok(reflect.body.smartsheetReflectedAt);

    // Restore for the rest of the suite.
    await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "open" } });
  });

  await t.test("marking an unknown WOM reflected 404s", async () => {
    const res = await server.call("POST", "/api/woms/WOM-NOPE/smartsheet-reflected", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("admin can set a WOM to invoiced independent of whether a technician marked it complete", async () => {
    const invoiced = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "invoiced" } });
    assert.equal(invoiced.status, 200);
    assert.equal(invoiced.body.status, "invoiced");

    const closed = await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "closed" } });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");

    // Restore for the rest of the suite.
    await server.call("PATCH", "/api/woms/WOM-4471", { userId: "ADMIN", body: { status: "open" } });
  });

  await t.test("a technician cannot allocate to an invoiced WOM", async () => {
    const invoiced = await server.call("PATCH", "/api/woms/WOM-4502", { userId: "ADMIN", body: { status: "invoiced" } });
    assert.equal(invoiced.status, 200);

    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4502", hours: 4 }] },
    });
    assert.equal(res.status, 400);

    await server.call("PATCH", "/api/woms/WOM-4502", { userId: "ADMIN", body: { status: "open" } });
  });

  await t.test("admin can create a new WOM, which starts open", async () => {
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-9999", description: "New Job" },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const created = list.body.find((w) => w.code === "WOM-9999");
    assert.ok(created);
    assert.equal(created.status, "open");
  });

  await t.test("cannot create a duplicate WOM code", async () => {
    const res = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-9999", description: "Duplicate" },
    });
    assert.equal(res.status, 409);
  });

  await t.test("rejects an invalid status value", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-9999", { userId: "ADMIN", body: { status: "bogus" } });
    assert.equal(res.status, 400);
  });

  await t.test("admin can set a subsidiary code and Maximo # when creating a WOM", async () => {
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-8001", description: "Roof repair", subsidiaryCode: "16101025721", maximoNumber: "19781019" },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const created = list.body.find((w) => w.code === "WOM-8001");
    assert.equal(created.subsidiaryCode, "16101025721");
    assert.equal(created.maximoNumber, "19781019");
  });

  await t.test("admin can edit a WOM's description/location/budget/subsidiary code/Maximo #", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-8001/details", {
      userId: "ADMIN",
      body: { description: "Roof repair - updated", budgetHours: 40, subsidiaryCode: "16101025788", maximoNumber: "19781020" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, "Roof repair - updated");
    assert.equal(res.body.budgetHours, 40);
    assert.equal(res.body.subsidiaryCode, "16101025788");
    assert.equal(res.body.maximoNumber, "19781020");
  });

  await t.test("a technician cannot edit WOM details", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-8001/details", {
      userId: "T1001",
      body: { description: "hijacked" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("editing WOM details 404s for an unknown code", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-NOPE/details", {
      userId: "ADMIN",
      body: { description: "x" },
    });
    assert.equal(res.status, 404);
  });

  await t.test("admin can cancel a WOM -- a dropped job that was never billed, distinct from closed/invoiced", async () => {
    const cancel = await server.call("PATCH", "/api/woms/WOM-4502", { userId: "ADMIN", body: { status: "cancelled" } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.status, "cancelled");

    // A technician can't allocate against a cancelled WOM either -- same
    // "must be open" rule as any other non-open status.
    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const alloc = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4502", hours: 8 }] },
    });
    assert.equal(alloc.status, 400);
  });

  await t.test("admin can delete a WOM that was created by mistake (no hours allocated)", async () => {
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-DELETE-ME", description: "Test entry", locationCode: "PRINCETON" },
    });
    assert.equal(create.status, 201);

    const forbidden = await server.call("DELETE", "/api/woms/WOM-DELETE-ME", { userId: "T1001" });
    assert.equal(forbidden.status, 403);

    const del = await server.call("DELETE", "/api/woms/WOM-DELETE-ME", { userId: "ADMIN" });
    assert.equal(del.status, 200);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    assert.ok(!list.body.some((w) => w.code === "WOM-DELETE-ME"));
  });

  await t.test("deleting an unknown WOM 404s", async () => {
    const res = await server.call("DELETE", "/api/woms/WOM-NOPE", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("deleting a WOM with hours already allocated is blocked unless forced", async () => {
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-DELETE-USED", description: "Test entry with hours", locationCode: "PRINCETON" },
    });
    assert.equal(create.status, 201);

    const meta = await server.call("GET", "/api/meta/current-week");
    const week = meta.body.weekMonday;
    const alloc = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-DELETE-USED", hours: 4 }] },
    });
    assert.equal(alloc.status, 200);

    const blocked = await server.call("DELETE", "/api/woms/WOM-DELETE-USED", { userId: "ADMIN" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.allocatedHours, 4);

    const forced = await server.call("DELETE", "/api/woms/WOM-DELETE-USED", { userId: "ADMIN", body: { force: true } });
    assert.equal(forced.status, 200);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    assert.ok(!list.body.some((w) => w.code === "WOM-DELETE-USED"));
  });
});

test("locations: E&F job number and region tracking", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("any logged-in user can list locations, including the standard E&F subsidiary code", async () => {
    const res = await server.call("GET", "/api/locations", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.equal(res.body[0].efSubsidiaryCode, "20920000");
  });

  await t.test("every existing location backfills to Midwest territory", async () => {
    const res = await server.call("GET", "/api/locations", { userId: "T1001" });
    assert.ok(res.body.every((l) => l.territory === "Midwest"));
  });

  await t.test("any logged-in user can list the available territories", async () => {
    const res = await server.call("GET", "/api/locations/territories", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ["Midwest", "HQ Plano", "East", "West", "North", "TdPR REGION", "General Mgt & Admin"]);
  });

  await t.test("a technician cannot create a location", async () => {
    const res = await server.call("POST", "/api/locations", {
      userId: "T1001",
      body: { code: "LOC-X", name: "X" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can create a location with an E&F job number, WOM job number, and region", async () => {
    const create = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: {
        code: "LOC-GTOWN",
        name: "TLS Georgetown",
        efJobNumber: "100110042963",
        womJobNumber: "100110007530",
        region: "Southeast",
        territory: "Midwest",
      },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const created = list.body.find((l) => l.code === "LOC-GTOWN");
    assert.equal(created.efJobNumber, "100110042963");
    assert.equal(created.womJobNumber, "100110007530");
    assert.equal(created.region, "Southeast");
    assert.equal(created.territory, "Midwest");
  });

  await t.test("admin can create a location tagged with a different territory", async () => {
    const create = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-EAST", name: "East Site", territory: "East" },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.equal(list.body.find((l) => l.code === "LOC-EAST").territory, "East");
  });

  // Silently defaulting a location with no territory given to "Midwest" is
  // exactly what mistagged a corporate/overhead code as a real Midwest site
  // in the past -- creating one now requires saying which territory it
  // actually belongs to, same "don't guess" rule as everywhere else
  // territory gets set.
  await t.test("creating a location with no territory is rejected", async () => {
    const res = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-NOTERR", name: "No Territory Given" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /territory/i);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.ok(!list.body.some((l) => l.code === "LOC-NOTERR"), "nothing should have been created");
  });

  await t.test("creating a location with an unknown territory is rejected", async () => {
    const res = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-BAD", name: "Bad", territory: "Narnia" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("cannot create a duplicate location code", async () => {
    const res = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-GTOWN", name: "Duplicate" },
    });
    assert.equal(res.status, 409);
  });

  await t.test("admin can edit a location's name/job number/region/territory", async () => {
    const res = await server.call("PATCH", "/api/locations/LOC-GTOWN", {
      userId: "ADMIN",
      body: {
        name: "TLS Georgetown Updated",
        efJobNumber: "100110043044",
        womJobNumber: "100110041403",
        region: "Region 1",
        territory: "HQ Plano",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "TLS Georgetown Updated");
    assert.equal(res.body.efJobNumber, "100110043044");
    assert.equal(res.body.womJobNumber, "100110041403");
    assert.equal(res.body.region, "Region 1");
    assert.equal(res.body.territory, "HQ Plano");
  });

  await t.test("editing a location with an unknown territory is rejected", async () => {
    const res = await server.call("PATCH", "/api/locations/LOC-GTOWN", {
      userId: "ADMIN",
      body: { name: "TLS Georgetown Updated", territory: "Narnia" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a technician cannot edit a location", async () => {
    const res = await server.call("PATCH", "/api/locations/LOC-GTOWN", {
      userId: "T1001",
      body: { name: "hijacked" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("editing an unknown location 404s", async () => {
    const res = await server.call("PATCH", "/api/locations/LOC-NOPE", {
      userId: "ADMIN",
      body: { name: "x" },
    });
    assert.equal(res.status, 404);
  });

  await t.test("a technician cannot delete a location", async () => {
    const res = await server.call("DELETE", "/api/locations/LOC-GTOWN", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("deleting an unknown location 404s", async () => {
    const res = await server.call("DELETE", "/api/locations/LOC-NOPE", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("a location referenced by a WOM, a technician, or an allocation can't be deleted", async () => {
    // PRINCETON is referenced by WOM-4471/T1001's home location/seeded
    // allocations, so it should be blocked on every count at once.
    const res = await server.call("DELETE", "/api/locations/PRINCETON", { userId: "ADMIN" });
    assert.equal(res.status, 409);
    assert.ok(res.body.technicianCount > 0);
    assert.ok(res.body.womCount > 0);
    assert.match(res.body.error, /reassign those first/);
  });

  await t.test("admin can delete a location with nothing pointing at it", async () => {
    const del = await server.call("DELETE", "/api/locations/LOC-GTOWN", { userId: "ADMIN" });
    assert.equal(del.status, 200);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.ok(!list.body.some((l) => l.code === "LOC-GTOWN"));
  });
});

// The real Chart of Accounts "Job Numbers" sheet carries its own E&F
// Contract Job Number (already used to match POs) alongside an E1 WOM Job
// Number this app had no way to backfill -- WOM-type timekeeping posts to
// location.subsidiary.WOM#, and the location piece is this number, not the
// E&F one. Column headers on the real file carry extra internal whitespace
// ("E1 WOM          Job Number"), and most rows are category headers with
// no job numbers at all -- both covered here.
test("locations: Chart of Accounts import backfills job numbers by name match", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const XLSX = require("xlsx");

  function coaWorkbook(rows) {
    const headers = [
      "Toyota Reference Code",
      "PPS Contract           Job Number",
      "E&F Contract Job Number",
      "E1 WOM                         Job Number",
      "Description",
      "E&F",
      "City",
      "State",
    ];
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Job Numbers");
    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  await t.test("dry run previews the match without writing anything", async () => {
    const buffer = coaWorkbook([
      // Category header row -- no job numbers at all, should be skipped entirely.
      [null, null, null, null, "GENERAL MGT & ADMIN", null, null, null],
      ["03004", 100110000726, 100110042963, 100110007530, "TLS Princeton", "Region 1", "Princeton", "NJ"],
      [null, null, null, 100110099999, "Totally Unknown Site", "Region 9", "Nowhere", "ZZ"],
    ]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { dryRun: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sheetName, "Job Numbers");
    assert.equal(res.body.matchedCount, 1);
    assert.equal(res.body.changedCount, 1);
    assert.equal(res.body.unmatchedCount, 1);
    const match = res.body.results.find((r) => r.locationCode === "PRINCETON");
    assert.ok(match);
    assert.equal(match.efJobNumber.after, "100110042963");
    assert.equal(match.womJobNumber.after, "100110007530");
    assert.equal(match.ppsJobNumber.after, "100110000726");
    assert.equal(match.region.after, "Region 1");
    const unmatched = res.body.results.find((r) => !r.matched);
    assert.equal(unmatched.description, "Totally Unknown Site");
    assert.equal(unmatched.willCreate, false, "createUnmatched defaults off");

    const stillBlank = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const princeton = stillBlank.body.find((l) => l.code === "PRINCETON");
    assert.equal(princeton.womJobNumber, null, "dry run must not write anything");
  });

  await t.test("committing writes the matched location's job numbers and region", async () => {
    const buffer = coaWorkbook([["03004", 100110000726, 100110042963, 100110007530, "TLS Princeton", "Region 1", "Princeton", "NJ"]]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: {},
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const after = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const princeton = after.body.find((l) => l.code === "PRINCETON");
    assert.equal(princeton.efJobNumber, "100110042963");
    assert.equal(princeton.womJobNumber, "100110007530");
    assert.equal(princeton.ppsJobNumber, "100110000726");
    assert.equal(princeton.region, "Region 1");
  });

  await t.test("re-running with the same numbers reports nothing changed", async () => {
    const buffer = coaWorkbook([["03004", 100110000726, 100110042963, 100110007530, "TLS Princeton", "Region 1", "Princeton", "NJ"]]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { dryRun: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.body.matchedCount, 1);
    assert.equal(res.body.changedCount, 0, "already matches -- nothing to update");
  });

  await t.test("an unmatched row is only listed unless createUnmatched is set", async () => {
    const buffer = coaWorkbook([[null, null, 100110055501, 100110055502, "Brand New Site", "Region 4A", "Nowhere", "ZZ"]]);

    const previewOff = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { dryRun: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(previewOff.body.unmatchedCount, 1);
    assert.equal(previewOff.body.createdCount, 0, "createUnmatched is off -- nothing would be created");
    assert.equal(previewOff.body.results[0].willCreate, false);

    const previewOn = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { dryRun: "true", createUnmatched: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(previewOn.body.createdCount, 1, "preview reports what would be created");
    assert.equal(previewOn.body.results[0].willCreate, true);
    const suggestedCode = previewOn.body.results[0].locationCode;
    assert.ok(suggestedCode);

    const stillMissing = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.ok(!stillMissing.body.some((l) => l.code === suggestedCode), "dry run (even with createUnmatched) must not write anything");

    const commit = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { createUnmatched: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(commit.body.createdCount, 1);

    const after = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const created = after.body.find((l) => l.code === suggestedCode);
    assert.ok(created, "the unmatched row was created as a new location");
    assert.equal(created.name, "Brand New Site");
    assert.equal(created.efJobNumber, "100110055501");
    assert.equal(created.womJobNumber, "100110055502");
    assert.equal(created.region, "Region 4A");
  });

  await t.test("re-running the same unmatched row after it was created now matches, not duplicates", async () => {
    const buffer = coaWorkbook([[null, null, 100110055501, 100110055502, "Brand New Site", "Region 4A", "Nowhere", "ZZ"]]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { dryRun: "true", createUnmatched: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.body.matchedCount, 1);
    assert.equal(res.body.unmatchedCount, 0);
    assert.equal(res.body.changedCount, 0);
  });

  await t.test("a technician cannot run the import", async () => {
    const buffer = coaWorkbook([["03004", 100110000726, 100110042963, 100110007530, "TLS Princeton", "Region 1", "Princeton", "NJ"]]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "T1001",
      fields: {},
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 403);
  });

  await t.test("a sheet with no Description column is rejected", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["Job #"], [100110000726]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Job Numbers");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: {},
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Description/);
  });

  await t.test("a location's territory is read from its section header, not defaulted to Midwest", async () => {
    const buffer = coaWorkbook([
      [null, null, null, null, "EAST REGION (Contract)", null, null, null],
      ["09001", 100110099001, 100110099002, 100110099003, "Brand New East Site", "Region 1", "Nowhere", "FL"],
      [null, null, null, null, "WEST REGION (Contract)", null, null, null],
      ["09002", 100110099011, 100110099012, 100110099013, "Brand New West Site", "Region 2", "Nowhere", "CA"],
    ]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { createUnmatched: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.createdCount, 2);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const east = list.body.find((l) => l.name === "Brand New East Site");
    const west = list.body.find((l) => l.name === "Brand New West Site");
    assert.ok(east);
    assert.ok(west);
    assert.equal(east.territory, "East");
    assert.equal(west.territory, "West");
  });

  await t.test("re-importing with a recognized section header corrects an already-wrong territory", async () => {
    // Simulates the earlier bug: this location exists with territory
    // hardcoded to Midwest from before section-header parsing existed.
    const create = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-MISTAGGED", name: "Mistagged East Site", territory: "Midwest" },
    });
    assert.equal(create.status, 201);

    const buffer = coaWorkbook([
      [null, null, null, null, "EAST REGION (Contract)", null, null, null],
      ["09003", 100110099021, 100110099022, 100110099023, "Mistagged East Site", "Region 1", "Nowhere", "FL"],
    ]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: {},
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const match = res.body.results.find((r) => r.locationCode === "LOC-MISTAGGED");
    assert.ok(match);
    assert.equal(match.territory.before, "Midwest");
    assert.equal(match.territory.after, "East");

    const after = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.equal(after.body.find((l) => l.code === "LOC-MISTAGGED").territory, "East");
  });

  await t.test("a row under an unrecognized section (not a known territory) leaves an existing location's territory alone", async () => {
    const create = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-OVERHEAD", name: "Overhead Line Item", territory: "East" },
    });
    assert.equal(create.status, 201);

    const buffer = coaWorkbook([
      [null, null, null, null, "TEMA REGION", null, null, null],
      ["09004", 100110099031, 100110099032, 100110099033, "Overhead Line Item", "Region 9", "Nowhere", "ZZ"],
    ]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: {},
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    assert.equal(after.body.find((l) => l.code === "LOC-OVERHEAD").territory, "East", "unrecognized section must not overwrite an existing territory");
  });

  // "GENERAL MGT & ADMIN" is Toyota's own section for corporate/overhead job
  // numbers that aren't a real field site -- its own recognized territory,
  // not left to inherit whatever geographic section happened to precede it
  // in the file (the bug that originally mistagged one as Midwest).
  await t.test("a row under the GENERAL MGT & ADMIN section gets that territory, not whatever section preceded it", async () => {
    const buffer = coaWorkbook([
      [null, null, null, null, "MIDWEST REGION (Contract)", null, null, null],
      ["09005", 100110099041, 100110099042, 100110099043, "Some Midwest Site", "Region 1", "Nowhere", "OH"],
      [null, null, null, null, "GENERAL MGT & ADMIN", null, null, null],
      ["09006", 100110000653, null, null, "General Mgt", "Region 9", "Nowhere", "ZZ"],
    ]);
    const res = await server.upload("/api/locations/import-coa", {
      userId: "ADMIN",
      fields: { createUnmatched: "true" },
      fileName: "coa.xlsx",
      fileContent: buffer,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.createdCount, 2);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const midwestSite = list.body.find((l) => l.name === "Some Midwest Site");
    const generalMgt = list.body.find((l) => l.name === "General Mgt");
    assert.equal(midwestSite.territory, "Midwest");
    assert.equal(generalMgt.territory, "General Mgt & Admin", "must not inherit Midwest from the section above it");
  });
});

// WOM Profile Consolidation (Phase 4): the Labor & Financials tab's
// GL-links route, and the Tasks tab's dedicated route. The latter exists
// specifically because the general GET /api/tasks defaults to "my work"
// scoping, which would silently hide an unassigned task -- see
// server/routes/woms.js's own comment on :code/tasks.
test("WOM profile: gl-links and tasks routes", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await server.call("POST", "/api/woms", { userId: "ADMIN", body: { code: "WOM-PROFILE-1", description: "Profile test job" } });

  await t.test("gl-links 404s for an unknown WOM", async () => {
    const res = await server.call("GET", "/api/woms/NOPE-NOT-REAL/gl-links", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("gl-links is empty for a WOM with no POs", async () => {
    const res = await server.call("GET", "/api/woms/WOM-PROFILE-1/gl-links", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("tasks route 404s for an unknown WOM", async () => {
    const res = await server.call("GET", "/api/woms/NOPE-NOT-REAL/tasks", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("an unassigned task created for this WOM shows up on its dedicated tasks route", async () => {
    const created = await server.call("POST", "/api/tasks", {
      userId: "ADMIN",
      body: { title: "Follow up on vendor invoice", relatedWomCode: "WOM-PROFILE-1" },
    });
    assert.equal(created.status, 201);

    // The general route's default "my work" view would hide this task --
    // it's unassigned and ADMIN didn't create-and-claim it onto themself.
    const generalRes = await server.call("GET", "/api/tasks", { userId: "ADMIN" });
    assert.ok(!generalRes.body.some((t2) => t2.id === created.body.id), "sanity check: confirms the scoping gap this route exists to avoid");

    const womTasksRes = await server.call("GET", "/api/woms/WOM-PROFILE-1/tasks", { userId: "ADMIN" });
    assert.equal(womTasksRes.status, 200);
    assert.equal(womTasksRes.body.length, 1);
    assert.equal(womTasksRes.body[0].title, "Follow up on vendor invoice");
    assert.equal(womTasksRes.body[0].assignedToName, "Unassigned");
  });

  await t.test("a technician cannot read a WOM's tasks route", async () => {
    const res = await server.call("GET", "/api/woms/WOM-PROFILE-1/tasks", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  // The Activity tab's Status History section resolves changedBy into a
  // real name server-side, same convention as every other activity feed in
  // the app, rather than handing the frontend a bare technician id.
  await t.test("status history resolves changedBy into the admin's name", async () => {
    const changeRes = await server.call("PATCH", "/api/woms/WOM-PROFILE-1", { userId: "ADMIN", body: { status: "invoiced" } });
    assert.equal(changeRes.status, 200);

    const historyRes = await server.call("GET", "/api/woms/WOM-PROFILE-1/history", { userId: "ADMIN" });
    assert.equal(historyRes.status, 200);
    const entry = historyRes.body.find((h) => h.newValue === "invoiced");
    assert.ok(entry, "expected a status-change entry for the new status");
    assert.equal(entry.previousValue, "open");
    assert.equal(entry.changedByName, "Krista Lee");
    assert.equal(entry.source, "manual");
  });
});
