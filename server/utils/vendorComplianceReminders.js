// Automates the "chasing" half of COI/W-9/ACH renewal: finds every
// vendor whose document is already expired or expiring soon, emails
// them once (at most every `cadenceDays`, see db.listVendorsNeeding-
// ComplianceReminder), and logs it. This is deliberately just the
// outbound-nudge piece -- it does not read, extract, or validate
// anything a vendor sends back; that's a separate, higher-risk project
// (matching the inbound document to this vendor and checking it against
// the COI matrix) to build and test against real documents before
// trusting it to act automatically.
const db = require("../data/db");
const mailer = require("./mailer");

const CATEGORY_LABELS = { coi: "Certificate of Insurance (COI)", w9: "W-9", ach: "ACH / banking details" };

function formatDate(isoDate) {
  // expires_at is stored as a plain YYYY-MM-DD date, not a timestamp --
  // parsing it as UTC and formatting in UTC keeps the displayed date from
  // shifting a day depending on the server's local timezone.
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC" });
}

function describeItem(item) {
  const label = CATEGORY_LABELS[item.category] || item.category;
  return item.status === "expired" ? `${label}: expired ${formatDate(item.expiresAt)}` : `${label}: expires ${formatDate(item.expiresAt)}`;
}

function emailTextFor(vendor) {
  const lines = vendor.items.map((item) => `- ${describeItem(item)}`).join("\n");
  return (
    `Hi ${vendor.name},\n\n` +
    `The following document${vendor.items.length === 1 ? " needs" : "s need"} your attention to stay current with us:\n\n` +
    `${lines}\n\n` +
    `Please send an updated copy at your earliest convenience.\n\n` +
    `(This is an automated reminder -- you'll get one about once a week until it's renewed.)\n`
  );
}

// Finds every vendor due a reminder right now, emails each one, and
// records it so the same vendor isn't re-emailed before the cadence
// window is up. Returns a summary rather than throwing on a single
// vendor's failure, so one bad email address doesn't stop the rest of
// the run -- same "don't let one failure sink the batch" shape as
// runSmartsheetSync.
async function sendVendorComplianceReminders({ daysAhead = 30, cadenceDays = 7 } = {}) {
  const vendors = db.listVendorsNeedingComplianceReminder({ daysAhead, cadenceDays });
  let emailed = 0;
  const failures = [];

  for (const vendor of vendors) {
    try {
      const result = await mailer.sendMail({
        to: vendor.email,
        subject: "Action needed: document renewal",
        text: emailTextFor(vendor),
      });
      db.recordVendorComplianceReminderSent(vendor.id);
      db.addAudit(
        "scheduled",
        "VENDOR_COMPLIANCE_REMINDER_SENT",
        `Automated reminder sent to ${vendor.name} (${vendor.email}) for ${vendor.items.map((i) => CATEGORY_LABELS[i.category] || i.category).join(", ")}` +
          (result.sent ? "" : " (SMTP not configured -- not actually delivered)")
      );
      emailed += 1;
    } catch (err) {
      failures.push({ vendorId: vendor.id, vendorName: vendor.name, error: err.message });
    }
  }

  return { checked: vendors.length, emailed, failures };
}

module.exports = { sendVendorComplianceReminders, emailTextFor, CATEGORY_LABELS };
