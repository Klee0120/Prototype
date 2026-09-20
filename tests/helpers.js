const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Each test file runs in its own child process under `node --test`, so
// setting this before the first require of server/app (which pulls in
// server/data/db) is enough to give that file an isolated, throwaway
// database and uploads folder.
const runId = crypto.randomUUID();
const dbPath = path.join(os.tmpdir(), `labor-test-${runId}.sqlite`);
const uploadsDir = path.join(os.tmpdir(), `labor-test-uploads-${runId}`);
process.env.LABOR_DB_PATH = dbPath;
process.env.LABOR_UPLOADS_DIR = uploadsDir;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { createApp } = require("../server/app");

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function call(method, urlPath, { userId, body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (userId) headers["x-user-id"] = userId;
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  async function upload(urlPath, { userId, fields = {}, fileName = "test.txt", fileContent = "test content", mimeType = "text/plain" } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([fileContent], { type: mimeType }), fileName);

    const headers = {};
    if (userId) headers["x-user-id"] = userId;
    const res = await fetch(baseUrl + urlPath, { method: "POST", headers, body: form });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  async function rawGet(urlPath, { userId } = {}) {
    const headers = {};
    if (userId) headers["x-user-id"] = userId;
    const res = await fetch(baseUrl + urlPath, { headers });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, text };
  }

  return {
    baseUrl,
    call,
    upload,
    rawGet,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startServer, dbPath, uploadsDir };
