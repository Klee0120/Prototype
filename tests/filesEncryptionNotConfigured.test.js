const os = require("os");
const path = require("path");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

// Deliberately its own file, not a sub-test inside files.test.js --
// tests/helpers.js unconditionally sets a fixed FILE_ENCRYPTION_KEY before
// its own first require of server/app (see its own comment on why: every
// other test file needs uploads to actually work), so there's no way to
// exercise the "key genuinely unset" path through helpers.js at all. This
// file sets up its own isolated DB/uploads dir the same way helpers.js
// does, but leaves FILE_ENCRYPTION_KEY unset, before its own first require
// of server/app -- proving uploads fail closed (503, nothing written)
// rather than silently falling back to plaintext when the key is missing.
delete process.env.FILE_ENCRYPTION_KEY;
const runId = crypto.randomUUID();
process.env.LABOR_DB_PATH = path.join(os.tmpdir(), `labor-test-noenc-${runId}.sqlite`);
process.env.LABOR_UPLOADS_DIR = path.join(os.tmpdir(), `labor-test-noenc-uploads-${runId}`);

const { createApp } = require("../server/app");

test("files: uploads are refused (fail closed) when FILE_ENCRYPTION_KEY is not configured", async (t) => {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const loginRes = await fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "ADMIN", pin: "9999" }),
  });
  const { token } = await loginRes.json();

  const create = await fetch(baseUrl + "/api/admin/vendors", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-token": token },
    body: JSON.stringify({ name: "Unconfigured-Key Test Vendor" }),
  });
  const vendor = await create.json();

  const form = new FormData();
  form.append("relatedType", "vendor");
  form.append("relatedId", String(vendor.id));
  form.append("category", "ach");
  form.append("file", new Blob(["should never be written"], { type: "text/plain" }), "should-fail.txt");

  const uploadRes = await fetch(baseUrl + "/api/files", {
    method: "POST",
    headers: { "x-session-token": token },
    body: form,
  });
  assert.equal(uploadRes.status, 503);
  const body = await uploadRes.json();
  assert.match(body.error, /encryption/i);

  const listRes = await fetch(baseUrl + `/api/files?relatedType=vendor&relatedId=${vendor.id}`, {
    headers: { "x-session-token": token },
  });
  const list = await listRes.json();
  assert.equal(list.length, 0, "nothing should have been written");
});
