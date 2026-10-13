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
const integrationRoutes = require("./routes/integrations");
const timeOffRoutes = require("./routes/timeOff");

function createApp() {
  const app = express();

  // TEMPORARY diagnostic -- Krista is seeing a 403 "Not logged in" on
  // POST /api/admin/smartsheet/sync-woms that our own code structurally
  // cannot produce (requireAuth's "Not logged in" branch has only ever
  // returned 401, in every version in git history). This logs exactly
  // what the Node process actually receives for that one route, so we can
  // see whether it's really hitting this process with the headers the
  // browser sent, or something upstream (Caddy, a stale process, a proxy)
  // is intercepting it first. Remove once that's root-caused.
  app.use((req, res, next) => {
    if (req.path === "/api/admin/smartsheet/sync-woms") {
      console.log("[diag] incoming", req.method, req.path, {
        hasSessionToken: Boolean(req.header("x-session-token")),
        origin: req.header("origin"),
        userAgent: req.header("user-agent"),
      });
      const originalStatus = res.status.bind(res);
      res.status = (code) => {
        console.log("[diag] app.js setting status", code, "for", req.method, req.path);
        return originalStatus(code);
      };
    }
    next();
  });

  // Baseline security response headers (CSP, X-Content-Type-Options,
  // X-Frame-Options, etc.) -- defaults work as-is since this app only ever
  // loads its own same-origin JS/CSS plus the one Google Fonts stylesheet
  // already in index.html.
  //
  // helmet's default CSP includes upgrade-insecure-requests, which tells
  // the browser to rewrite any plain-http:// request on this page to
  // https:// first. That's correct now that Caddy serves real HTTPS on
  // services-works.com (see scripts/deploy.sh and README "Where this
  // stands") -- it was deliberately dropped here for a stretch while the
  // site only had a bare IP and no cert, since back then nothing was
  // listening on 443 and every rewritten request just hung, turning the
  // whole app into a stuck blank page. Left as helmet's own default now.
  app.use(helmet());

  // The browser-toolbar extension (a separate chrome-extension:// origin,
  // not this site) needs to call these same /api/ routes directly -- a
  // plain browser request from any other origin is blocked by CORS by
  // default, and the extension's popup is exactly that: a different
  // origin making a fetch() call, not a server-to-server request (which
  // was never subject to CORS at all, so this isn't opening anything up
  // that curl/Postman/the extension's own background worker couldn't
  // already reach). Safe to allow any origin here specifically because
  // auth is a bearer-style x-session-token header the caller must already
  // have, never a cookie -- there's no ambient browser credential for a
  // malicious page to silently ride along on, which is the actual risk
  // `Access-Control-Allow-Origin: *` would otherwise create. Scoped to
  // /api/ only; the static site itself has no reason to allow this.
  app.use("/api", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

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
  app.use("/api/admin/integrations", integrationRoutes);
  app.use("/api/time-off", timeOffRoutes);

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
