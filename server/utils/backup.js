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

  const dbBackupPath = path.join(BACKUP_DIR, `store-${slug}.sqlite`);
  db.backupDatabaseTo(dbBackupPath);

  const uploadsBackupDir = path.join(BACKUP_DIR, `uploads-${slug}`);
  if (fs.existsSync(db.UPLOADS_DIR)) {
    fs.cpSync(db.UPLOADS_DIR, uploadsBackupDir, { recursive: true });
  }

  const prunedDb = pruneOld("store-");
  const prunedUploads = pruneOld("uploads-");

  return {
    dbBackupPath,
    uploadsBackupDir,
    pruned: prunedDb + prunedUploads,
  };
}

module.exports = { runBackup, BACKUP_DIR, RETENTION_COUNT };
