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

  await t.test("admin can set a subsidiary code when creating a WOM", async () => {
    const create = await server.call("POST", "/api/woms", {
      userId: "ADMIN",
      body: { code: "WOM-8001", description: "Roof repair", subsidiaryCode: "16101025721" },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const created = list.body.find((w) => w.code === "WOM-8001");
    assert.equal(created.subsidiaryCode, "16101025721");
  });

  await t.test("admin can edit a WOM's description/location/budget/subsidiary code", async () => {
    const res = await server.call("PATCH", "/api/woms/WOM-8001/details", {
      userId: "ADMIN",
      body: { description: "Roof repair - updated", budgetHours: 40, subsidiaryCode: "16101025788" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, "Roof repair - updated");
    assert.equal(res.body.budgetHours, 40);
    assert.equal(res.body.subsidiaryCode, "16101025788");
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
      },
    });
    assert.equal(create.status, 201);

    const list = await server.call("GET", "/api/locations", { userId: "ADMIN" });
    const created = list.body.find((l) => l.code === "LOC-GTOWN");
    assert.equal(created.efJobNumber, "100110042963");
    assert.equal(created.womJobNumber, "100110007530");
    assert.equal(created.region, "Southeast");
  });

  await t.test("cannot create a duplicate location code", async () => {
    const res = await server.call("POST", "/api/locations", {
      userId: "ADMIN",
      body: { code: "LOC-GTOWN", name: "Duplicate" },
    });
    assert.equal(res.status, 409);
  });

  await t.test("admin can edit a location's name/job number/region", async () => {
    const res = await server.call("PATCH", "/api/locations/LOC-GTOWN", {
      userId: "ADMIN",
      body: { name: "TLS Georgetown Updated", efJobNumber: "100110043044", womJobNumber: "100110041403", region: "Region 1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, "TLS Georgetown Updated");
    assert.equal(res.body.efJobNumber, "100110043044");
    assert.equal(res.body.womJobNumber, "100110041403");
    assert.equal(res.body.region, "Region 1");
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
});
