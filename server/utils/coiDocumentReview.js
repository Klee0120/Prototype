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

// Parses a dollar figure in either the matrix's own shorthand ("$1M",
// "$4M") or the extractor's full form ("$1,000,000") into a plain number,
// so a scanned guess can be compared against a vendor's required minimum.
// Returns null for anything that isn't a recognizable dollar figure
// (never throws) -- callers treat null as "can't compare," not as zero.
function parseDollarAmount(value) {
  const str = String(value || "").trim();
  const millionMatch = str.match(/^\$?\s*(\d+(?:\.\d+)?)\s*M$/i);
  if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000);
  const plainMatch = str.match(/^\$?\s*([\d,]+)$/);
  if (plainMatch) return Number(plainMatch[1].replace(/,/g, ""));
  return null;
}

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
// twice under different wording. coverageLimitGuesses (from
// extractCoiCoverageLimitGuesses, keyed by the plain COVERAGE_COLUMNS key
// -- "glOcc", not the composite "glOcc:$1,000,000" item key below, since
// the guess is about the coverage TYPE scanned off the document,
// independent of what any given vendor's own requirement happens to be)
// rides along on each coverage-limit item as extractedGuess. The 4
// universal items never get this field at all -- callers check
// `"extractedGuess" in item`, not truthiness, to tell a coverage-limit
// item apart from a universal one.
async function buildCoiRequirementChecklist(vendorServicesRaw, coverageLimitGuesses = {}) {
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
      const guess = coverageLimitGuesses[key] || null;
      const requiredAmount = parseDollarAmount(value);
      const guessAmount = parseDollarAmount(guess);
      items.push({
        key: itemKey,
        label: `${label} meets ${value} minimum`,
        extractedGuess: guess,
        // null when either side can't be parsed as a dollar figure (no
        // guess found, or an unrecognized format) -- "can't compare," not
        // a silent false. Still just what the SCAN says against the
        // requirement -- never auto-applied to approval, same as the
        // guess itself (see extractCoiCoverageLimitGuesses's own comment).
        meetsRequirement: requiredAmount != null && guessAmount != null ? guessAmount >= requiredAmount : null,
      });
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
// Takes the PDF's raw bytes directly (a Buffer), not a file path -- see
// poDocument.js's extractPoVendorInfo for the same convention and why
// (transparent encryption at rest via db.readUploadBytes).
async function extractCoiDocumentText(buffer) {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL })
      .promise;
    const pageTexts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // pdfjs marks each text run's own line end via hasEOL -- without
      // this, every run on a page joins into one flat space-separated
      // blob with no row boundaries at all, which both reads worse for
      // the admin's own "what we could read off the document" pane and
      // starves extractCoiStructuredFields of any way to tell where an
      // ACORD field (INSURED's name/address, say) actually ends.
      pageTexts.push(content.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join(""));
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

// Best-effort suggestions for three low-stakes metadata fields -- unlike
// coverage limits or the Auto Liability checkboxes (see this file's header
// comment), getting one of these wrong never leads to approving
// insufficient coverage: it's just a starting guess the admin edits or
// clears in the review modal before it's ever saved as fact (see
// syncCoiCaseFromReview in db.js, which only persists whatever value the
// admin actually submits). pdfjs-dist flattens a page's text into reading
// order with no table/column structure, so an ACORD 25's multi-row
// coverage grid (one POLICY NUMBER/EXP per line of business) can't be
// parsed reliably -- this just grabs the first match of each pattern,
// which in practice is almost always the General Liability row, the one
// that normally also carries the vendor's primary/earliest-relevant
// expiration.
const POLICY_TOKEN_STOPWORDS = /^(POLICY|NUMBER|EFF|EXP|DATE|MM|DD|YYYY|LIMITS|TYPE|INSURANCE|OF)$/i;

