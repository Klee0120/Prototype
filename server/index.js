const { createApp } = require("./app");
const {
  startSmartsheetAutoSync,
  startNightlyBackup,
  startVendorComplianceReminders,
  SYNC_TIMES,
  BACKUP_TIME,
  COMPLIANCE_REMINDER_TIME,
  TIMEZONE,
} = require("./scheduler");

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Labor allocation prototype running at http://localhost:${PORT}`);
  startSmartsheetAutoSync();
  console.log(`Smartsheet auto-sync scheduled for ${SYNC_TIMES.join(", ")} ${TIMEZONE}, Mon-Fri`);
  startNightlyBackup();
  console.log(`Nightly backup scheduled for ${BACKUP_TIME} ${TIMEZONE}, every day`);
  // Off by default -- this actually emails vendors, so it only starts once
  // someone has used the Vendor Compliance dashboard's Preview/Send Now
  // buttons to confirm the list and wording are right. Set
  // VENDOR_COMPLIANCE_REMINDERS_AUTO=true once that's done.
  if (process.env.VENDOR_COMPLIANCE_REMINDERS_AUTO === "true") {
    startVendorComplianceReminders();
    console.log(`Vendor compliance reminders scheduled for ${COMPLIANCE_REMINDER_TIME} ${TIMEZONE}, Mon-Fri`);
  } else {
    console.log("Vendor compliance reminders: automatic sending is OFF (set VENDOR_COMPLIANCE_REMINDERS_AUTO=true to enable) -- manual Preview/Send Now still available from the Vendor Compliance dashboard");
  }
});
