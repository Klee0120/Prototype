const fs = require("fs");

// Real email delivery is opt-in via an environment variable -- if it isn't
// set, sendMail logs what it would have sent and returns without error,
// rather than pretending to deliver something it can't. This keeps
// dev/test/demo environments (and any deployment where email was never
// configured) working exactly as before, with no crash and no silent lie.
//
// Sends over SendGrid's HTTP API (plain `fetch`, same pattern
// server/utils/smartsheet.js already uses for its own outbound calls),
// not raw SMTP -- confirmed live that this droplet's host (DigitalOcean)
// blocks outbound SMTP ports (25/465/587) by default as an anti-spam
// measure, the same way most cloud hosts do, while ordinary outbound
// HTTPS (443, what this call makes) is unrestricted and already proven
// to work via that same Smartsheet sync.
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM;
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

function isConfigured() {
  return Boolean(SENDGRID_API_KEY && SENDGRID_FROM);
}

// attachments entries use nodemailer's old {filename, path} shape (see
// server/routes/tasks.js's one call site that attaches a PO document) --
// kept as-is rather than changing every caller, just translated here into
// what SendGrid's API actually wants: the file's own bytes, base64-encoded
// inline, since SendGrid has no access to this server's filesystem to
// read a path itself.
function buildAttachment({ filename, path }) {
  return {
    filename,
    content: fs.readFileSync(path).toString("base64"),
  };
}

async function sendMail({ to, subject, text, attachments }) {
  if (!isConfigured()) {
    console.warn(`[mailer] SendGrid not configured -- would have emailed ${to}: "${subject}"`);
    return { sent: false, reason: "SendGrid not configured" };
  }

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: SENDGRID_FROM },
    subject,
    content: [{ type: "text/plain", value: text }],
  };
  if (attachments && attachments.length > 0) {
    body.attachments = attachments.map(buildAttachment);
  }

  const res = await fetch(SENDGRID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`SendGrid responded ${res.status}: ${errText}`);
  }
  return { sent: true };
}

module.exports = { isConfigured, sendMail };
