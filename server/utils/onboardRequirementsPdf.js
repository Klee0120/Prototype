// Builds the Onboard Requirements Form as a real fillable PDF (AcroForm
// text fields a vendor can type straight into in Acrobat/Preview/Chrome's
// own PDF viewer) instead of a "print it, sign it, scan it back" document.
// The service-type limits/legal language/checklists are the admin's call,
// so those render as fixed text; PO email, payment contact, and the W-9
// name/address are the vendor's own information, so those render as blank
// (or admin-prefilled, still editable) form fields -- see
// public/js/views/onboardRequirementsForm.js for the UI this backs, and
// server/routes/vendors.js for the route that calls this.
const path = require("path");
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require("pdf-lib");

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Pulled from the app's own CSS custom properties (public/css/styles.css)
// so the PDF reads as the same document, not a different product.
const COLOR = {
  ink: rgb(0.141, 0.122, 0.122),
  muted: rgb(0.541, 0.475, 0.463),
  accent: rgb(0.639, 0.094, 0.165),
  accentDark: rgb(0.49, 0.071, 0.125),
  accentBg: rgb(0.973, 0.89, 0.882),
  warn: rgb(0.722, 0.349, 0.039),
  warnBg: rgb(0.992, 0.945, 0.894),
  border: rgb(0.871, 0.792, 0.776),
  fieldBg: rgb(0.969, 0.98, 1),
  fieldBorder: rgb(0.561, 0.69, 0.831),
};

const REQUIRED_COI_LANGUAGE =
  "C&W Facility Services Inc. d/b/a C&W Services, Toyota Motor Sales, USA, Inc., its subsidiaries and affiliated corporations are additional insureds (except Workers’ Compensation) as required by written contract/agreement.";

const COVERAGE_COLUMNS = [
  { key: "glOcc", label: "General Liability – Each Occurrence" },
  { key: "glAgg", label: "General Liability – Aggregate" },
  { key: "auto", label: "Automobile Liability" },
  { key: "wc", label: "Workers' Compensation" },
  { key: "exs", label: "Umbrella / Excess Liability" },
  { key: "eAndO", label: "Errors & Omissions" },
  { key: "pol", label: "Pollution Liability" },
  { key: "crime", label: "Crime" },
  { key: "productsComplOpAgg", label: "Products / Completed Operations Aggregate" },
];

const AUTO_LIABILITY_PATTERNS = [
  { any: true, owned: false, scheduled: false, hired: false, nonOwned: false },
  { any: false, owned: true, scheduled: true, hired: true, nonOwned: true },
  { any: false, owned: false, scheduled: true, hired: true, nonOwned: true },
  { any: false, owned: true, scheduled: false, hired: true, nonOwned: true },
  { any: false, owned: false, scheduled: false, hired: true, nonOwned: true },
];

function hasLimit(v) {
  return v && v !== "-";
}

// A thin layout cursor over pdf-lib's page API -- pdf-lib has no text
// flow/wrapping of its own, so every section below works in terms of
// "draw this, then move down," and this is what tracks the running Y
// position and adds a fresh page when something won't fit instead of
// running off the bottom.
function createCursor(pdfDoc, fonts) {
  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function newPage() {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }

  function ensureSpace(height) {
    if (y - height < MARGIN) newPage();
  }

  function wrapLines(text, font, size, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function text(str, { size = 10.5, font = fonts.regular, color = COLOR.ink, x = MARGIN, gap = 4 } = {}) {
    ensureSpace(size + gap);
    page.drawText(str, { x, y: y - size, size, font, color });
    y -= size + gap;
  }

  // Wraps to CONTENT_WIDTH (minus x's own left offset) and draws each
  // line, advancing y as it goes -- this is the workhorse every
  // paragraph/bullet in the document goes through.
  function wrapped(str, { size = 10.5, font = fonts.regular, color = COLOR.ink, x = MARGIN, maxWidth, lineGap = 3, afterGap = 6 } = {}) {
    const width = maxWidth ?? PAGE_WIDTH - MARGIN - x;
    const lines = wrapLines(str, font, size, width);
    for (const line of lines) {
      ensureSpace(size + lineGap);
      page.drawText(line, { x, y: y - size, size, font, color });
      y -= size + lineGap;
    }
    y -= afterGap - lineGap;
  }

  function space(height) {
    y -= height;
  }

  function rule({ color = COLOR.border, thickness = 1, gapAfter = 10 } = {}) {
    ensureSpace(thickness + gapAfter);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness, color });
    y -= thickness + gapAfter;
  }

  function currentPage() {
    return page;
  }

  // Box drawing (fill/border/left-bar callouts) lives in measuredBox
  // below, not here -- pdf-lib has no z-index, so a fill rectangle has to
  // be painted *before* its content, which means measuring the content's
  // height in a dry run first. A cursor alone can't do that two-pass
  // measure-then-paint itself.
  return { text, wrapped, space, rule, ensureSpace, newPage, get y() { return y; }, set y(v) { y = v; }, currentPage };
}

