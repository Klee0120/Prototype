
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

// attachments entries carry {filename, buffer} -- the caller (server/routes/tasks.js's
// one call site, attaching a PO document) is responsible for getting those
// bytes itself (via db.readUploadBytes, so encryption at rest stays
// transparent to this module), since mailer.js has no business knowing
// where an upload lives on disk. Translated here into what SendGrid's API
// actually wants: the bytes, base64-encoded inline.
function buildAttachment({ filename, buffer }) {
  return {
    filename,
    content: buffer.toString("base64"),
  };
}

// cc is optional -- a single address or an array of them. Kept additive
// (every existing call site passes no cc at all and is unaffected) since
// the one caller that needs it (the vendor-portal invoice-to-AP email)
// resolves its own cc dynamically per PO rather than always sending to the
// same fixed address.
async function sendMail({ to, cc, subject, text, attachments }) {
  if (!isConfigured()) {
    console.warn(`[mailer] SendGrid not configured -- would have emailed ${to}: "${subject}"`);
    return { sent: false, reason: "SendGrid not configured" };
  }

  const personalization = { to: [{ email: to }] };
  if (cc) {
    const ccList = Array.isArray(cc) ? cc : [cc];
    if (ccList.length > 0) personalization.cc = ccList.map((email) => ({ email }));
  }
  const body = {
    personalizations: [personalization],
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
