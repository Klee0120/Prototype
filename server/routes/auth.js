const express = require("express");
const db = require("../data/db");
const mailer = require("../utils/mailer");
const { pinStrengthError } = require("../utils/password");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

// Where the emailed reset link should point -- the app has no server-side
// router (it's a single static index.html with client-side view
// switching, see public/js/app.js), so this is just the site's own root
// with a query param app.js checks before deciding what to render. Set
// PUBLIC_BASE_URL in the server's environment once a real domain is live;
// without it, this falls back to the same localhost:PORT a dev server
// already answers on, which is enough to test the flow locally (the email
// just won't be a clickable production link).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// In-memory login throttling, keyed by normalized ID. Fine for a
// single-process deployment; resets on restart.
const attempts = new Map();

// Separate, more lenient throttle for "email me a reset link" -- this
// isn't guarding a PIN guess, it's guarding against someone spamming a
// real person's inbox with reset emails they didn't ask for.
const FORGOT_MAX_ATTEMPTS = 3;
const FORGOT_LOCK_DURATION_MS = 60 * 60 * 1000;
const forgotAttempts = new Map();

function isLocked(map, key) {
  const entry = map.get(key);
  return Boolean(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}

function recordFailure(map, key, maxAttempts, lockDurationMs) {
  const entry = map.get(key) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = Date.now() + lockDurationMs;
    entry.count = 0;
  }
  map.set(key, entry);
}

function clearFailures(map, key) {
  map.delete(key);
}

router.post("/login", (req, res) => {
  const { id, pin } = req.body || {};
  if (!id || !pin) return res.status(400).json({ error: "ID and PIN are required" });

  const key = String(id).toUpperCase();
  if (isLocked(attempts, key)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }

  const user = db.verifyLogin(id, pin);
  if (!user) {
    recordFailure(attempts, key, MAX_ATTEMPTS, LOCK_DURATION_MS);
    return res.status(401).json({ error: "Invalid ID or PIN" });
  }

  clearFailures(attempts, key);
  const token = db.createSession(user.id);
  db.addAudit(user.id, "LOGIN", `${user.name} logged in`);

  res.json({
    token,
    id: user.id,
    name: user.name,
    role: user.role,
    homeLocationCode: user.home_location_code,
    territory: db.getAdminTerritory(user),
    isPseReviewer: user.id === db.getPseReviewerId(),
  });
});

router.post("/logout", requireAuth, (req, res) => {
  db.deleteSession(req.sessionToken);
  db.addAudit(req.user.id, "LOGOUT", `${req.user.name} logged out`);
  res.json({ ok: true });
});

// Self-service "forgot my PIN": emails a one-time reset link to whatever
// address is already on file for this ID. Always answers with the same
// generic message whether or not the ID exists, has an email on file, or
// is active -- telling a stranger "that ID has no email on file" would
// hand them a free way to probe for valid IDs, so the account's actual
// state never leaks out through this endpoint's response, only through
// whether an email actually shows up.
const FORGOT_PIN_GENERIC_MESSAGE = "If that ID has an email on file, a reset link has been sent.";

router.post("/forgot-pin", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "ID is required" });

  const key = String(id).toUpperCase();
  if (isLocked(forgotAttempts, key)) {
    // Same generic shape even when throttled -- a distinct "too many
    // requests" response here would itself confirm the ID is real.
    return res.json({ ok: true, message: FORGOT_PIN_GENERIC_MESSAGE });
  }
  recordFailure(forgotAttempts, key, FORGOT_MAX_ATTEMPTS, FORGOT_LOCK_DURATION_MS);

  const user = db.findTechnician(id);
  if (user && user.employment_status === "active" && user.email) {
    const token = db.createPasswordReset(user.id);
    const link = `${PUBLIC_BASE_URL}/?resetToken=${token}`;
    try {
      await mailer.sendMail({
        to: user.email,
        subject: "Reset your ServiceWorks PIN",
        text: `Hi ${user.name},\n\nSomeone requested a PIN reset for your ServiceWorks account (${user.id}). If this was you, set a new PIN here:\n\n${link}\n\nThis link expires in 30 minutes and only works once. If you didn't request this, you can ignore this email -- your PIN hasn't changed.`,
      });
      db.addAudit(user.id, "PIN_RESET_REQUESTED", `${user.name} requested a PIN reset email`);
    } catch (err) {
      // Never surface a delivery failure to the caller -- same reasoning
      // as the generic response below: the difference between "no email
      // on file" and "email on file but SMTP failed" isn't this endpoint's
      // to reveal. Logged server-side so a real outage is still visible.
      console.error(`[auth] Failed to send PIN reset email to ${user.email}:`, err.message);
    }
  }

  res.json({ ok: true, message: FORGOT_PIN_GENERIC_MESSAGE });
});

router.post("/reset-pin", (req, res) => {
  const { token, pin } = req.body || {};
  if (!token || !pin) return res.status(400).json({ error: "token and pin are required" });
  const pinError = pinStrengthError(pin);
  if (pinError) return res.status(400).json({ error: pinError });

  const techId = db.consumePasswordReset(token);
  if (!techId) {
    return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  }

  const user = db.setTechnicianPin(techId, pin);
  db.addAudit(techId, "PIN_RESET_VIA_EMAIL", `${user.name} reset their own PIN via an emailed link`);
  res.json({ ok: true });
});

module.exports = router;
