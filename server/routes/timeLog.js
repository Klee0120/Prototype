const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

// The widget's own fixed category list -- never admin-editable, so every
// admin's log stays comparable to every other's.
router.get("/categories", (req, res) => {
  res.json(db.TIME_LOG_CATEGORIES);
});

// Short, interrupt-driven tasks logged as one fixed-duration click instead
// of a running clock -- see db.js's INSTANT_LOG_CATEGORIES.
router.get("/instant-categories", (req, res) => {
  res.json(db.INSTANT_LOG_CATEGORIES);
});

// What the widget polls on mount/reload to pick a still-running clock back
// up exactly where it was -- null if nothing's running right now.
router.get("/current", (req, res) => {
  res.json(db.getRunningTimeLogEntry(req.user.id));
});

router.get("/", (req, res) => {
  const { from, to } = req.query;
  res.json(db.listTimeLogEntries(req.user.id, { from, to }));
});

router.post("/start", (req, res) => {
  const { category, note, relatedPoId, relatedVendorId, relatedWomCode } = req.body || {};
  if (!db.TIME_LOG_CATEGORIES.some((c) => c.key === category)) {
    return res.status(400).json({ error: `category must be one of: ${db.TIME_LOG_CATEGORIES.map((c) => c.key).join(", ")}` });
  }
  const entry = db.startTimeLogEntry(req.user.id, category, { note, relatedPoId, relatedVendorId, relatedWomCode });
  res.status(201).json(entry);
});

// Deliberately independent of /start and /stop -- never touches a running
// entry (see db.js's logInstantTimeEntry for why).
router.post("/instant", (req, res) => {
  const { category, note, relatedPoId } = req.body || {};
  if (!db.INSTANT_LOG_CATEGORIES.some((c) => c.key === category)) {
    return res.status(400).json({ error: `category must be one of: ${db.INSTANT_LOG_CATEGORIES.map((c) => c.key).join(", ")}` });
  }
  try {
    const entry = db.logInstantTimeEntry(req.user.id, category, { note, relatedPoId });
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/stop", (req, res) => {
  const { note, relatedPoId, relatedVendorId, relatedWomCode } = req.body || {};
  const entry = db.stopTimeLogEntry(req.user.id, { note, relatedPoId, relatedVendorId, relatedWomCode });
  if (!entry) return res.status(400).json({ error: "Nothing is currently running" });
  res.json(entry);
});

// Attach/edit a note or a linked PO/vendor/WOM on the running entry (or
// any past entry of your own) without stopping the clock.
router.patch("/:id", (req, res) => {
  const { note, relatedPoId, relatedVendorId, relatedWomCode } = req.body || {};
  const entry = db.updateTimeLogEntry(req.user.id, Number(req.params.id), { note, relatedPoId, relatedVendorId, relatedWomCode });
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  res.json(entry);
});

module.exports = router;
