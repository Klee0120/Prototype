const { createApp } = require("./app");
const { startSmartsheetAutoSync, SYNC_TIMES, TIMEZONE } = require("./scheduler");

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Labor allocation prototype running at http://localhost:${PORT}`);
  startSmartsheetAutoSync();
  console.log(`Smartsheet auto-sync scheduled for ${SYNC_TIMES.join(", ")} ${TIMEZONE}, Mon-Fri`);
});
