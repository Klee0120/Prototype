const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("auth: login flow", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("rejects missing credentials", async () => {
    const res = await server.call("POST", "/api/auth/login", { body: {} });
    assert.equal(res.status, 400);
  });

  await t.test("rejects wrong pin", async () => {
    const res = await server.call("POST", "/api/auth/login", { body: { id: "T1001", pin: "0000" } });
    assert.equal(res.status, 401);
  });

  await t.test("accepts a valid technician login", async () => {
    const res = await server.call("POST", "/api/auth/login", { body: { id: "T1001", pin: "1234" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "tech");
    assert.equal(res.body.name, "Alex Rivera");
  });

  await t.test("accepts a valid admin login", async () => {
    const res = await server.call("POST", "/api/auth/login", { body: { id: "ADMIN", pin: "9999" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "admin");
  });

  await t.test("is case-insensitive on ID", async () => {
    const res = await server.call("POST", "/api/auth/login", { body: { id: "t1001", pin: "1234" } });
    assert.equal(res.status, 200);
  });

  await t.test("rejects requests to protected routes with no session", async () => {
    const res = await server.call("GET", "/api/woms");
    assert.equal(res.status, 401);
  });
});
