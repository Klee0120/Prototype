// Nightly off-the-live-file backup of the SQLite database and the
// uploads directory (every COI/W-9/ACH/etc. anyone's ever attached) --
// both are .gitignore'd (correctly, they're live business data, not
// something that belongs in git history), which means neither has ever
// had any protection against disk loss on the droplet. Wired into the
// scheduler (see server/scheduler.js's startNightlyBackup) to run once a
// day; also callable directly for a manual/on-demand backup.
const fs = require("fs");
const path = require("path");
const db = require("../data/db");
const fileEncryption = require("./fileEncryption");
const offsiteBackup = require("./offsiteBackup");

const BACKUP_DIR = process.env.LABOR_BACKUP_DIR || path.join(__dirname, "..", "data", "backups");
const RETENTION_COUNT = Number(process.env.LABOR_BACKUP_RETENTION || 14);

function timestampSlug() {
  // Sortable and filesystem-safe -- ":" isn't valid in a Windows path and
  // reads worse than "-" anywhere, so this isn't just toISOString().
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Deletes everything past the newest RETENTION_COUNT entries matching
// `prefix` in BACKUP_DIR -- names sort chronologically because the
// timestamp slug does, so no need to stat/parse dates back out.
function pruneOld(prefix) {
  const entries = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith(prefix))
    .sort();
  const toRemove = entries.slice(0, Math.max(0, entries.length - RETENTION_COUNT));
  for (const name of toRemove) {
    fs.rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
  }
  return toRemove.length;
}

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const slug = timestampSlug();

  // The live DB holds real GL/PO/WOM financial figures as plain columns,
  // not individually encrypted (see ARCHITECTURE.md -- a deliberate choice
  // so reporting can SUM/GROUP BY them directly), which makes a raw copy
  // of it the single most exposed plaintext copy of that data anywhere on
  // disk. VACUUM INTO a throwaway path first (same WAL-safety reasoning as
  // before), then encrypt the bytes with the same FILE_ENCRYPTION_KEY the
  // uploaded documents already use, and never let the plaintext copy
  // survive on disk. Fails closed if no key is configured -- same rule
  // uploads already follow -- rather than silently writing an unencrypted
  // financial-data snapshot.
  if (!fileEncryption.isConfigured()) {
    throw new Error("FILE_ENCRYPTION_KEY is not configured -- refusing to write an unencrypted database backup");
  }
  const dbBackupPath = path.join(BACKUP_DIR, `store-${slug}.sqlite.enc`);
  const rawDbPath = path.join(BACKUP_DIR, `.store-${slug}.sqlite.tmp`);
  db.backupDatabaseTo(rawDbPath);
  const rawBytes = fs.readFileSync(rawDbPath);
  fs.writeFileSync(dbBackupPath, fileEncryption.encryptBuffer(rawBytes));
  fs.rmSync(rawDbPath);

  const uploadsBackupDir = path.join(BACKUP_DIR, `uploads-${slug}`);
  if (fs.existsSync(db.UPLOADS_DIR)) {
    // Each file under UPLOADS_DIR is already individually encrypted at
    // rest (see fileEncryption.js's own chokepoint in db.js) -- a plain
    // copy of already-ciphertext files needs no extra encryption here.
    fs.cpSync(db.UPLOADS_DIR, uploadsBackupDir, { recursive: true });
  }

  const prunedDb = pruneOld("store-");
  const prunedUploads = pruneOld("uploads-");

  // Off-site push of the (already-encrypted) DB snapshot -- inactive
  // until BACKUP_S3_* is configured, see offsiteBackup.js. Never allowed
  // to fail the backup itself: the local, encrypted copy is the thing
  // that matters most and must still exist even if the off-site push
  // can't reach its bucket tonight.
  const offsite = { attempted: false, succeeded: false, error: null };
  if (offsiteBackup.isConfigured()) {
    offsite.attempted = true;
    try {
      await offsiteBackup.uploadObject(`store-${slug}.sqlite.enc`, fs.readFileSync(dbBackupPath));
      offsite.succeeded = true;
    } catch (err) {
      offsite.error = err.message;
    }
  }

  return {
    dbBackupPath,
    uploadsBackupDir,
    pruned: prunedDb + prunedUploads,
    offsite,
  };
}

module.exports = { runBackup, BACKUP_DIR, RETENTION_COUNT };
