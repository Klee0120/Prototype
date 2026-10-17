const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPin, verifyPin, pinStrengthError, PIN_MIN_LENGTH } = require("../server/utils/password");

test("password: hashPin/verifyPin round-trip, never stores the raw PIN", () => {
  const stored = hashPin("Whatever1!");
  assert.ok(!stored.includes("Whatever1!"), "the raw PIN should never appear in the stored hash");
  assert.ok(verifyPin("Whatever1!", stored));
  assert.ok(!verifyPin("WrongGuess1!", stored));
});

test("password: pinStrengthError enforces minimum length and a special character", () => {
  assert.equal(PIN_MIN_LENGTH, 8);

  assert.match(pinStrengthError("Ab1!"), /at least 8 characters/i);
  assert.match(pinStrengthError(""), /at least 8 characters/i);
  assert.equal(pinStrengthError(null), pinStrengthError(""), "a missing PIN is just the empty-string case");

  assert.match(pinStrengthError("LongEnoughButPlain"), /special character/i);

  assert.equal(pinStrengthError("Compliant1!"), null);
  const eightChars = `${"a".repeat(7)}!`;
  const sevenChars = `${"a".repeat(6)}!`;
  assert.equal(eightChars.length, 8);
  assert.equal(sevenChars.length, 7);
  assert.equal(pinStrengthError(eightChars), null, "8 characters plus a special char meets the floor");
  assert.match(pinStrengthError(sevenChars), /at least 8 characters/i, "7 characters is one short of the floor, even with a special char");
});

test("password: a variety of special characters all satisfy the policy", () => {
  for (const special of ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "-", "_", "=", "+", ".", ",", "?"]) {
    assert.equal(pinStrengthError(`password${special}`), null, `"${special}" should count as a special character`);
  }
});
