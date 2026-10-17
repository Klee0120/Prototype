const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

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

// Self-service "forgot my PIN" -- emails a one-time reset link rather than
// an admin having to hand the new PIN to someone directly. SMTP isn't
// configured in the test environment, so mailer.sendMail is a no-op
// logger (see server/utils/mailer.js) -- the route still runs its full
// token-creation path regardless, since that doesn't depend on delivery
// actually succeeding, which is what these tests exercise against the raw
// password_resets table.
test("auth: forgot-pin / reset-pin flow", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  function resetRowsFor(techId) {
    return raw.prepare("SELECT * FROM password_resets WHERE tech_id = ? ORDER BY created_at DESC").all(techId);
  }

  await t.test("requesting a reset for an unknown ID gives the same generic response, creates nothing", async () => {
    const res = await server.call("POST", "/api/auth/forgot-pin", { body: { id: "NOPE1234" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /if that id has an email on file/i);
  });

  await t.test("requesting a reset for an account with no email on file is the same generic response, creates nothing", async () => {
    const res = await server.call("POST", "/api/auth/forgot-pin", { body: { id: "ADMIN" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(resetRowsFor("ADMIN").length, 0, "ADMIN has no email on file in seed data -- nothing should be created");
  });

  await t.test("requesting a reset for a real account with an email creates a single-use token", async () => {
    const res = await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1001" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const rows = resetRowsFor("T1001");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used, 0);
  });

  await t.test("a second request burns the first token so only the newest link works", async () => {
    await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1002" } });
    const firstToken = resetRowsFor("T1002")[0].token;

    await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1002" } });
    const rows = resetRowsFor("T1002");
    assert.equal(rows.length, 2);

    const first = rows.find((r) => r.token === firstToken);
    assert.equal(first.used, 1, "the earlier outstanding token should be burned once a newer one is requested");

    const stale = await server.call("POST", "/api/auth/reset-pin", { body: { token: firstToken, pin: "ValidPin1!" } });
    assert.equal(stale.status, 400);
  });

  await t.test("resetting with a valid token actually changes the PIN, and the token can't be reused", async () => {
    await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1003" } });
    const token = resetRowsFor("T1003")[0].token;

    const reset = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "NewPin123!" } });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ok, true);

    const oldLogin = await server.call("POST", "/api/auth/login", { body: { id: "T1003", pin: "2345" } });
    assert.equal(oldLogin.status, 401);
    const newLogin = await server.call("POST", "/api/auth/login", { body: { id: "T1003", pin: "NewPin123!" } });
    assert.equal(newLogin.status, 200);

    const replay = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "AnotherPin1!" } });
    assert.equal(replay.status, 400);
  });

  await t.test("rejects a made-up reset token", async () => {
    const res = await server.call("POST", "/api/auth/reset-pin", { body: { token: "not-a-real-token", pin: "ValidPin1!" } });
    assert.equal(res.status, 400);
  });

  await t.test("rejects an expired reset token", async () => {
    await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1001" } });
    const token = resetRowsFor("T1001")[0].token;
    raw.prepare("UPDATE password_resets SET expires_at = ? WHERE token = ?").run(
      new Date(Date.now() - 60 * 1000).toISOString(),
      token
    );

    const res = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "ValidPin1!" } });
    assert.equal(res.status, 400);
  });

  // New PIN policy (server/utils/password.js's pinStrengthError): at least
  // 8 characters, and at least one special character -- a plain short
  // numeric PIN is guessable fast enough that the login lockout was doing
  // most of the real work. Applies here the same as account creation and
  // the admin-mediated reset.
  await t.test("rejects a new PIN that's too short or missing a special character, accepts one that meets both", async () => {
    await server.call("POST", "/api/auth/forgot-pin", { body: { id: "T1002" } });
    const token = resetRowsFor("T1002")[0].token;

    const tooShort = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "Ab1!" } });
    assert.equal(tooShort.status, 400);
    assert.match(tooShort.body.error, /at least 8 characters/i);

    const noSpecialChar = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "LongEnoughButPlain1" } });
    assert.equal(noSpecialChar.status, 400);
    assert.match(noSpecialChar.body.error, /special character/i);

    const compliant = await server.call("POST", "/api/auth/reset-pin", { body: { token, pin: "Compliant1!" } });
    assert.equal(compliant.status, 200);
  });

  await t.test("missing id/token on either route is a 400", async () => {
    const forgot = await server.call("POST", "/api/auth/forgot-pin", { body: {} });
    assert.equal(forgot.status, 400);
    const reset = await server.call("POST", "/api/auth/reset-pin", { body: { pin: "ValidPin1!" } });
    assert.equal(reset.status, 400);
  });
});
