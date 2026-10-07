const express = require("express");
const helmet = require("helmet");
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
const reclassRoutes = require("./routes/reclasses");
const glRoutes = require("./routes/gl");
const timeLogRoutes = require("./routes/timeLog");

function createApp() {
  const app = express();

  // Baseline security response headers (CSP, X-Content-Type-Options,
  // X-Frame-Options, etc.) -- defaults work as-is since this app only ever
  // loads its own same-origin JS/CSS plus the one Google Fonts stylesheet
  // already in index.html. Doesn't touch the actual gap (no TLS yet --
  // see README "Where this stands"), just closes off the cheap stuff.
  //
  // upgrade-insecure-requests is dropped from helmet's default CSP: on a
  // site still served over plain HTTP (no cert yet), that directive tells
  // the browser to silently rewrite every request -- scripts, the API
  // calls, everything -- to https:// first. There's nothing listening on
  // 443, so every one of those just hangs, which is exactly what turned
  // the whole app into a stuck blank page the first time this shipped.
  // Safe to bring back once the HTTPS gap itself is closed (see README).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "upgrade-insecure-requests": null,
        },
      },
    })
  );

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
  app.use("/api/admin/reclasses", reclassRoutes);
  app.use("/api/admin/gl", glRoutes);
  app.use("/api/admin/time-log", timeLogRoutes);

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
