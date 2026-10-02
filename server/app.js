const express = require("express");
const path = require("path");

const { currentWeekMonday } = require("./utils/week");
const authRoutes = require("./routes/auth");
const technicianRoutes = require("./routes/technicians");
const womRoutes = require("./routes/woms");
const adminRoutes = require("./routes/admin");
const auditRoutes = require("./routes/audit");
const fileRoutes = require("./routes/files");
const locationRoutes = require("./routes/locations");
const vendorRoutes = require("./routes/vendors");
const vendorLookupRoutes = require("./routes/vendorLookup");
const scheduleRoutes = require("./routes/schedule");
const taskRoutes = require("./routes/tasks");
const poRoutes = require("./routes/pos");

function createApp() {
  const app = express();

  app.use(express.json());

  app.get("/api/meta/current-week", (req, res) => {
    res.json({ weekMonday: currentWeekMonday() });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/technicians", technicianRoutes);
  app.use("/api/woms", womRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/audit", auditRoutes);
  app.use("/api/files", fileRoutes);
  app.use("/api/locations", locationRoutes);
  app.use("/api/admin/vendors", vendorRoutes);
  app.use("/api/vendors", vendorLookupRoutes);
  app.use("/api/schedule", scheduleRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/admin/pos", poRoutes);

  // Every redeploy restarts this process (see scripts/redeploy.sh), but a
  // browser tab left open from before -- or one that just hits a normal
  // reload -- can still serve a visual/behavioral change from stale cached
  // JS/CSS well after the server itself is running the new code (Express's
  // static defaults allow caching, just with revalidation, which isn't
  // reliable across every browser/network path). These are small internal
  // tooling files, not public assets at any real scale, so the safest
  // default is "never cache" rather than debugging a stale badge color or
  // stale button behavior after every deploy.
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    })
  );

  // Keep API errors as JSON (bad request bodies, oversized uploads) instead
  // of falling through to Express's default HTML error page.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.name === "MulterError" ? 400 : 500);
    res.status(status).json({ error: err.message || "Unexpected server error" });
  });

  return app;
}

module.exports = { createApp };
