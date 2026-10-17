import { escapeHtml } from "../app.js";
import { api } from "../api.js";
import { COI_MATRIX, COI_MATRIX_BY_LABEL } from "../data/coiMatrix.js";
import { renderServiceCombo } from "../serviceCombo.js";

// Coverage columns in display order, with the full label used on the
// printed form (the matrix's own header abbreviations -- GL OCC, EXS,
// E&O, POL -- aren't self-explanatory to a vendor reading the PDF cold).
// Keys match COI_MATRIX's own `requirements` object (see coiMatrix.js).
const COVERAGE_COLUMNS = [
  { key: "glOcc", label: "General Liability -- Each Occurrence" },
  { key: "glAgg", label: "General Liability -- Aggregate" },
  { key: "auto", label: "Automobile Liability" },
  { key: "wc", label: "Workers' Compensation" },
  { key: "exs", label: "Umbrella / Excess Liability" },
  { key: "eAndO", label: "Errors & Omissions" },
  { key: "pol", label: "Pollution Liability" },
  { key: "crime", label: "Crime" },
  { key: "productsComplOpAgg", label: "Products / Completed Operations Aggregate" },
];

// Auto Liability's five acceptable ACORD 25 check-box combinations (see
// the matching screenshot Krista provided) -- kept as data rather than
// five near-identical HTML blocks so the box markup lives in one place.
const AUTO_LIABILITY_PATTERNS = [
  { any: true, owned: false, scheduled: false, hired: false, nonOwned: false },
  { any: false, owned: true, scheduled: true, hired: true, nonOwned: true },
  { any: false, owned: false, scheduled: true, hired: true, nonOwned: true },
  { any: false, owned: true, scheduled: false, hired: true, nonOwned: true },
  { any: false, owned: false, scheduled: false, hired: true, nonOwned: true },
];

const REQUIRED_COI_LANGUAGE =
  "C&W Facility Services Inc. d/b/a C&W Services, Toyota Motor Sales, USA, Inc., its subsidiaries and affiliated corporations are additional insureds (except Workers’ Compensation) as required by written contract/agreement.";

// Vendors & Onboarding > Onboard Requirements Form -- a standalone
// generator, not tied to an existing vendor record, since it's meant to
// go out *before* a vendor is in the system (the first ask sent during
// outreach). An RFM/admin picks what kind of work the vendor does -- the
// same COI_MATRIX that already backs the vendor profile's own Services
// select (see renderServicesSelect) -- and the rest of the page is the
// fixed C&W/Toyota onboarding checklist, same for every service, never
// translated or reworded, since it's quoted contract language a vendor
// is expected to match exactly on their COI.
export async function renderOnboardRequirementsForm(container) {
  // poEmail/paymentContact/w9Name/w9Address are deliberately not editor
  // inputs -- this form goes out *before* a vendor is in the system (the
  // first ask sent during outreach), so an admin never has that
  // information yet to prefill. They stay as real fillable fields in the
  // generated PDF (see server/utils/onboardRequirementsPdf.js), always
  // blank from this end, for the vendor to answer when they open it.
  const state = {
    service: COI_MATRIX[0].label,
    companyName: "",
    poEmail: "",
    paymentContact: "",
    w9Name: "",
    w9Address: "",
  };

  let generating = false;

  draw();

  function draw() {
    container.innerHTML = `
      <div class="onboard-req-page">
        <div class="onboard-req-editor no-print">
          <h2>Onboard Requirements Form</h2>
          <p class="onboard-req-editor-hint">
            Pick the vendor's type of service to pull in the Toyota-account COI minimum limits, then generate a
            fillable PDF. The preview below shows what's in it. PO notification email, payment verification contact,
            and the W-9 name/address are the <strong>vendor's</strong> information to give you back -- they're real,
            editable fields in the PDF itself, left blank here for the vendor to fill in when they open it. Nothing
            needs to be printed or signed by hand.
          </p>
          <div class="onboard-req-field-grid">
            <label class="onboard-req-field onboard-req-field-wide">
              <span>Type of service</span>
              <div class="service-combo-mount" id="onboard-req-service"></div>
            </label>
            <label class="onboard-req-field onboard-req-field-wide">
              <span>Name of requested company</span>
              <input type="text" id="onboard-req-company" value="${escapeHtml(state.companyName)}" placeholder="Vendor company name" />
            </label>
          </div>
          <button type="button" class="btn-primary" id="onboard-req-generate">Download Fillable PDF</button>
          <span class="save-message"></span>
        </div>
        <div class="onboard-req-document" id="onboard-req-document"></div>
      </div>
    `;

    renderDocument();

    const editor = container.querySelector(".onboard-req-editor");
    editor.querySelector("#onboard-req-service").replaceWith(
      renderServiceCombo({
        multiple: false,
        initialValue: state.service,
        onChange: (label) => {
          state.service = label;
          renderDocument();
        },
      })
    );
    editor.querySelector("#onboard-req-company").addEventListener("input", (e) => {
      state.companyName = e.target.value;
      renderDocument();
    });
    const generateBtn = editor.querySelector("#onboard-req-generate");
    const message = editor.querySelector(".save-message");
    generateBtn.addEventListener("click", async () => {
      if (generating) return;
      generating = true;
      generateBtn.disabled = true;
      generateBtn.textContent = "Generating…";
      message.textContent = "";
      try {
        await api.downloadFromPost("/api/admin/vendors/onboard-requirements-pdf", state, "Vendor Onboarding Requirements.pdf");
      } catch (err) {
        message.textContent = err.message;
      } finally {
        generating = false;
        generateBtn.disabled = false;
        generateBtn.textContent = "Download Fillable PDF";
      }
    });
  }

  // Only the document re-renders on every keystroke/selection change --
  // the editor's own inputs are left alone so typing doesn't lose focus
  // or cursor position.
  function renderDocument() {
    const entry = COI_MATRIX_BY_LABEL[state.service] || COI_MATRIX[0];
    container.querySelector("#onboard-req-document").innerHTML = documentHtml(state, entry);
  }
}