// Measures a box's content height first (by running the draw callback
// against a throwaway cursor) so the real pass can paint the fill
// rectangle *before* the content, instead of papering over it after the
// fact -- pdf-lib has no z-index, paint order is draw order.
function measuredBox(pdfDoc, fonts, cursor, { fillColor, borderColor, barColor, padding = 10 }, draw) {
  const boxX = MARGIN;
  const boxWidth = CONTENT_WIDTH;
  const innerX = boxX + padding + (barColor ? 6 : 0);
  const innerWidth = boxWidth - padding * 2 - (barColor ? 6 : 0);

  // Dry run on a scratch page/cursor purely to measure height.
  const scratchDoc = { addPage: () => ({ drawText() {}, drawRectangle() {}, drawLine() {} }) };
  const scratch = createCursor(scratchDoc, fonts);
  scratch.y = PAGE_HEIGHT - MARGIN; // plenty of room, never paginates for a single box
  const before = scratch.y;
  draw({
    text: (str, opts = {}) => scratch.text(str, { ...opts, x: innerX }),
    wrapped: (str, opts = {}) => scratch.wrapped(str, { ...opts, x: innerX, maxWidth: opts.maxWidth ?? innerWidth }),
  });
  const contentHeight = before - scratch.y;
  const boxHeight = contentHeight + padding * 2;

  cursor.ensureSpace(boxHeight);
  const startY = cursor.y;
  const endY = startY - boxHeight;
  const page = cursor.currentPage();
  if (fillColor) page.drawRectangle({ x: boxX, y: endY, width: boxWidth, height: boxHeight, color: fillColor });
  if (borderColor) page.drawRectangle({ x: boxX, y: endY, width: boxWidth, height: boxHeight, borderColor, borderWidth: 1 });
  if (barColor) page.drawRectangle({ x: boxX, y: endY, width: 4, height: boxHeight, color: barColor });

  cursor.y = startY - padding;
  draw({
    text: (str, opts = {}) => cursor.text(str, { ...opts, x: innerX }),
    wrapped: (str, opts = {}) => cursor.wrapped(str, { ...opts, x: innerX, maxWidth: opts.maxWidth ?? innerWidth }),
  });
  cursor.y = endY - 10;
}

const AUTO_BOX_WIDTH = 120;
const AUTO_BOX_HEIGHT = 80;

// A single vertical stack (checkbox + label per row) rather than the
// reference screenshot's cramped 2-column grid -- at a legible font size,
// "NON-OWNED AUTOS ONLY" next to a second checkbox doesn't fit a box this
// size without text colliding with the next checkbox, and this is meant
// to be easy to read at a glance, not a pixel copy of the source image.
function drawAutoLiabilityBox(page, x, y, pattern, fonts) {
  const w = AUTO_BOX_WIDTH;
  const h = AUTO_BOX_HEIGHT;
  page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: COLOR.ink, borderWidth: 1.2 });
  page.drawText("AUTOMOBILE LIABILITY", { x: x + 6, y: y - 11, size: 6, font: fonts.bold, color: COLOR.ink });
  page.drawLine({ start: { x: x + 5, y: y - 17 }, end: { x: x + w - 5, y: y - 17 }, thickness: 0.5, color: COLOR.ink });

  function checkRow(rowY, checked, label) {
    page.drawRectangle({ x: x + 6, y: rowY, width: 7, height: 7, borderColor: COLOR.ink, borderWidth: 0.7 });
    if (checked) page.drawText("X", { x: x + 7, y: rowY + 0.8, size: 6.5, font: fonts.bold, color: COLOR.ink });
    page.drawText(label, { x: x + 17, y: rowY + 1, size: 6, font: fonts.regular, color: COLOR.ink });
  }

  checkRow(y - 27, pattern.any, "ANY AUTO");
  checkRow(y - 38, pattern.owned, "OWNED AUTOS ONLY");
  checkRow(y - 49, pattern.scheduled, "SCHEDULED AUTOS");
  checkRow(y - 60, pattern.hired, "HIRED AUTOS ONLY");
  checkRow(y - 71, pattern.nonOwned, "NON-OWNED AUTOS ONLY");
}

