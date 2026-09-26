const db = require("../data/db");

function requireAuth(req, res, next) {
  const token = req.header("x-session-token");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const user = db.getSessionUser(token);
  if (!user || !user.active) return res.status(401).json({ error: "Session expired or invalid" });
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
