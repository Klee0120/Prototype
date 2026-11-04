const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

// A dedicated file (not using tests/helpers.js) because helpers.js sets
// FILE_ENCRYPTION_KEY unconditionally for every other test file -- this is
// the one place that needs to prove what happens when it's genuinely
// unset. `node --test` gives each file its own process/module cache, so
// this is isolated from every other file's env regardless of run order.
const runId = crypto.randomUUID();
process.env.LABOR_DB_PATH = path.join(os.tmpdir(), `labor-test-${runId}.sqlite`);
process.env.LABOR_UPLOADS_DIR = path.join(os.tmpdir(), `labor-test-uploads-${runId}`);
process.env.LABOR_BACKUP_DIR = path.join(os.tmpdir(), `labor-test-backups-${runId}`);
delete process.env.FILE_ENCRYPTION_KEY;

require("../server/data/db"); // triggers seeding at require time, same as app.js pulling it in
const { runBackup, BACKUP_DIR } = require("../server/utils/backup");

test("backup: refuses to write a database backup when FILE_ENCRYPTION_KEY isn't configured", async () => {
  await assert.rejects(() => runBackup(), /FILE_ENCRYPTION_KEY is not configured/);
  // Nothing plaintext should have been left behind either.
  const leftovers = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];
  assert.equal(leftovers.length, 0, `expected no backup artifacts, found: ${leftovers.join(", ")}`);
});
