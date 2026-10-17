// The admin-review half of the COI inbound-document workflow: given a COI
// file already attached to a vendor (uploaded by hand for now -- see
// server/utils/vendorComplianceReminders.js's own comment on why inbound
// email capture is a separate, later piece), builds the requirement
// checklist for that vendor's registered service(s) and best-effort
// extracts the document's text for an admin to read alongside it.
//
// Deliberately does NOT try to read dollar limits or auto-liability
// checkboxes off the page -- OCR/text-position heuristics are reliable
// enough for locating a fixed digital template (see poDocument.js) but not
// for a document whose values vary per vendor and may be handwritten or a
// flat scan with no text layer at all. A wrong auto-read here means
// approving a vendor with insufficient coverage, which is a worse failure
// than just asking the admin to check a box. The only things this
// auto-detects are plain substring presence checks (did the document's
// text, if any, contain this known fixed string) -- safe because a false
// negative just means "admin double-checks something that was actually
// fine," never "something gets silently approved."
const fs = require("fs");
const path = require("path");
const { REQUIRED_COI_LANGUAGE, COVERAGE_COLUMNS } = require("./onboardRequirementsPdf");

const STANDARD_FONT_DATA_URL = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;

// Fixed, vendor-independent requirements every COI needs regardless of
// service type -- these can never be auto-verified (a checkbox mark and a
// signature block aren't reliably readable off arbitrary scans), so they
// always land in front of the admin as plain checklist items.
const COI_UNIVERSAL_REQUIREMENTS = [
  { key: "acord25", label: "Provided on an ACORD 25 (2016/03) form" },
  { key: "language", label: "Required additional-insured language present and matches exactly" },
  { key: "certHolder", label: "Certificate Holder is C&W Facility Services, Inc. d/b/a C&W Services, 117 Kendrick Street, Suite 250, Needham, MA 02494" },
  { key: "autoLiabilityBoxes", label: "Auto Liability checkbox combination meets one of the 5 accepted patterns" },
];

// A vendor's services are stored as a single "|"-joined string of COI
// matrix labels (see adminReview.js's splitServices) -- mirrored here
// rather than imported, since that helper lives in a client ES module.
function splitServices(raw) {
  return (raw || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every non-"-" coverage figure across all of a vendor's registered
// services, deduped by (service, coverage) pair so a vendor with two
// services needing the same coverage doesn't get the same checklist line
// twice under different wording.
async function buildCoiRequirementChecklist(vendorServicesRaw) {
  const dataUrl = path.join(__dirname, "..", "..", "public", "js", "data", "coiMatrix.js");
  const { COI_MATRIX_BY_LABEL } = await import(`file://${dataUrl}`);

  const items = [...COI_UNIVERSAL_REQUIREMENTS];
  const seen = new Set(items.map((i) => i.key));
  for (const service of splitServices(vendorServicesRaw)) {
    const entry = COI_MATRIX_BY_LABEL[service];
    if (!entry) continue;
    for (const { key, label } of COVERAGE_COLUMNS) {
      const value = entry.requirements[key];
      if (!value || value === "-") continue;
      const itemKey = `${key}:${value}`;
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      items.push({ key: itemKey, label: `${label} meets ${value} minimum (required for ${service})` });
    }
  }
  return items;
}

// Every page's text, joined with blank lines between pages -- no OCR, so a
// scanned image or a flat photo-to-PDF conversion with no embedded text
// layer returns an empty string here, not an error. That's an expected,
// common outcome (see this file's header comment), not a failure to
// surface to the caller -- the admin still reviews the document, just
// without this reading aid.
async function extractCoiDocumentText(filePath) {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL })
      .promise;
    const pageTexts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(" "));
    }
    return pageTexts.join("\n\n").trim();
  } catch {
    // Not a readable PDF at all (corrupt, or genuinely a different file
    // type) -- same outcome as "no text found," the admin reviews the
    // actual file directly either way.
    return "";
  }
}

// Collapse whitespace before comparing so line-wrapping/extra spaces in
// the extracted text don't defeat an otherwise-exact match.
function normalizeWhitespace(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Plain substring presence hints for the admin -- never auto-checks
// anything, just flags "this known fixed string does/doesn't appear in
// what we could read," for the two universal items where that's a
// meaningful signal (the form type name, and the required language).
// Coverage limits and certificate holder/auto-liability stay unhinted --
// a dollar figure or a checkbox mark isn't a fixed string to search for.
function coiExtractionHints(extractedText) {
  const normalized = normalizeWhitespace(extractedText);
  if (!normalized) return {};
  return {
    acord25: normalized.includes("acord 25") || normalized.includes("acord25"),
    language: normalized.includes(normalizeWhitespace(REQUIRED_COI_LANGUAGE).slice(0, 60)),
  };
}

const CATEGORY_LABELS = { coi: "Certificate of Insurance (COI)", w9: "W-9", ach: "ACH / banking details" };

function coiDenialEmailText(vendorName, reasonLabels) {
  const lines = reasonLabels.map((label) => `- ${label}`).join("\n");
  return (
    `Hi ${vendorName},\n\n` +
    `The ${CATEGORY_LABELS.coi} you sent couldn't be accepted as submitted:\n\n` +
    `${lines}\n\n` +
    `Please send a corrected copy addressing the above at your earliest convenience.\n`
  );
}

module.exports = {
  COI_UNIVERSAL_REQUIREMENTS,
  buildCoiRequirementChecklist,
  extractCoiDocumentText,
  coiExtractionHints,
  coiDenialEmailText,
};