function extractCoiStructuredFields(extractedText) {
  const text = String(extractedText || "");
  const result = { policyNumber: null, carrier: null, expirationDate: null, insuredName: null, insuredAddress: null };
  if (!text.trim()) return result;

  // An ACORD 25 coverage row flattens to "<policy #> <eff date> <exp
  // date>" in reading order even though the column headers that label
  // them sit on an earlier, separate line -- so this looks for that
  // specific 3-token shape rather than trying to anchor off the "POLICY
  // NUMBER"/"POLICY EXP" header text itself, which in a flattened read is
  // nowhere near the actual values it labels.
  const rowMatch = text.match(/([A-Za-z0-9][A-Za-z0-9\-\/]{3,24})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (rowMatch) {
    if (/\d/.test(rowMatch[1]) && !POLICY_TOKEN_STOPWORDS.test(rowMatch[1])) result.policyNumber = rowMatch[1];
    const iso = mmddyyyyToIso(rowMatch[3]);
    if (iso) result.expirationDate = iso;
  }

  const carrierMatch = text.match(/INSURER\s*A\s*:?\s*([A-Za-z][A-Za-z0-9&.,'\-\s]{2,60}?)(?=\s+NAIC|\s+INSURER\s*B|\s+\d{3,}|\s{2,}|$)/i);
  if (carrierMatch) {
    const carrier = carrierMatch[1].replace(/\s+/g, " ").trim();
    if (carrier) result.carrier = carrier;
  }

  // The ACORD 25's "INSURED" box names the vendor itself, with its
  // mailing address directly beneath -- never "ADDITIONAL INSURED"
  // (that's C&W/Toyota's own box, naming them, not the vendor). Weaker
  // than the other three fields: a two-column Producer/Insured layout can
  // flatten in either order depending on the PDF generator, so this
  // misses often. That's fine here -- unlike policyNumber/carrier/
  // expirationDate (which land on a real case once confirmed), these two
  // are only ever a prefill for the vendor picker's search box and its
  // "create a new vendor" quick-add form; a miss just leaves those boxes
  // blank, same as before this existed. Name and address are split on the
  // first token that looks like a street number -- "Acme LLC 123 Main
  // St" becomes name "Acme LLC", address "123 Main St" -- since a company
  // name essentially never itself starts with digits.
  const insuredBlockMatch = text.match(
    /(?<!ADDITIONAL\s)\bINSURED\b\s*:?\s*([A-Z][^\n]{2,160}?)(?=\s+(?:CERTIFICATE|REVISION|COVERAGES?|PRODUCER|CONTACT|INSURER|THIS)\b|\n|$)/
  );
  if (insuredBlockMatch) {
    const block = insuredBlockMatch[1].replace(/\s+/g, " ").trim();
    const tokens = block.split(" ");
    const splitIdx = tokens.findIndex((t) => /^\d/.test(t));
    if (splitIdx > 0) {
      result.insuredName = tokens.slice(0, splitIdx).join(" ");
      result.insuredAddress = tokens.slice(splitIdx).join(" ");
    } else if (splitIdx === -1 && block) {
      result.insuredName = block;
    }
  }

  return result;
}

// Best-effort guesses at the vendor's actual coverage dollar limits off
// the document text -- same "prefill only, never trusted" spirit as
// extractCoiStructuredFields above (see its own header comment for why a
// flattened ACORD 25 can't be parsed reliably: no table/column structure
// survives the flatten, so a coverage figure found here can easily belong
// to a neighboring, unrelated line of business rather than the one it
// looks like it's near). Unlike extractCoiStructuredFields (a prefill
// shown to the admin), this is surfaced to the VENDOR as "is this your
// actual limit?" -- see buildCoiRequirementChecklist's own comment on how
// it threads through. Never auto-applied either way. A scanned/flat-image
// document with no text layer returns every key null, same as every other
// extraction in this file.
const COVERAGE_LABEL_PATTERNS = {
  glOcc: /each\s*occurrence/i,
  glAgg: /general\s*aggregate/i,
  auto: /automobile\s*liab|auto\s*liab/i,
  wc: /workers.{0,3}compensation|e\.?l\.?\s*each\s*accident/i,
  exs: /umbrella\s*liab|excess\s*liab/i,
  eAndO: /errors\s*(?:&|and)\s*omissions|professional\s*liab/i,
  pol: /pollution/i,
  crime: /\bcrime\b/i,
  productsComplOpAgg: /products\s*[-/]?\s*comp(?:leted)?\s*op/i,
};

// How far past a coverage label's own match to look for a dollar figure --
// generous enough to span a short run of header/box-drawing text between
// the label and its value in a flattened read, tight enough that it
// shouldn't usually reach all the way into an unrelated coverage line. A
// NAIC code, policy number, or neighboring coverage's own figure sitting
// inside that window is a real, accepted risk -- see this function's own
// header comment -- not something worth a cleverer heuristic for, since
// the vendor confirming or correcting the guess is what actually matters.
const COVERAGE_AMOUNT_WINDOW = 60;
const COVERAGE_AMOUNT_RE = /\$?\s*(\d{1,3}(?:,\d{3})+|\d{5,9})\b/;

function extractCoiCoverageLimitGuesses(extractedText) {
  const guesses = {};
  for (const key of Object.keys(COVERAGE_LABEL_PATTERNS)) guesses[key] = null;
  const text = normalizeWhitespace(extractedText);
  if (!text) return guesses;

  for (const [key, labelPattern] of Object.entries(COVERAGE_LABEL_PATTERNS)) {
    const labelMatch = text.match(labelPattern);
    if (!labelMatch) continue;
    const windowStart = labelMatch.index + labelMatch[0].length;
    const window = text.slice(windowStart, windowStart + COVERAGE_AMOUNT_WINDOW);
    const amountMatch = window.match(COVERAGE_AMOUNT_RE);
    if (amountMatch) guesses[key] = `$${amountMatch[1]}`;
  }
  return guesses;
}

function mmddyyyyToIso(dateStr) {
  const parts = String(dateStr).split("/");
  if (parts.length !== 3) return null;
  let [month, day, year] = parts;
  if (year.length === 2) year = `20${year}`;
  const m = Number(month);
  const d = Number(day);
  const y = Number(year);
  if (!m || !d || !y || m > 12 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
  extractCoiStructuredFields,
  extractCoiCoverageLimitGuesses,
  coiDenialEmailText,
};
