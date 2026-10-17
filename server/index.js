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
  startVendorComplianceReminders();
  console.log(`Vendor compliance reminders scheduled for ${COMPLIANCE_REMINDER_TIME} ${TIMEZONE}, Mon-Fri`);
});
