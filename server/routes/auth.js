const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// In-memory login throttling, keyed by normalized ID. Fine for a
// single-process deployment; resets on restart.
const attempts = new Map();

function isLocked(key) {
  const entry = attempts.get(key);
  return Boolean(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}

function recordFailure(key) {
  const entry = attempts.get(key) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_DURATION_MS;
    entry.count = 0;
  }
  attempts.set(key, entry);
}

function clearFailures(key) {
  attempts.delete(key);
}

router.post("/login", (req, res) => {
  const { id, pin } = req.body || {};
  if (!id || !pin) return res.status(400).json({ error: "ID and PIN are required" });

  const key = String(id).toUpperCase();
  if (isLocked(key)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const user = db.verifyLogin(id, pin);
  if (!user) {
    recordFailure(key);
    return res.status(401).json({ error: "Invalid ID or PIN" });
  }

  clearFailures(key);
  const token = db.createSession(user.id);
  db.addAudit(user.id, "LOGIN", `${user.name} logged in`);

  res.json({
    token,
    id: user.id,
    name: user.name,
    role: user.role,
  });
});

router.post("/logout", requireAuth, (req, res) => {
  db.deleteSession(req.sessionToken);
  db.addAudit(req.user.id, "LOGOUT", `${req.user.name} logged out`);
  res.json({ ok: true });
});

module.exports = router;
