// Encryption at rest for every uploaded file (COI/W-9/ACH/correspondence
// attachments/etc.) -- see README's "encryption at rest" note for why this
// exists: ACH forms carry real bank account/routing numbers, and files
// otherwise sit as plain files on disk. AES-256-GCM via Node's built-in
// crypto, same "no new dependency" approach server/utils/password.js
// already takes for passcode hashing.
//
// Each encrypted file is self-contained -- [MAGIC][IV][authTag][ciphertext]
// -- so the key alone decrypts it, no separate per-file metadata needed in
// the database. decryptBuffer treats anything not starting with MAGIC as
// legacy plaintext and returns it unchanged, which is what lets files
// written before this shipped (and before scripts/encrypt-existing-uploads.js
// runs against them) keep working with zero special-casing at every call
// site -- the chokepoint (db.js's readUploadBytes) is the only place that
// needs to know this duality exists.
const crypto = require("crypto");

// 8 bytes -- at that length the odds of a legacy plaintext file
// coincidentally starting with this exact sequence are ~1-in-2^64, and even
// in that freak case GCM's own auth-tag check in decipher.final() throws on
// a bad key/corrupt ciphertext rather than returning garbage, so a false
// "looks encrypted" match fails loudly instead of silently.
const MAGIC = Buffer.from("SWFENC01", "utf8");
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";

const rawKey = process.env.FILE_ENCRYPTION_KEY || "";
let key = null;
if (rawKey) {
  const decoded = Buffer.from(rawKey, "hex");
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(`FILE_ENCRYPTION_KEY must be a ${KEY_LENGTH * 2}-character hex string (${KEY_LENGTH} bytes) -- got ${decoded.length} bytes`);
  }
  key = decoded;
}

function isConfigured() {
  return key !== null;
}

function encryptBuffer(buffer) {
  if (!key) throw new Error("FILE_ENCRYPTION_KEY is not configured -- cannot encrypt");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, authTag, ciphertext]);
}

// Legacy-plaintext passthrough: a buffer not starting with MAGIC is assumed
// to be a file written before this shipped, and is returned unchanged --
// no key needed for that path. A buffer that DOES start with MAGIC requires
// a configured key; a bad key or tampered/corrupted ciphertext throws
// (via decipher.final()'s own auth-tag check) rather than returning
// corrupted bytes -- never worth silently handing back a broken bank
// document.
function decryptBuffer(buffer) {
  if (buffer.length < MAGIC.length || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    return buffer;
  }
  if (!key) throw new Error("FILE_ENCRYPTION_KEY is not configured -- cannot decrypt an encrypted file");
  let offset = MAGIC.length;
  const iv = buffer.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = buffer.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = buffer.subarray(offset);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { isConfigured, encryptBuffer, decryptBuffer, MAGIC };
