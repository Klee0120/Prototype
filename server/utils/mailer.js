const nodemailer = require("nodemailer");

// Real email delivery is opt-in via environment variables -- if they aren't
// set, sendMail logs what it would have sent and returns without error,
// rather than pretending to deliver something it can't. This keeps
// dev/test/demo environments (and any deployment where email was never
// configured) working exactly as before, with no crash and no silent lie.
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function isConfigured() {
  return Boolean(transporter);
}

async function sendMail({ to, subject, text }) {
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured -- would have emailed ${to}: "${subject}"`);
    return { sent: false, reason: "SMTP not configured" };
  }
  await transporter.sendMail({ from: SMTP_FROM, to, subject, text });
  return { sent: true };
}

module.exports = { isConfigured, sendMail };
