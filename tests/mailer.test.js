const test = require("node:test");
const assert = require("node:assert/strict");
const mailer = require("../server/utils/mailer");

test("mailer: no-op (not a crash or a silent lie) when SMTP isn't configured", async () => {
  // The test environment never sets SMTP_HOST/SMTP_USER/SMTP_PASS, so this
  // exercises the same "not configured" path a real deployment hits before
  // an admin sets those env vars.
  assert.equal(mailer.isConfigured(), false);

  const result = await mailer.sendMail({ to: "someone@example.com", subject: "Test", text: "Test body" });
  assert.equal(result.sent, false);
  assert.ok(result.reason);
});
