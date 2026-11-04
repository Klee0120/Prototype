const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// The browser-toolbar extension (public/extension/) is a separate origin
// (chrome-extension://...) calling these same /api/ routes directly --
// without these headers, the browser blocks the extension's popup from
// reading the response at all, even though the request itself succeeds
// server-side.
test("api: CORS headers allow a cross-origin caller (the browser extension)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("an OPTIONS preflight gets the allow headers and a 204, no auth required", async () => {
    const res = await fetch(`${server.baseUrl}/api/admin/time-log/current`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://fakeidfortest" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers") || "", /x-session-token/i);
  });

  await t.test("a real GET request also carries the allow-origin header", async () => {
    const login = await server.call("POST", "/api/auth/login", { body: { id: "ADMIN", pin: "9999" } });
    const res = await fetch(`${server.baseUrl}/api/admin/time-log/current`, {
      headers: { "x-session-token": login.body.token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  await t.test("the static site itself is unaffected -- no CORS headers outside /api", async () => {
    const res = await fetch(`${server.baseUrl}/`);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});
