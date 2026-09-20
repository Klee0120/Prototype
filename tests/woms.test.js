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
});