// Adds a fillable text field at the given spot -- light blue fill +
// border so a vendor opening the PDF can see at a glance which fields are
// theirs to complete, same idea as a web form's focus/input styling.
//
// `description` sets the field's /TU (alternate field name) entry --
// pdf-lib has no typed API for this (unlike setText), so it's written
// straight into the field's dict. Screen readers announce this instead
// of the raw field name ("poEmail"), so a vendor using one hears "PO
// Notification Email, the email address purchase orders should be sent
// to" rather than just "poEmail, edit text."
function addField(form, page, name, { x, y, width, height = 16, value = "", description, fonts }) {
  const field = form.createTextField(name);
  field.setText(value || "");
  if (description) field.acroField.dict.set(PDFName.of("TU"), PDFString.of(description));
  field.addToPage(page, {
    x,
    y,
    width,
    height,
    borderWidth: 1,
    borderColor: COLOR.fieldBorder,
    backgroundColor: COLOR.fieldBg,
  });
  field.updateAppearances(fonts.regular);
  field.setFontSize(10);
}

async function buildOnboardRequirementsPdf({ service, companyName, poEmail, paymentContact, w9Name, w9Address }) {
  // COI_MATRIX only exists as a client-side ES module (public/js/data/
  // coiMatrix.js, the same file the admin's Onboard Requirements Form and
  // vendor Services picker already import) -- a nested package.json with
  // {"type":"module"} in that folder lets a dynamic import() load it from
  // this CommonJS server file without duplicating the data.
  const dataUrl = path.join(__dirname, "..", "..", "public", "js", "data", "coiMatrix.js");
  const { COI_MATRIX_BY_LABEL, COI_MATRIX } = await import(`file://${dataUrl}`);
  const entry = COI_MATRIX_BY_LABEL[service] || COI_MATRIX[0];
  const serviceName = entry.label.split(" / ").pop();

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle("Vendor Onboarding Requirements");
  pdfDoc.setProducer("ServiceWorks");
  pdfDoc.setLanguage("en-US");
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  };
  const form = pdfDoc.getForm();
  const c = createCursor(pdfDoc, fonts);

  // --- Title ---
  c.text("Vendor Onboarding Requirements", { size: 19, font: fonts.bold, color: COLOR.accentDark, gap: 4 });
  c.text(`Service type: ${serviceName}`, { size: 10, font: fonts.regular, color: COLOR.muted, gap: 10 });

  measuredBox(
    pdfDoc,
    fonts,
    c,
    { fillColor: COLOR.accentBg, barColor: COLOR.accent, padding: 9 },
    (inner) => {
      inner.wrapped(
        "Please complete the highlighted fields below (company name, PO notification email, payment verification contact, and your W-9 name/address), then return this PDF. Nothing needs to be printed or signed by hand.",
        { size: 9.5, font: fonts.bold, color: COLOR.accentDark }
      );
    }
  );

  // --- Name of Requested Company (fillable) ---
  // Admin-prefillable in practice -- whoever's sending this usually knows
  // who they're sending it to -- but still a real field, not baked-in
  // static text, since this form is also meant to go out as a blank,
  // reusable packet (one URL/attachment, not a new one typed up every
  // time) and nothing here *requires* the admin to know it up front.
  c.text("Name of Requested Company:", { size: 9.5, font: fonts.bold, gap: 3 });
  c.ensureSpace(22);
  addField(form, c.currentPage(), "companyName", {
    x: MARGIN, y: c.y - 16, width: CONTENT_WIDTH, value: companyName, fonts,
    description: "Name of Requested Company -- the vendor's company name",
  });
  c.space(24);

  // --- Confirmations (fillable) ---
  c.text("Confirmations", { size: 12.5, font: fonts.bold, color: COLOR.ink, gap: 6 });
  c.text("PO Notification Email -- where purchase orders should be sent:", { size: 9.5, color: COLOR.ink, gap: 3 });
  c.ensureSpace(22);
  addField(form, c.currentPage(), "poEmail", {
    x: MARGIN, y: c.y - 16, width: CONTENT_WIDTH, value: poEmail, fonts,
    description: "PO Notification Email -- the email address where purchase orders should be sent",
  });
  c.space(24);

  c.text("Payment Verification Contact -- direct phone + extension for someone who can verbally verify banking/payment info if required:", {
    size: 9.5,
    color: COLOR.ink,
    gap: 3,
  });
  c.ensureSpace(22);
  addField(form, c.currentPage(), "paymentContact", {
    x: MARGIN, y: c.y - 16, width: CONTENT_WIDTH, value: paymentContact, fonts,
    description: "Payment Verification Contact -- direct phone number and extension for someone who can verbally verify banking or payment information",
  });
  c.space(24);

  c.wrapped("Please provide the following updated documentation and information to onboard with Service Edge:", {
    size: 10, color: COLOR.ink, afterGap: 8,
  });
  c.rule();

  // --- 1. W-9 (fillable) ---
  c.text("1. W-9", { size: 13, font: fonts.bold, color: COLOR.accentDark, gap: 6 });
  c.text("•  Signed and dated", { size: 9.5, gap: 3 });
  c.text("•  Must use the October 2018 or March 2024 W-9 version", { size: 9.5, gap: 8 });

  c.text("W-9 Name:", { size: 9.5, font: fonts.bold, gap: 3 });
  c.ensureSpace(22);
  addField(form, c.currentPage(), "w9Name", {
    x: MARGIN, y: c.y - 16, width: CONTENT_WIDTH, value: w9Name, fonts,
    description: "W-9 Name -- the legal name on file on your W-9",
  });
  c.space(24);

  c.text("W-9 Address:", { size: 9.5, font: fonts.bold, gap: 3 });
  c.ensureSpace(22);
  addField(form, c.currentPage(), "w9Address", {
    x: MARGIN, y: c.y - 16, width: CONTENT_WIDTH, value: w9Address, fonts,
    description: "W-9 Address -- the address on file on your W-9",
  });
  c.space(26);
  c.rule();

  // --- 2. COI ---
  c.text(`2. Certificate of Insurance – ${serviceName}`, { size: 13, font: fonts.bold, color: COLOR.accentDark, gap: 6 });
  c.text("•  COI must be provided on an ACORD 25 (2016/03) form", { size: 9.5, gap: 8 });
  c.text("COI must meet the following minimum limits:", { size: 10, font: fonts.bold, gap: 6 });

  const rows = COVERAGE_COLUMNS.filter((col) => hasLimit(entry.requirements[col.key]));
  measuredBox(pdfDoc, fonts, c, { fillColor: COLOR.accentBg, borderColor: COLOR.border, padding: 8 }, (inner) => {
    if (rows.length === 0) {
      inner.wrapped("No minimum limits are on file for this service type -- confirm with your RFM before sending.", { size: 9.5 });
      return;
    }
    for (const col of rows) {
      inner.text(`${col.label}:  ${entry.requirements[col.key]}`, { size: 10, font: fonts.bold, color: COLOR.accentDark, gap: 5 });
    }
  });

  c.text("Required COI Language -- the Description box on the COI must copy this text EXACTLY:", {
    size: 9.5, font: fonts.bold, color: COLOR.ink, gap: 5,
  });
  measuredBox(pdfDoc, fonts, c, { fillColor: rgb(0.973, 0.973, 0.973), borderColor: COLOR.ink, barColor: COLOR.accent, padding: 9 }, (inner) => {
    inner.wrapped(REQUIRED_COI_LANGUAGE, { size: 9.5, font: fonts.bold });
  });

  c.text("Certificate Holder:", { size: 9.5, font: fonts.bold, gap: 5 });
  measuredBox(pdfDoc, fonts, c, { borderColor: COLOR.border, padding: 8 }, (inner) => {
    inner.text("C&W Facility Services, Inc. d/b/a C&W Services", { size: 9.5, gap: 2 });
    inner.text("117 Kendrick Street, Suite 250", { size: 9.5, gap: 2 });
    inner.text("Needham, MA 02494", { size: 9.5, gap: 0 });
  });

  c.wrapped("Auto Liability Check Box Requirements: under Auto Liability, one of the following must be met:", {
    size: 9.5, font: fonts.bold, afterGap: 4,
  });
  const alRules = [
    "1. Any Auto is checked (overrides all other check boxes; no further combinations needed)",
    "2. All 4 Auto check boxes are checked (Owned Autos Only, Scheduled Autos, Hired Autos Only, Non-Owned Autos Only)",
    "3. Scheduled Autos, Hired Autos AND Non-Owned Autos checked ONLY",
    "4. Owned Autos, Hired Autos, Non-Owned Autos checked ONLY",
    "5. Hired Autos and Non-Owned Autos Only (only after confirming the supplier has no company-owned or scheduled vehicles) – email confirmation.",
  ];
  for (const rule of alRules) c.wrapped(rule, { size: 9, afterGap: 3 });
  c.space(4);

  // Five small visual boxes, two rows (3 + 2) -- same five combinations as
  // the on-screen preview and Krista's reference screenshot, just a
  // vertical checkbox stack per box instead of a 2-column grid (see
  // drawAutoLiabilityBox).
  const boxGap = 12;
  const rowGap = 10;
  const boxRows = [AUTO_LIABILITY_PATTERNS.slice(0, 3), AUTO_LIABILITY_PATTERNS.slice(3)];
  for (const rowPatterns of boxRows) {
    c.ensureSpace(AUTO_BOX_HEIGHT + rowGap);
    let bx = MARGIN;
    for (const pattern of rowPatterns) {
      drawAutoLiabilityBox(c.currentPage(), bx, c.y, pattern, fonts);
      bx += AUTO_BOX_WIDTH + boxGap;
    }
    c.space(AUTO_BOX_HEIGHT + rowGap);
  }
  c.rule();

  // --- 3. ACH ---
  c.text("3. Payment / ACH Documentation", { size: 13, font: fonts.bold, color: COLOR.accentDark, gap: 6 });
  c.text("•  Bank letter on BANK letterhead confirming the payment/banking information", { size: 9.5, gap: 3 });
  c.wrapped("•  Blank invoice showing: company name and address as stated on the W-9, and a contact name and phone number", {
    size: 9.5, afterGap: 10,
  });

  // --- Annual fee notice ---
  measuredBox(pdfDoc, fonts, c, { fillColor: COLOR.warnBg, borderColor: COLOR.warn, barColor: COLOR.warn, padding: 9 }, (inner) => {
    inner.wrapped("NOTICE – Annual Maintenance Fee", { size: 10.5, font: fonts.bold, color: COLOR.warn, afterGap: 4 });
    inner.wrapped(
      "As part of C&W Services' supplier maintenance program, an annual maintenance fee based on the type of services provided is required to offset the cost of maintaining compliance with C&W/C&W Services standards. A Supplier Maintenance Fee invoice will be issued annually. This fee covers standard business relationships with Cushman & Wakefield and C&W Services. This happens POST onboarding by Avetta and recurs annually.",
      { size: 9, color: rgb(0.478, 0.235, 0.024) }
    );
  });

  form.updateFieldAppearances(fonts.regular);
  return pdfDoc.save();
}

module.exports = { buildOnboardRequirementsPdf, REQUIRED_COI_LANGUAGE, COVERAGE_COLUMNS, AUTO_LIABILITY_PATTERNS, hasLimit };
