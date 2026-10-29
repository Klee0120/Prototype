const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

// backup.js reads LABOR_BACKUP_DIR/LABOR_BACKUP_RETENTION once, at first
// require -- same convention as helpers.js setting LABOR_DB_PATH/
// LABOR_UPLOADS_DIR before the first require of server/app. Must happen
// before requiring either helpers or backup.
const backupRunId = crypto.randomUUID();
const backupDir = path.join(os.tmpdir(), `labor-test-backups-${backupRunId}`);
process.env.LABOR_BACKUP_DIR = backupDir;
process.env.LABOR_BACKUP_RETENTION = "3";

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");
const { runBackup, BACKUP_DIR, RETENTION_COUNT } = require("../server/utils/backup");
const fileEncryption = require("../server/utils/fileEncryption");

// Decrypts a .sqlite.enc backup to a throwaway plaintext path and opens it
// -- the db snapshot tests below need a real, queryable DatabaseSync, and
// the whole point of encrypting the backup is that it's no longer directly
// openable as-is.
function openDecryptedSnapshot(encPath) {
  const plainPath = `${encPath}.decrypted-for-test.sqlite`;
  const decrypted = fileEncryption.decryptBuffer(fs.readFileSync(encPath));
  fs.writeFileSync(plainPath, decrypted);
  return new DatabaseSync(plainPath);
}

test("backup: BACKUP_DIR/RETENTION_COUNT pick up the env vars set before first require", () => {
  assert.equal(BACKUP_DIR, backupDir);
  assert.equal(RETENTION_COUNT, 3);
});

test("backup: a real backup is a complete, independent copy of the live database and uploads", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const create = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Backup Test Co" } });
  const vendorId = create.body.id;
  await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendorId), category: "coi" },
    fileName: "coi.pdf",
    fileContent: "pretend coi bytes",
  });

  const result = await runBackup();

  await t.test("the db snapshot is encrypted at rest, not a plain SQLite file", () => {
    assert.ok(fs.existsSync(result.dbBackupPath));
    assert.match(result.dbBackupPath, /\.sqlite\.enc$/);
    const raw = fs.readFileSync(result.dbBackupPath);
    assert.ok(raw.subarray(0, fileEncryption.MAGIC.length).equals(fileEncryption.MAGIC), "expected the backup file to start with the encryption magic bytes");
    // Ciphertext doesn't start with SQLite's own "SQLite format 3\0" magic
    // header -- a stronger, format-level check (vs. just our own magic
    // bytes above) that this isn't a readable SQLite file as-is.
    assert.ok(!raw.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")));
  });

  await t.test("decrypted, the db snapshot is a standalone, valid SQLite file containing the live data", () => {
    const snapshot = openDecryptedSnapshot(result.dbBackupPath);
    const row = snapshot.prepare("SELECT name FROM vendors WHERE id = ?").get(vendorId);
    assert.equal(row.name, "Backup Test Co");
    snapshot.close();
  });

  await t.test("the uploads folder was copied alongside it", () => {
    assert.ok(fs.existsSync(result.uploadsBackupDir));
    const copiedFiles = fs.readdirSync(result.uploadsBackupDir);
    assert.ok(copiedFiles.length > 0, "expected the uploaded COI's stored file to have been copied");
  });

  await t.test("no plaintext temp copy of the database was left behind", () => {
    const leftovers = fs.readdirSync(BACKUP_DIR).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  await t.test("offsite push wasn't attempted -- BACKUP_S3_* isn't configured in this test env", () => {
    assert.deepEqual(result.offsite, { attempted: false, succeeded: false, error: null });
  });
});

test("backup: prunes down to RETENTION_COUNT, removing the oldest first", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  // Clean slate -- the previous test in this file already left a real
  // backup in BACKUP_DIR, which would throw off the exact-survivor
  // assertions below.
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // Pre-seed 4 fake backups, sorted oldest-to-newest by name (same scheme
  // runBackup itself uses -- a sortable ISO-ish slug) -- well before any
  // real run's "now" timestamp, so a real run always sorts after these.
  const fakeNames = ["store-2000-01-01T00-00-00-000Z.sqlite", "store-2000-01-02T00-00-00-000Z.sqlite", "store-2000-01-03T00-00-00-000Z.sqlite", "store-2000-01-04T00-00-00-000Z.sqlite"];
  for (const name of fakeNames) fs.writeFileSync(path.join(BACKUP_DIR, name), "fake");

  await runBackup(); // adds a 5th (real, newest) -- should prune down to RETENTION_COUNT (3)

  const remaining = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith("store-"))
    .sort();
  assert.equal(remaining.length, RETENTION_COUNT);
  // The two oldest fake ones should be gone; the newest two fakes plus the real one survive.
  assert.ok(!remaining.includes(fakeNames[0]));
  assert.ok(!remaining.includes(fakeNames[1]));
  assert.ok(remaining.includes(fakeNames[2]));
  assert.ok(remaining.includes(fakeNames[3]));
});
