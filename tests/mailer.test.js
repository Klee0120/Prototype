const test = require("node:test");
const assert = require("node:assert/strict");

const mailerPath = require.resolve("../server/utils/mailer");

// mailer.js reads SENDGRID_API_KEY/SENDGRID_FROM into module-level consts
// once, at require time -- these tests toggle that env between cases, so
// each one clears the require cache and re-requires fresh rather than
// reusing one shared module instance that could never see a later env
// change.
function freshMailer() {
  delete require.cache[mailerPath];
  return require(mailerPath);
}

test("mailer: no-op (not a crash or a silent lie) when SendGrid isn't configured", async (t) => {
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_FROM;
  const mailer = freshMailer();
  t.after(() => delete require.cache[mailerPath]);

  assert.equal(mailer.isConfigured(), false);

  const result = await mailer.sendMail({ to: "someone@example.com", subject: "Test", text: "Test body" });
  assert.equal(result.sent, false);
  assert.ok(result.reason);
});

// Sends over SendGrid's HTTP API (plain fetch), not SMTP -- confirmed live
// that the droplet's host blocks outbound SMTP ports by default, while
// ordinary outbound HTTPS (what this call makes) already works. See
// mailer.js's own comment for the full story.
test("mailer: sends via SendGrid's HTTP API when configured", async (t) => {
  process.env.SENDGRID_API_KEY = "test-key";
  process.env.SENDGRID_FROM = "serviceworks.noreply@example.com";
  const mailer = freshMailer();
  t.after(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM;
    delete require.cache[mailerPath];
  });

  assert.equal(mailer.isConfigured(), true);

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 202, text: async () => "" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await mailer.sendMail({ to: "someone@example.com", subject: "Test subject", text: "Test body" });
  assert.equal(result.sent, true);
  assert.equal(capturedUrl, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers.Authorization, "Bearer test-key");

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.from.email, "serviceworks.noreply@example.com");
  assert.equal(body.personalizations[0].to[0].email, "someone@example.com");
  assert.equal(body.subject, "Test subject");
  assert.equal(body.content[0].value, "Test body");
});

test("mailer: translates a {filename, buffer} attachment into SendGrid's base64 shape", async (t) => {
  process.env.SENDGRID_API_KEY = "test-key";
  process.env.SENDGRID_FROM = "serviceworks.noreply@example.com";
  const mailer = freshMailer();
  t.after(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM;
    delete require.cache[mailerPath];
  });

  const originalFetch = global.fetch;
  let capturedOptions = null;
  global.fetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, status: 202, text: async () => "" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await mailer.sendMail({
    to: "someone@example.com",
    subject: "With attachment",
    text: "See attached",
    attachments: [{ filename: "notes.txt", buffer: Buffer.from("hello attachment") }],
  });

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, "notes.txt");
  assert.equal(Buffer.from(body.attachments[0].content, "base64").toString(), "hello attachment");
});

test("mailer: throws when SendGrid responds with an error status", async (t) => {
  process.env.SENDGRID_API_KEY = "test-key";
  process.env.SENDGRID_FROM = "serviceworks.noreply@example.com";
  const mailer = freshMailer();
  t.after(() => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_FROM;
    delete require.cache[mailerPath];
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => '{"errors":[{"message":"bad key"}]}' });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() => mailer.sendMail({ to: "someone@example.com", subject: "x", text: "y" }));
});
