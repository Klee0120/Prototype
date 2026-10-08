const express = require("express");
const db = require("../data/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get("/auth-types", (req, res) => {
  res.json(db.API_CONNECTION_AUTH_TYPES);
});

router.get("/", (req, res) => {
  res.json(db.listApiConnections());
});

router.get("/:id", (req, res) => {
  const connection = db.findApiConnection(req.params.id);
  if (!connection) return res.status(404).json({ error: "Connection not found" });
  res.json(connection);
});

router.post("/", (req, res) => {
  try {
    const connection = db.createApiConnection(req.body || {}, req.user.id);
    db.addAudit(req.user.id, "INTEGRATION_CREATED", `${req.user.name} added a connection to "${connection.name}"`);
    res.status(201).json(connection);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  try {
    const updated = db.updateApiConnection(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Connection not found" });
    db.addAudit(req.user.id, "INTEGRATION_UPDATED", `${req.user.name} updated the "${updated.name}" connection`);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", (req, res) => {
  const existing = db.findApiConnection(req.params.id);
  if (!existing) return res.status(404).json({ error: "Connection not found" });
  db.deleteApiConnection(req.params.id);
  db.addAudit(req.user.id, "INTEGRATION_DELETED", `${req.user.name} removed the "${existing.name}" connection`);
  res.json({ ok: true });
});

// A real request to the connection's own base URL, not a format check --
// see db.testApiConnection. Never 500s on a bad credential/unreachable
// host; the result (ok/failed + a human-readable detail) is the answer.
router.post("/:id/test", async (req, res) => {
  const result = await db.testApiConnection(req.params.id);
  if (!result) return res.status(404).json({ error: "Connection not found" });
  res.json(result);
});

module.exports = router;