function hasLimit(v) {
  return v && v !== "-";
}

// A prefilled value shows as itself; an empty one shows as a marked
// placeholder rather than a blank line -- the generated PDF has a real
// fillable field there, not a line to write on, so the preview should
// read as "the vendor fills this in" rather than "this is blank."
function blank(value) {
  if (value && value.trim()) return escapeHtml(value.trim());
  return `<span class="onboard-req-fillable">vendor fills in</span>`;
}

// Company name is static text in the PDF (not a fillable field) -- it's
// just whatever the admin typed, or nothing, so an empty one reads as a
// plain placeholder rather than the "vendor fills this in" marker above.
function adminBlank(value) {
  if (value && value.trim()) return escapeHtml(value.trim());
  return `<span class="onboard-req-unset">not set</span>`;
}

function limitsTableHtml(entry) {
  const rows = COVERAGE_COLUMNS.filter((c) => hasLimit(entry.requirements[c.key]));
  if (rows.length === 0) {
    return `<div class="onboard-req-highlight-box">No minimum limits are on file for this service type -- confirm with your RFM before sending.</div>`;
  }
  return `
    <div class="onboard-req-highlight-box onboard-req-highlight-box-tight">
      <table class="coi-limits-table">
        <tbody>
          ${rows.map((c) => `<tr><th>${escapeHtml(c.label)}</th><td>${escapeHtml(entry.requirements[c.key])}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function autoLiabilityBoxHtml(p) {
  const check = (on) => `<span class="alb-check">${on ? "✓" : ""}</span>`;
  return `
    <div class="auto-liability-box">
      <div class="alb-title">AUTOMOBILE LIABILITY</div>
      <div class="alb-any-row">${check(p.any)} ANY AUTO</div>
      <div class="alb-grid">
        <div>${check(p.owned)} OWNED AUTOS ONLY</div>
        <div>${check(p.scheduled)} SCHEDULED AUTOS</div>
        <div>${check(p.hired)} HIRED AUTOS ONLY</div>
        <div>${check(p.nonOwned)} NON-OWNED AUTOS ONLY</div>
      </div>
    </div>
  `;
}

function documentHtml(state, entry) {
  // Just the leaf service name (after the last " / ") for the COI
  // section heading -- the full "Category / Sub-category / Service"
  // matrix label is right for a grouped dropdown, but reads oddly in a
  // sentence like "Certificate of Insurance -- HVAC Services".
  const serviceName = entry.label.split(" / ").pop();
  return `
    <div class="onboard-req-sheet">
      <h1>Vendor Onboarding Requirements</h1>

      <div class="onboard-req-callout">
        Please complete the highlighted fields below (PO notification email, payment verification contact, and your
        W-9 name/address), then return this PDF. Nothing needs to be printed or signed by hand.
      </div>

      <div class="onboard-req-line"><strong>Name of Requested Company:</strong> ${adminBlank(state.companyName)}</div>

      <h3>Confirmations</h3>
      <ul class="onboard-req-list">
        <li><strong>PO Notification Email:</strong> Email address where purchase orders should be sent: ${blank(state.poEmail)}</li>
        <li><strong>Payment Verification Contact:</strong> Direct phone number and extension, if applicable, for someone who can verbally verify the banking/payment information if ServiceEdge requires verification: ${blank(state.paymentContact)}</li>
      </ul>

      <p>Please provide the following updated documentation and information to Onboard with Service Edge:</p>

      <h3>1. W-9</h3>
      <ul class="onboard-req-list">
        <li>Signed and dated</li>
        <li>Must use the October 2018 or March 2024 W-9 version</li>
      </ul>
      <div class="onboard-req-line"><strong>W-9 Name:</strong> ${blank(state.w9Name)}</div>
      <div class="onboard-req-line"><strong>W-9 Address:</strong> ${blank(state.w9Address)}</div>

      <h3>2. Certificate of Insurance &ndash; ${escapeHtml(serviceName)}</h3>
      <ul class="onboard-req-list">
        <li>COI must be provided on an ACORD 25 (2016/03) form</li>
      </ul>
      <p>COI must meet the following minimum limits:</p>
      ${limitsTableHtml(entry)}

      <p><strong>Required COI Language</strong> (Descriptions box needs to EXACTLY copy the following text):</p>
      <div class="onboard-req-quote-box">${escapeHtml(REQUIRED_COI_LANGUAGE)}</div>

      <p><strong>Certificate Holder:</strong></p>
      <div class="onboard-req-address-box">
        C&amp;W Facility Services, Inc. d/b/a C&amp;W Services<br />
        117 Kendrick Street, Suite 250<br />
        Needham, MA 02494
      </div>

      <p><strong>Auto Liability Check Box Requirements:</strong> Under the Auto Liability, one of the following must be met:</p>
      <ol class="onboard-req-list">
        <li>Any Auto is checked (if checked, overrides all other check boxes and no further check box combinations are needed)</li>
        <li>All 4 Auto check boxes are checked (Owned Autos Only, Scheduled Autos, Hired Autos Only, Non-Owned Autos Only)</li>
        <li>Scheduled Autos, Hired Autos AND Non-Owned Autos checked ONLY</li>
        <li>Owned Autos, Hired Autos, Non-Owned Autos checked ONLY</li>
        <li>Hired Autos and Non-Owned Autos Only (can only be accepted after confirming with the supplier that there are no company-owned or scheduled vehicles) &ndash; email confirmation.</li>
      </ol>
      <div class="auto-liability-boxes">
        ${AUTO_LIABILITY_PATTERNS.map(autoLiabilityBoxHtml).join("")}
      </div>

      <h3>3. Payment / ACH Documentation</h3>
      <ul class="onboard-req-list">
        <li>Bank letter on BANK letterhead confirming the payment/banking information</li>
        <li>
          Blank invoice showing:
          <ul class="onboard-req-list">
            <li>Company name and address as stated on the W-9</li>
            <li>Contact name and phone number</li>
          </ul>
        </li>
      </ul>

      <div class="onboard-req-notice">
        <strong>NOTICE &ndash; Annual Maintenance Fee:</strong> As part of C&amp;W Services' supplier maintenance program, an
        annual maintenance fee based on the type of services provided is required to offset the cost of maintaining
        compliance with C&amp;W/C&amp;W Services standards. A Supplier Maintenance Fee invoice will be issued annually.
        This fee covers standard business relationships with Cushman &amp; Wakefield and C&amp;W Services. This happens
        POST onboarding by Avetta and recurs annually.
      </div>
    </div>
  `;
}
