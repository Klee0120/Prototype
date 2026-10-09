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

// Financials is limited to Midwest admins (by their own home location's
// territory -- see db.getAdminTerritory) plus whoever holds the RFM/
// reviewer role, regardless of their own territory. An admin with no home
// location set yet (territory null) is let through rather than blocked --
// see getAdminTerritory's own comment for why. Always follows requireAdmin
// on the same router, so req.user is already a confirmed admin here.
function requireFinancialsAccess(req, res, next) {
  const territory = db.getAdminTerritory(req.user);
  const isReviewer = req.user.id === db.getPseReviewerId();
  if (territory != null && territory !== "Midwest" && !isReviewer) {
    return res.status(403).json({ error: "Financials is limited to Midwest admins and the RFM reviewer" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireFinancialsAccess };
