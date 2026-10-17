#!/usr/bin/env node
// One-time cleanup for cancelled tasks left behind by an old Smartsheet-sync
// bug: an early version of syncWomsFromSheetRows manufactured a placeholder
// "PENDING-<rowId>" WOM for a sheet row with neither a real WOM # nor a real
// project name (a header/legend/blank row, or a request cleared out before
// ever getting a WOM #). That's since been fixed -- such a row is now
// skipped outright -- but the placeholder WOMs it already created get
// caught by a newer safety net: the next sync that sees the row still has
// no real WOM #/description marks that WOM's task cancelled and deletes the
// WOM itself. The task row survives, sitting there forever as "Cancelled"
// with a WOM link that no longer resolves to anything -- pure noise, safe
// to remove outright.
//
// Usage:
//   node scripts/cleanup-pending-tasks.js            (dry run -- lists what would be deleted)
//   node scripts/cleanup-pending-tasks.js --confirm   (actually deletes them)

const db = require("../server/data/db");

const confirm = process.argv.includes("--confirm");

const candidates = db
  .listTasks({ status: ["cancelled"] })
  .filter((t) => t.related_wom_code && t.related_wom_code.startsWith("PENDING-"));

if (candidates.length === 0) {
  console.log("No cancelled PENDING-* placeholder tasks found. Nothing to do.");
  process.exit(0);
}

console.log(`Found ${candidates.length} cancelled task(s) tied to a deleted placeholder WOM:\n`);
for (const t of candidates) {
  console.log(`  #${t.id}  "${t.title}"  (${t.related_wom_code})`);
}

if (!confirm) {
  console.log(`\nDry run only -- nothing deleted. Re-run with --confirm to actually delete these ${candidates.length} task(s).`);
  process.exit(0);
}

for (const t of candidates) {
  db.deleteTask(t.id);
}
console.log(`\nDeleted ${candidates.length} task(s).`);
