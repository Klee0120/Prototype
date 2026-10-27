const test = require("node:test");
const assert = require("node:assert/strict");

const encryptionPath = require.resolve("../server/utils/fileEncryption");

// fileEncryption.js reads FILE_ENCRYPTION_KEY into a module-level const
// once, at require time -- same reasoning as aiSummarizer.test.js's
// freshSummarizer(): these tests toggle that env between cases, so each
// one clears the require cache and re-requires fresh.
function freshFileEncryption() {
  delete require.cache[encryptionPath];
  return require(encryptionPath);
}

const VALID_KEY = "b".repeat(64);

test("fileEncryption: isConfigured() reflects whether FILE_ENCRYPTION_KEY is set", (t) => {
  delete process.env.FILE_ENCRYPTION_KEY;
  const notConfigured = freshFileEncryption();
  t.after(() => delete require.cache[encryptionPath]);
  assert.equal(notConfigured.isConfigured(), false);

  process.env.FILE_ENCRYPTION_KEY = VALID_KEY;
  t.after(() => delete process.env.FILE_ENCRYPTION_KEY);
  const configured = freshFileEncryption();
  assert.equal(configured.isConfigured(), true);
});

test("fileEncryption: a malformed (wrong-length) key throws at require time rather than silently truncating", (t) => {
  process.env.FILE_ENCRYPTION_KEY = "tooshort";
  t.after(() => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete require.cache[encryptionPath];
  });
  assert.throws(() => freshFileEncryption(), /64-character hex string/);
});

test("fileEncryption: encryptBuffer throws when not configured", (t) => {
  delete process.env.FILE_ENCRYPTION_KEY;
  const fe = freshFileEncryption();
  t.after(() => delete require.cache[encryptionPath]);
  assert.throws(() => fe.encryptBuffer(Buffer.from("x")), /not configured/);
});

test("fileEncryption: round-trips a buffer exactly, and the ciphertext never contains the plaintext", (t) => {
  process.env.FILE_ENCRYPTION_KEY = VALID_KEY;
  const fe = freshFileEncryption();
  t.after(() => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete require.cache[encryptionPath];
  });

  const plaintext = Buffer.from("ACH routing 123456789, account 987654321");
  const encrypted = fe.encryptBuffer(plaintext);
  assert.ok(encrypted.subarray(0, fe.MAGIC.length).equals(fe.MAGIC));
  assert.ok(!encrypted.includes("routing"), "ciphertext must not contain recognizable plaintext");
  assert.ok(!encrypted.includes("987654321"), "ciphertext must not contain recognizable plaintext");

  const decrypted = fe.decryptBuffer(encrypted);
  assert.ok(decrypted.equals(plaintext));
});

test("fileEncryption: two encryptions of the same plaintext produce different ciphertext (random IV per call)", (t) => {
  process.env.FILE_ENCRYPTION_KEY = VALID_KEY;
  const fe = freshFileEncryption();
  t.after(() => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete require.cache[encryptionPath];
  });

  const plaintext = Buffer.from("same content both times");
  const a = fe.encryptBuffer(plaintext);
  const b = fe.encryptBuffer(plaintext);
  assert.ok(!a.equals(b));
  assert.ok(fe.decryptBuffer(a).equals(plaintext));
  assert.ok(fe.decryptBuffer(b).equals(plaintext));
});

test("fileEncryption: decryptBuffer passes a legacy-plaintext buffer through unchanged, no key needed", (t) => {
  delete process.env.FILE_ENCRYPTION_KEY;
  const fe = freshFileEncryption();
  t.after(() => delete require.cache[encryptionPath]);

  const legacy = Buffer.from("a file written before encryption shipped");
  assert.ok(fe.decryptBuffer(legacy).equals(legacy));
});

test("fileEncryption: decryptBuffer throws (never returns corrupted bytes) on a tampered ciphertext", (t) => {
  process.env.FILE_ENCRYPTION_KEY = VALID_KEY;
  const fe = freshFileEncryption();
  t.after(() => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete require.cache[encryptionPath];
  });

  const encrypted = fe.encryptBuffer(Buffer.from("sensitive bank details"));
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => fe.decryptBuffer(tampered));
});

test("fileEncryption: decrypting an encrypted buffer with the wrong key throws", (t) => {
  process.env.FILE_ENCRYPTION_KEY = VALID_KEY;
  const fe = freshFileEncryption();
  const encrypted = fe.encryptBuffer(Buffer.from("secret"));

  process.env.FILE_ENCRYPTION_KEY = "c".repeat(64);
  const feWrongKey = freshFileEncryption();
  t.after(() => {
    delete process.env.FILE_ENCRYPTION_KEY;
    delete require.cache[encryptionPath];
  });
  assert.throws(() => feWrongKey.decryptBuffer(encrypted));
});
