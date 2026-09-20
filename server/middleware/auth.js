const db = require("../data/db");

// Prototype-only auth: the client sends the technician/admin id in a header
// after a successful /api/login. There is no token/session/crypto here —
// this is intentionally mock auth for a functional prototype, not production.
function requireAuth(req, res, next) {
  const id = req.header("x-user-id");
  if (!id) return res.status(401).json({ error: "Not logged in" });
  const user = db.findTechnician(id);
  if (!user || !user.active) return res.status(401).json({ error: "Invalid session" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
