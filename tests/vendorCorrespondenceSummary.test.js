// A separate file from vendorCorrespondence.test.js on purpose:
// aiSummarizer.js reads ANTHROPIC_API_KEY into a module-level const at
// require time, and server/routes/vendors.js requires it as soon as
// ./helpers pulls in server/app -- so this env var has to be set before
// that very first require happens. Each test file gets its own child
// process under `node --test` (see helpers.js's own comment), which is
// exactly what makes this safe to do in isolation here without affecting
// every other test file's "not configured" default.
process.env.ANTHROPIC_API_KEY = "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("vendors: correspondence entries get a real AI-generated summary when configured", async (t) => {
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    if (url === "https://api.anthropic.com/v1/messages") {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "Vendor sent an updated COI and asked about next steps." }] }),
      };
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const server = await startServer();
  t.after(() => server.close());

  const createRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Summary Test Co" } });
  const vendorId = createRes.body.id;

  await t.test("manual logging gets a real summary back", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/correspondence`, {
      userId: "ADMIN",
      body: { subject: "COI renewal", correspondent: "Jane Vendor", bodyText: "Attached is our updated certificate of insurance." },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.summary, "Vendor sent an updated COI and asked about next steps.");
    assert.match(capturedBody.messages[0].content, /COI renewal/);
  });

  await t.test("a blank fallback entry (no real body text) never calls the AI at all", async () => {
    capturedBody = null;
    const res = await server.upload(`/api/admin/vendors/${vendorId}/correspondence/import-eml`, {
      userId: "ADMIN",
      fileName: "screenshot.png",
      fileContent: "not a real image, fine for this test",
      mimeType: "image/png",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.entry.summary, null);
    assert.equal(capturedBody, null, "no body text means summarizeCorrespondence's own guard short-circuits before any API call");
  });

  await t.test("the list endpoint carries the summary through too", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/correspondence`, { userId: "ADMIN" });
    const withSummary = res.body.find((e) => e.summary);
    assert.equal(withSummary.summary, "Vendor sent an updated COI and asked about next steps.");
  });
});
