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

// Matches server/data/seed.js. Lets test call sites keep saying
// `{ userId: "T1001" }` while actually exercising the real login/session
// flow under the hood (a session token is fetched once per user and cached).
const DEMO_PINS = { T1001: "1234", T1002: "1234", T1003: "2345", ADMIN: "9999" };

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tokenCache = new Map();

  async function tokenFor(userId) {
    if (tokenCache.has(userId)) return tokenCache.get(userId);
    const pin = DEMO_PINS[userId];
    if (!pin) throw new Error(`No demo PIN known for ${userId}`);
    const res = await fetch(baseUrl + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId, pin }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Login failed for ${userId}: ${json.error}`);
    tokenCache.set(userId, json.token);
    return json.token;
  }

  async function authHeaders({ userId, token }) {
    if (token !== undefined) return token ? { "x-session-token": token } : {};
    if (userId) return { "x-session-token": await tokenFor(userId) };
    return {};
  }

  async function call(method, urlPath, { userId, token, body } = {}) {
    const headers = { "Content-Type": "application/json", ...(await authHeaders({ userId, token })) };
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

  async function upload(urlPath, { userId, token, fields = {}, fileName = "test.txt", fileContent = "test content", mimeType = "text/plain" } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([fileContent], { type: mimeType }), fileName);

    const headers = await authHeaders({ userId, token });
    const res = await fetch(baseUrl + urlPath, { method: "POST", headers, body: form });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  async function rawGet(urlPath, { userId, token } = {}) {
    const headers = await authHeaders({ userId, token });
    const res = await fetch(baseUrl + urlPath, { headers });
    const text = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, text };
  }

  return {
    baseUrl,
    call,
    upload,
    rawGet,
    tokenFor,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startServer, dbPath, uploadsDir };
