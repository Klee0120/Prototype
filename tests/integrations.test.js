const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");

// Integrations (API Connections): admin-managed credentials for outside
// systems (UKG, Vroozi, JDE, Hubble, etc.) -- just the connection/
// credential piece, not a real data sync for any specific system (see
// server/data/db.js's own comment on why). Covers: the credential never
// comes back in full once saved, editing without a new secret keeps the
// old one, and the test-connection route makes a real HTTP round trip.
test("Integrations: API connection CRUD + credential masking + live test", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("creating a connection never echoes the raw credential back", async () => {
    const res = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "UKG", baseUrl: "https://api.ukg.example.com", authType: "bearer", credential: "super-secret-token-1234" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.credentialPreview, "••••1234");
    assert.ok(!JSON.stringify(res.body).includes("super-secret-token"), "the raw secret must never appear in the response");
  });

  await t.test("api_key auth requires a header name", async () => {
    const res = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "Vroozi", baseUrl: "https://api.vroozi.example.com", authType: "api_key", credential: "key-value" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("listing connections masks every credential", async () => {
    await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: {
        name: "Vroozi",
        baseUrl: "https://api.vroozi.example.com",
        authType: "api_key",
        apiKeyHeader: "X-API-Key",
        credential: "vroozi-key-9999",
      },
    });
    const res = await server.call("GET", "/api/admin/integrations", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 2);
    for (const c of res.body) {
      assert.ok(c.credentialPreview.startsWith("••••"));
      assert.ok(!JSON.stringify(res.body).includes("vroozi-key-9999"));
    }
  });

  await t.test("editing without a new secret keeps the existing one", async () => {
    const createRes = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "JDE", baseUrl: "https://jde.example.com", authType: "bearer", credential: "original-secret-aaaa" },
    });
    const id = createRes.body.id;

    const editRes = await server.call("PATCH", `/api/admin/integrations/${id}`, {
      userId: "ADMIN",
      body: { name: "JDE Production", baseUrl: "https://jde.example.com" },
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.body.name, "JDE Production");
    assert.equal(editRes.body.credentialPreview, "••••aaaa", "credential should be unchanged when none is sent");

    const rotateRes = await server.call("PATCH", `/api/admin/integrations/${id}`, {
      userId: "ADMIN",
      body: { credential: "rotated-secret-zzzz" },
    });
    assert.equal(rotateRes.body.credentialPreview, "••••zzzz", "a new credential should replace the old one");
  });

  await t.test("deleting a connection removes it from the list", async () => {
    const createRes = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "To Delete", baseUrl: "https://example.com", authType: "bearer", credential: "x" },
    });
    const id = createRes.body.id;

    const deleteRes = await server.call("DELETE", `/api/admin/integrations/${id}`, { userId: "ADMIN" });
    assert.equal(deleteRes.status, 200);

    const listRes = await server.call("GET", "/api/admin/integrations", { userId: "ADMIN" });
    assert.ok(!listRes.body.some((c) => c.id === id));
  });

  await t.test("testing a connection against a real, reachable endpoint reports ok", async () => {
    const createRes = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "Self", baseUrl: server.baseUrl, testPath: "api/meta/current-week", authType: "bearer", credential: "whatever" },
    });
    const id = createRes.body.id;

    const testRes = await server.call("POST", `/api/admin/integrations/${id}/test`, { userId: "ADMIN" });
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.lastTestStatus, "ok");
    assert.ok(testRes.body.lastTestDetail.includes("200"));
    assert.ok(testRes.body.lastTestedAt);
  });

  await t.test("testing a connection against an unreachable host reports failed, not a 500", async () => {
    const createRes = await server.call("POST", "/api/admin/integrations", {
      userId: "ADMIN",
      body: { name: "Unreachable", baseUrl: "http://127.0.0.1:1", authType: "bearer", credential: "whatever" },
    });
    const id = createRes.body.id;

    const testRes = await server.call("POST", `/api/admin/integrations/${id}/test`, { userId: "ADMIN" });
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.lastTestStatus, "failed");
    assert.ok(testRes.body.lastTestDetail);
  });

  await t.test("a non-admin cannot reach the integrations routes", async () => {
    const res = await server.call("GET", "/api/admin/integrations", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});
