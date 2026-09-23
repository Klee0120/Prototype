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

// The hash above is one-way by design for login -- but this is a 4-digit
// PIN, not a real password, and admin needs to be able to read a
// technician's own PIN back to them when they call in having forgotten it.
// So alongside the hash, keep a separately-encrypted (reversible) copy an
// admin can decrypt on demand. Set LABOR_PIN_ENCRYPTION_KEY in production;
// this fallback only exists so the app runs out of the box in dev/test.
const PIN_ENCRYPTION_KEY = crypto.scryptSync(
  process.env.LABOR_PIN_ENCRYPTION_KEY || "labor-allocation-default-pin-key",
  "labor-pin-salt",
  32
);

function encryptPin(pin) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", PIN_ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(pin), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

function decryptPin(stored) {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", PIN_ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

module.exports = { hashPin, verifyPin, encryptPin, decryptPin };
