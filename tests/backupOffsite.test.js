// Its own file: offsiteBackup.js (like mailer.js, see
// vendorPortalInvoiceDelivery.test.js's own comment) reads BACKUP_S3_* into
// module-level consts once, at require time. Every other backup test file
// deliberately runs with offsite storage unconfigured; mixing the two
// states in one file would mean the first require wins for the whole file.
process.env.BACKUP_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
process.env.BACKUP_S3_BUCKET = "serviceworks-backups";
process.env.BACKUP_S3_REGION = "nyc3";
process.env.BACKUP_S3_ACCESS_KEY = "test-access-key";
process.env.BACKUP_S3_SECRET_KEY = "test-secret-key";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const runId = crypto.randomUUID();
process.env.LABOR_BACKUP_DIR = path.join(os.tmpdir(), `labor-test-backups-offsite-${runId}`);
process.env.LABOR_BACKUP_RETENTION = "3";

const { startServer } = require("./helpers");
const { runBackup } = require("../server/utils/backup");

test("backup: pushes the encrypted db snapshot offsite when BACKUP_S3_* is configured", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const originalFetch = global.fetch;
  let putCall = null;
  global.fetch = async (url, options) => {
    putCall = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await runBackup();

  assert.deepEqual(result.offsite, { attempted: true, succeeded: true, error: null });
  assert.ok(putCall, "expected the offsite PUT to actually fire");
  assert.equal(putCall.url, `https://nyc3.digitaloceanspaces.com/serviceworks-backups/${path.basename(result.dbBackupPath)}`);
  assert.equal(putCall.options.method, "PUT");
  // Exactly the encrypted bytes already written to disk -- not a second,
  // separately-encrypted copy.
  assert.ok(putCall.options.body.equals(fs.readFileSync(result.dbBackupPath)));
});

test("backup: a failed offsite push doesn't fail the backup itself -- the local encrypted copy is what matters most", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "bucket unreachable" });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await runBackup();

  assert.equal(result.offsite.attempted, true);
  assert.equal(result.offsite.succeeded, false);
  assert.match(result.offsite.error, /500/);
  // The local backup still exists and is still valid, offsite failure or not.
  assert.ok(fs.existsSync(result.dbBackupPath));
});
