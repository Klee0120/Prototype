// Reads the vendor number and vendor email straight out of a generated C&W
// Purchase Order PDF's own text layer -- no OCR, no AI: every PO this
// system generates is a fixed digital template (confirmed against several
// real examples, including a change order) that always places the
// vendor's "Vendor ID: <number>" line in the same spot, with the vendor's
// own "E: <email>" line directly above it in the same column -- distinct
// from the buyer's and the ship-to contact's email, which sit in a
// different column entirely. This only works because the PO is a real
// digital document with embedded text, not a scanned image.

const VENDOR_ID_RE = /Vendor ID:\s*(\S+)/;
const EMAIL_RE = /^E:\s*(\S+@\S+)/;
// How close (in PDF points) the vendor's email line is allowed to sit
// above the Vendor ID line and still count as "the same block" -- observed
// gap across every real sample was ~25pt; this leaves slack for minor
// template drift without reaching far enough to catch an unrelated line.
const MAX_BLOCK_GAP_PT = 60;
const SAME_COLUMN_TOLERANCE_PT = 5;

const path = require("path");
const STANDARD_FONT_DATA_URL = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;

async function extractPoVendorInfo(filePath) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fs = require("fs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, standardFontDataUrl: STANDARD_FONT_DATA_URL })
    .promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();

  const items = content.items.map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }));
  const vendorIdItem = items.find((i) => VENDOR_ID_RE.test(i.str));
  if (!vendorIdItem) return null;
  const vendorNumber = vendorIdItem.str.match(VENDOR_ID_RE)[1];

  let emailItem = null;
  let bestGap = Infinity;
  for (const item of items) {
    if (!EMAIL_RE.test(item.str)) continue;
    if (Math.abs(item.x - vendorIdItem.x) > SAME_COLUMN_TOLERANCE_PT) continue;
    const gap = item.y - vendorIdItem.y; // PDF y-axis increases upward -- a line "above" has a larger y.
    if (gap <= 0 || gap > MAX_BLOCK_GAP_PT) continue;
    if (gap < bestGap) {
      bestGap = gap;
      emailItem = item;
    }
  }
  const email = emailItem ? emailItem.str.match(EMAIL_RE)[1] : null;

  return { vendorNumber, email };
}

module.exports = { extractPoVendorInfo };
