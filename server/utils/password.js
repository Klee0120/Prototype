const crypto = require("crypto");

const KEYLEN = 64;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pin), salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(String(pin), salt, KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Strength policy for a PIN going forward, same as any login credential
// requires it: a plain 4-digit number is guessable fast enough that the
// 15-minute lockout (server/routes/auth.js) is doing most of the real
// work. Applies only to a PIN actually being SET (creation, admin reset,
// self-service reset) -- existing short/all-numeric PINs on file keep
// working to log in, nothing here revalidates them at login time.
const PIN_MIN_LENGTH = 8;
const PIN_SPECIAL_CHAR_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/;

function pinStrengthError(pin) {
  const value = String(pin == null ? "" : pin);
  if (value.length < PIN_MIN_LENGTH) return `PIN must be at least ${PIN_MIN_LENGTH} characters`;
  if (!PIN_SPECIAL_CHAR_RE.test(value)) return "PIN must include at least one special character";
  return null;
}

module.exports = { hashPin, verifyPin, pinStrengthError, PIN_MIN_LENGTH };
