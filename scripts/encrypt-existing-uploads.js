#!/usr/bin/env node
// One-time migration: encrypts every file already sitting in UPLOADS_DIR
// that was written before encryption at rest shipped (server/utils/
// fileEncryption.js). Run this ONCE, after the new code is deployed and
// the service has been restarted with FILE_ENCRYPTION_KEY set -- so any
// upload that happens to land mid-run is already encrypted on write and
// this script correctly skips it as "already done."
//
// Usage:
//   node scripts/encrypt-existing-uploads.js
//
// BACK UP FIRST. This overwrites files in place (atomically -- see below --
// but still, back up before running anything that rewrites every file you
// have). The app's own backup already covers this:
//   node -e "require('./server/utils/backup').runBackup()"
//
// Safe to re-run: a file already starting with fileEncryption's MAGIC
// marker is skipped, not re-encrypted. If the process is killed mid-run,
// re-running picks up wherever it left off -- each file is written to a
// sibling temp path and only renamed over the original once fully written
// (an atomic operation on the same filesystem), so a crash mid-file never
// leaves a half-written, corrupted file in UPLOADS_DIR.

const fs = require("fs");
const path = require("path");
const fileEncryption = require("../server/utils/fileEncryption");
const db = require("../server/data/db");

function main() {
  if (!fileEncryption.isConfigured()) {
    console.error("FILE_ENCRYPTION_KEY is not set -- nothing to encrypt with. Set it in this shell's environment first.");
    process.exit(1);
  }

  const entries = fs.readdirSync(db.UPLOADS_DIR, { withFileTypes: true });
  let encrypted = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(db.UPLOADS_DIR, entry.name);
    try {
      const raw = fs.readFileSync(fullPath);
      if (raw.length >= fileEncryption.MAGIC.length && raw.subarray(0, fileEncryption.MAGIC.length).equals(fileEncryption.MAGIC)) {
        alreadyDone++;
        continue;
      }
      const encryptedBuffer = fileEncryption.encryptBuffer(raw);
      const tmpPath = `${fullPath}.encrypting-tmp`;
      fs.writeFileSync(tmpPath, encryptedBuffer);
      fs.renameSync(tmpPath, fullPath);
      encrypted++;
    } catch (err) {
      failed++;
      console.error(`FAILED: ${entry.name} -- ${err.message}`);
    }
  }

  console.log(`Encrypted: ${encrypted}`);
  console.log(`Already encrypted (skipped): ${alreadyDone}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error("One or more files failed to encrypt -- see errors above. Safe to re-run once resolved.");
    process.exit(1);
  }
}

main();
