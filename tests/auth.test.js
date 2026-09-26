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

  await t.test("a successful login returns a session token that authorizes requests", async () => {
    const login = await server.call("POST", "/api/auth/login", { body: { id: "T1002", pin: "1234" } });
    assert.equal(login.status, 200);
    assert.ok(login.body.token && login.body.token.length > 20);

    const res = await server.call("GET", "/api/woms", { token: login.body.token });
    assert.equal(res.status, 200);
  });

  await t.test("rejects a made-up session token", async () => {
    const res = await server.call("GET", "/api/woms", { token: "not-a-real-token" });
    assert.equal(res.status, 401);
  });

  await t.test("a request can no longer impersonate a user by ID alone", async () => {
    // The old (insecure) header-based scheme is gone: providing an ID with
    // no valid session token must not authorize anything.
    const headers = { "x-user-id": "ADMIN" };
    const res = await fetch(`${server.baseUrl}/api/admin/technicians`, { headers });
    assert.equal(res.status, 401);
  });

  await t.test("logout invalidates the session token", async () => {
    const login = await server.call("POST", "/api/auth/login", { body: { id: "T1003", pin: "2345" } });
    const token = login.body.token;

    const before = await server.call("GET", "/api/woms", { token });
    assert.equal(before.status, 200);

    const logout = await server.call("POST", "/api/auth/logout", { token });
    assert.equal(logout.status, 200);

    const after = await server.call("GET", "/api/woms", { token });
    assert.equal(after.status, 401);
  });

  await t.test("locks out login after repeated failed attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await server.call("POST", "/api/auth/login", { body: { id: "T1002", pin: "wrong" } });
    }
    const stillLocked = await server.call("POST", "/api/auth/login", { body: { id: "T1002", pin: "1234" } });
    assert.equal(stillLocked.status, 429);
  });
});
