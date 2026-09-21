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

  app.use(express.static(path.join(__dirname, "..", "public")));

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
