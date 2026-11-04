// C&W Services AP's real "Submitting Invoice(s) for Payment" policy --
// the single source of truth for the two addresses and the bill-to/
// requirements text, so the vendor-portal invoice email (see
// server/utils/vendorInvoiceEmail.js) and anywhere else that needs to
// quote this policy don't each keep their own, independently drifting
// copy. public/js/views/techHome.js already shows a short static version
// of this to technicians directly in HTML (no live wiring possible there
// without a network round-trip for plain copy) -- this module is the
// source of truth for every server-side use.
const AP_INVOICE_EMAIL = "ap.amer@cwservices.com";
const AP_PAYMENT_STATUS_EMAIL = "apsupport.amer@cwservices.com";
const AP_BILL_TO_ADDRESS = "C&W FACILITY SERVICES INC, 117 Kendrick Street, Suite 250, Needham, MA 02494";

const AP_INVOICE_REQUIREMENTS = [
  "Purchase Order Number",
  "PDF Format Only",
  `Bill to: ${AP_BILL_TO_ADDRESS}`,
  "Identification of the location where materials were delivered, or service was performed.",
  "The name of the C&W Services team member who placed the order.",
  "Supplier's contact information",
];

module.exports = {
  AP_INVOICE_EMAIL,
  AP_PAYMENT_STATUS_EMAIL,
  AP_BILL_TO_ADDRESS,
  AP_INVOICE_REQUIREMENTS,
};
