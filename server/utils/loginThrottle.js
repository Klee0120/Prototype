// In-memory login throttling, shared by every login-style endpoint
// (technician/admin PIN login, the "forgot PIN" email request, and the
// vendor portal login below) -- extracted from server/routes/auth.js's
// original per-endpoint Maps so a new login surface doesn't have to
// reimplement the same lockout shape. Process-local (resets on restart),
// fine for a single-process deployment.
function createLoginThrottle(maxAttempts, lockDurationMs) {
  const attempts = new Map();

  function isLocked(key) {
    const entry = attempts.get(key);
    return Boolean(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
  }

  function recordFailure(key) {
    const entry = attempts.get(key) || { count: 0, lockedUntil: null };
    entry.count += 1;
    if (entry.count >= maxAttempts) {
      entry.lockedUntil = Date.now() + lockDurationMs;
      entry.count = 0;
    }
    attempts.set(key, entry);
  }

  function clearFailures(key) {
    attempts.delete(key);
  }

  return { isLocked, recordFailure, clearFailures };
}

module.exports = { createLoginThrottle };
