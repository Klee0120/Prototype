const db = require("../data/db");
const { AP_INVOICE_EMAIL, AP_INVOICE_REQUIREMENTS } = require("./apContacts");

// Pure, synchronously-testable -- no db writes, no network. Builds the
// email the vendor portal's invoice-submission route (POST /pos/:id/
// invoices) actually sends to AP. Deliberately auto-fills everything the
// app already knows (PO #, job location, who placed the order, the
// vendor's own contact info) directly into the body, rather than trying to
// read/validate the uploaded PDF's own content -- this app has no reliable
// way to do that for an arbitrary vendor-supplied PDF (see the two existing
// PDF text extractors, both narrow/template-dependent), so the email text
// itself is what guarantees AP gets everything the real "Submitting
// Invoice(s) for Payment" policy requires, even if the vendor's own PDF is
// missing some of it.
//
// `po` is a *presented* PO row (db.findPo's camelCase shape, which already
// carries `territory`) -- not the raw pos table row.
function buildApInvoiceEmail(po, vendor, invoiceNumber) {
  const cc = [];
  // Whoever actually owns this PO (see db.resolvePoResponsibleAdmin) -- not
  // a single hardcoded address. Per Krista: cc'ing her on every invoice is
  // an artifact of today's all-manual process, not a rule that should
  // survive automation; this generalizes it to whichever admin's territory
  // this PO actually falls under.
  const responsibleAdmin = db.resolvePoResponsibleAdmin(po);
  if (responsibleAdmin && responsibleAdmin.email) cc.push(responsibleAdmin.email);
  // An opt-in, reversible safety net for rollout -- aim it at a real inbox
  // (or leave it unset) without a code change.
  if (process.env.VENDOR_INVOICE_AP_SAFETY_CC) cc.push(process.env.VENDOR_INVOICE_AP_SAFETY_CC);

  const vendorContact = [vendor.phone, vendor.email || vendor.poEmail].filter(Boolean).join(" / ") || "n/a";

  const text = [
    `Invoice submitted via the C&W Services vendor portal.`,
    ``,
    `Purchase Order Number: ${po.poNumber || "n/a"}`,
    `Location: ${po.locationName || po.locationCode || "n/a"}`,
    `Placed by: ${po.requestor || po.adminName || "n/a"}`,
    `Vendor: ${vendor.name}`,
    `Vendor contact: ${vendorContact}`,
    `Invoice #: ${invoiceNumber}`,
    ``,
    `Reminder -- to ensure accurate processing, this invoice should include:`,
    ...AP_INVOICE_REQUIREMENTS.map((r) => `- ${r}`),
  ].join("\n");

  return {
    to: AP_INVOICE_EMAIL,
    cc: cc.length > 0 ? cc : undefined,
    subject: `Invoice submitted -- PO ${po.poNumber || po.id}`,
    text,
  };
}

module.exports = { buildApInvoiceEmail };
