const db = require("../data/db");

// The vendor portal's own auth gate -- deliberately NOT requireAuth. A
// vendor session lives in its own table (vendor_sessions) and its own
// header (x-vendor-session-token, not x-session-token), so there is no
// value a vendor's browser could ever send that requireAuth/requireAdmin
// would accept, and nothing an internal admin/tech session sends here
// means anything either. Attaches req.vendor (never req.user) -- every
// vendor-portal route reads req.vendor.id, never a caller-supplied vendor
// id, for exactly the record it's allowed to touch.
function requireVendorAuth(req, res, next) {
  const token = req.header("x-vendor-session-token");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const vendor = db.getVendorSessionUser(token);
  if (!vendor) return res.status(401).json({ error: "Session expired or invalid" });
  req.vendor = vendor;
  req.vendorSessionToken = token;
  next();
}

module.exports = { requireVendorAuth };
