const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Each test file runs in its own child process under `node --test`, so
// setting this before the first require of server/app (which pulls in
// server/data/db) is enough to give that file an isolated, throwaway store.
const dbPath = path.join(os.tmpdir(), `labor-test-${crypto.randomUUID()}.json`);
process.env.LABOR_DB_PATH = dbPath;
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

  return {
    baseUrl,
    call,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startServer, dbPath };
