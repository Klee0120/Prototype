// Standalone vendor-portal client -- intentionally its own small module,
// not a view inside public/js/app.js's router/bundle. See index.html's
// own comment for why that separation matters here specifically.
const SESSION_KEY = "vendorPortal:session";

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private-window/blocked-storage: the portal still works for this
    // page load, just won't stay signed in across a reload.
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clean up if storage was never writable.
  }
}

async function apiRequest(method, path, body) {
  const session = loadSession();
  const headers = { "Content-Type": "application/json" };
  if (session && session.token) headers["x-vendor-session-token"] = session.token;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) clearSession();
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// Same auth/error handling as apiRequest, but for a multipart upload --
// no Content-Type set explicitly so the browser fills in the multipart
// boundary itself.
async function apiUpload(path, formData) {
  const session = loadSession();
  const headers = {};
  if (session && session.token) headers["x-vendor-session-token"] = session.token;

  const res = await fetch(path, { method: "POST", headers, body: formData });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) clearSession();
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const loginView = document.getElementById("login-view");
const checklistView = document.getElementById("checklist-view");
const contactView = document.getElementById("contact-view");
const uploadView = document.getElementById("upload-view");
const helpView = document.getElementById("help-view");
const logoutRow = document.getElementById("logout-row");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");

function showLogin(message) {
  checklistView.hidden = true;
  contactView.hidden = true;
  uploadView.hidden = true;
  helpView.hidden = true;
  logoutRow.hidden = true;
  loginView.hidden = false;
  if (message) {
    loginError.textContent = message;
    loginError.style.display = "block";
  } else {
    loginError.style.display = "none";
  }
}

function statusPillClass(status) {
  return String(status || "").trim().toLowerCase() === "approved" ? "status-pill approved" : "status-pill";
}
function statusLabel(item) {
  if (item.notRequired) return "Not required";
  return item.status && item.status.trim() ? item.status : "Not started";
}
function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y}` : "";
}

async function showChecklist() {
  let data;
  try {
    data = await apiRequest("GET", "/api/vendor-portal/me");
  } catch (err) {
    showLogin(err.message === "Session expired or invalid" ? "Your session expired -- please sign in again." : null);
    return;
  }
  loginView.hidden = true;
  checklistView.hidden = false;
  contactView.hidden = false;
  uploadView.hidden = false;
  helpView.hidden = false;
  logoutRow.hidden = false;
  document.getElementById("vendor-name").textContent = data.vendorName;
  document.getElementById("summary-line").textContent = `${data.approvedCount}/${data.totalCount} document cases approved`;
  document.getElementById("contact-phone").value = data.phone || "";
  document.getElementById("contact-email").value = data.email || "";
  document.getElementById("contact-po-email").value = data.poEmail || "";
  const list = document.getElementById("checklist-items");
  list.innerHTML = data.items
    .filter((item) => !item.notRequired)
    .map(
      (item) => `
        <li>
          <span>
            ${escapeHtml(item.label)}
            ${item.expirationDate ? `<span class="expiration"> &middot; expires ${formatDate(item.expirationDate)}</span>` : ""}
          </span>
          <span class="${statusPillClass(item.status)}">${escapeHtml(statusLabel(item))}</span>
        </li>`
    )
    .join("");

  // Only enabled once every required case actually shows Approved -- not a
  // free-standing "check on me" button. data.totalCount already excludes
  // notRequired cases (see db.getVendorPortalChecklist), same filter the
  // list above applies.
  const submitBtn = document.getElementById("submit-for-review-btn");
  const submitHint = document.getElementById("submit-hint");
  const allApproved = data.totalCount > 0 && data.approvedCount === data.totalCount;
  submitBtn.disabled = !allApproved;
  submitHint.textContent = allApproved
    ? "Everything's approved -- let us know you're ready for the next step."
    : "This unlocks once every document case above shows Approved.";

  await loadDocHistory();
}

const DOC_CATEGORY_LABELS = {
  coi: "Certificate of Insurance (COI)",
  w9: "W-9",
  ach: "ACH / banking form",
  check: "Voided check",
  blank_invoice: "Blank invoice",
  hold_harmless: "Hold harmless agreement",
};

async function loadDocHistory() {
  const list = document.getElementById("doc-history-items");
  let docs;
  try {
    docs = await apiRequest("GET", "/api/vendor-portal/documents");
  } catch {
    list.innerHTML = `<li>Couldn't load your upload history right now.</li>`;
    return;
  }
  if (docs.length === 0) {
    list.innerHTML = `<li>Nothing submitted yet.</li>`;
    return;
  }
  list.innerHTML = docs
    .map(
      (f) => `
        <li>
          <span>
            ${escapeHtml(DOC_CATEGORY_LABELS[f.category] || f.category)}
            <span class="doc-meta"> &middot; ${escapeHtml(f.originalName)} &middot; ${new Date(f.uploadedAt).toLocaleDateString()}</span>
          </span>
        </li>`
    )
    .join("");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginSubmit.disabled = true;
  loginError.style.display = "none";
  const taxId = document.getElementById("tax-id").value.trim();
  const passcode = document.getElementById("passcode").value;
  try {
    const result = await apiRequest("POST", "/api/vendor-portal/login", { taxId, passcode });
    saveSession({ token: result.token, id: result.id, name: result.name });
    await showChecklist();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.style.display = "block";
  } finally {
    loginSubmit.disabled = false;
  }
});

const contactForm = document.getElementById("contact-form");
const contactSubmit = document.getElementById("contact-submit");
const contactError = document.getElementById("contact-error");
const contactSuccess = document.getElementById("contact-success");

contactForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  contactSubmit.disabled = true;
  contactError.style.display = "none";
  contactSuccess.style.display = "none";
  const phone = document.getElementById("contact-phone").value.trim();
  const email = document.getElementById("contact-email").value.trim();
  const poEmail = document.getElementById("contact-po-email").value.trim();
  try {
    await apiRequest("PATCH", "/api/vendor-portal/contact-info", { phone, email, poEmail });
    contactSuccess.textContent = "Saved.";
    contactSuccess.style.display = "block";
  } catch (err) {
    contactError.textContent = err.message;
    contactError.style.display = "block";
  } finally {
    contactSubmit.disabled = false;
  }
});

const helpForm = document.getElementById("help-form");
const helpSubmit = document.getElementById("help-submit");
const helpError = document.getElementById("help-error");
const helpSuccess = document.getElementById("help-success");

helpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  helpSubmit.disabled = true;
  helpError.style.display = "none";
  helpSuccess.style.display = "none";
  const message = document.getElementById("help-message").value.trim();
  try {
    await apiRequest("POST", "/api/vendor-portal/help-request", { message });
    helpSuccess.textContent = "Sent -- a C&W Services admin will follow up.";
    helpSuccess.style.display = "block";
    helpForm.reset();
  } catch (err) {
    helpError.textContent = err.message;
    helpError.style.display = "block";
  } finally {
    helpSubmit.disabled = false;
  }
});

const submitForReviewBtn = document.getElementById("submit-for-review-btn");
const submitError = document.getElementById("submit-error");
const submitSuccess = document.getElementById("submit-success");

submitForReviewBtn.addEventListener("click", async () => {
  submitForReviewBtn.disabled = true;
  submitError.style.display = "none";
  submitSuccess.style.display = "none";
  try {
    await apiRequest("POST", "/api/vendor-portal/submit-for-review");
    submitSuccess.textContent = "Submitted -- a C&W Services admin will take it from here.";
    submitSuccess.style.display = "block";
  } catch (err) {
    submitError.textContent = err.message;
    submitError.style.display = "block";
    submitForReviewBtn.disabled = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try {
    await apiRequest("POST", "/api/vendor-portal/logout");
  } catch {
    // Already-expired/invalid session -- still clear local state and
    // return to the login view below regardless.
  }
  clearSession();
  showLogin();
});

const uploadForm = document.getElementById("upload-form");
const uploadSubmit = document.getElementById("upload-submit");
const uploadError = document.getElementById("upload-error");
const uploadSuccess = document.getElementById("upload-success");
const coiReviewResult = document.getElementById("coi-review-result");

// The only two things actually verified automatically off the file itself
// (right form, right wording) -- everything else in coiReview.checklist is
// the full requirement list for this vendor's service type(s), the same
// data server/utils/coiDocumentReview.js's buildCoiRequirementChecklist
// gives the admin's own Onboarding & Compliance tab. Deliberately never
// framed as "we checked your coverage amounts" -- this app never tries to
// auto-read actual dollar limits off a scan (see that file's own comment:
// a wrong auto-read risks silently clearing an under-covered vendor), so
// showing the list as a verified checklist would be a false promise.
// Two checklist item keys ("acord25", "language") line up exactly with
// extractionHints -- this is a real, verified result (the document's own
// text was actually checked), so those two get a real status pill. Every
// other item (certHolder, autoLiabilityBoxes, and every per-service
// coverage-amount line) gets a neutral "Needs manual review" pill instead
// of a checkmark, since nothing here ever reads an actual coverage dollar
// amount off the page -- see this function's own header comment for why
// pretending otherwise would be a false promise.
const COI_AUTO_CHECKED_KEYS = new Set(["acord25", "language"]);
function coiItemStatus(item, hints) {
  if (!COI_AUTO_CHECKED_KEYS.has(item.key) || hints[item.key] === undefined) {
    return { pillClass: "status-pill", label: "Needs manual review" };
  }
  return hints[item.key]
    ? { pillClass: "status-pill approved", label: "Confirmed" }
    : { pillClass: "status-pill coi-not-confirmed", label: "Couldn't confirm" };
}

function renderCoiReviewResult(coiReview) {
  if (!coiReview) {
    coiReviewResult.hidden = true;
    return;
  }
  const hints = coiReview.extractionHints || {};
  const checklist = Array.isArray(coiReview.checklist) ? coiReview.checklist : [];
  coiReviewResult.hidden = false;
  coiReviewResult.innerHTML = `
    <strong>Your COI is in for review.</strong>
    ${
      checklist.length
        ? `
          <p class="hint" style="margin-top: 8px;">Here's the full insurance requirement list for your registered service type(s). "Confirmed"/"Couldn't confirm" are the only two things actually checked automatically from the file you uploaded -- everything marked "Needs manual review" still needs a human reviewer to confirm against your actual certificate.</p>
          <ul class="checklist coi-requirement-list">
            ${checklist
              .map((item) => {
                const status = coiItemStatus(item, hints);
                return `
                  <li class="coi-requirement-item" data-key="${escapeHtml(item.key)}" data-label="${escapeHtml(item.label)}">
                    <span>${escapeHtml(item.label)}</span>
                    <span class="coi-requirement-actions">
                      <span class="${status.pillClass}">${status.label}</span>
                      <button type="button" class="btn-link coi-waiver-toggle">Request waiver</button>
                    </span>
                  </li>
                `;
              })
              .join("")}
          </ul>
        `
        : "<p>A C&amp;W Services admin will review it before it's approved.</p>"
    }
  `;
  wireCoiWaiverToggles();
}

// Each requirement item's "Request waiver" button toggles open a small
// inline form (not a browser prompt() -- the rest of this portal uses real
// forms for every other input) asking why, and which outcome the vendor is
// asking for: a VPO waiver or a hold harmless agreement. Only one open at a
// time, same single-mini-form-at-a-time pattern as not stacking multiple
// COI review panels.
function wireCoiWaiverToggles() {
  coiReviewResult.querySelectorAll(".coi-waiver-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".coi-requirement-item");
      const existing = coiReviewResult.querySelector(".coi-waiver-form");
      if (existing) existing.remove();
      if (existing && existing.dataset.forKey === item.dataset.key) return; // toggled closed

      const form = document.createElement("li");
      form.className = "coi-waiver-form";
      form.dataset.forKey = item.dataset.key;
      form.innerHTML = `
        <div class="error" style="display:none;"></div>
        <div class="success" style="display:none;"></div>
        <label>Why can't this be met?</label>
        <textarea class="coi-waiver-reason" rows="2"></textarea>
        <label>What are you requesting?</label>
        <select class="coi-waiver-outcome">
          <option value="vpo_waiver">VPO waiver</option>
          <option value="hold_harmless">Hold harmless agreement</option>
        </select>
        <button type="button" class="coi-waiver-submit">Send request</button>
      `;
      item.after(form);

      const errorEl = form.querySelector(".error");
      const successEl = form.querySelector(".success");
      form.querySelector(".coi-waiver-submit").addEventListener("click", async () => {
        const reason = form.querySelector(".coi-waiver-reason").value.trim();
        const outcome = form.querySelector(".coi-waiver-outcome").value;
        errorEl.style.display = "none";
        if (!reason) {
          errorEl.textContent = "Let us know why this can't be met.";
          errorEl.style.display = "block";
          return;
        }
        try {
          await apiRequest("POST", "/api/vendor-portal/coi-waiver-request", {
            requirementKey: item.dataset.key,
            requirementLabel: item.dataset.label,
            reason,
            outcome,
          });
          successEl.textContent = "Sent -- a C&W Services admin will follow up.";
          successEl.style.display = "block";
          form.querySelector(".coi-waiver-submit").disabled = true;
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
        }
      });
    });
  });
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  uploadSubmit.disabled = true;
  uploadError.style.display = "none";
  uploadSuccess.style.display = "none";
  coiReviewResult.hidden = true;
  const category = document.getElementById("upload-category").value;
  const fileInput = document.getElementById("upload-file");
  const file = fileInput.files[0];
  if (!file) {
    uploadSubmit.disabled = false;
    return;
  }
  const formData = new FormData();
  formData.append("category", category);
  formData.append("file", file);
  try {
    const result = await apiUpload("/api/vendor-portal/documents", formData);
    uploadSuccess.textContent = `${DOC_CATEGORY_LABELS[category] || category} uploaded.`;
    uploadSuccess.style.display = "block";
    renderCoiReviewResult(result.coiReview);
    uploadForm.reset();
    await loadDocHistory();
  } catch (err) {
    uploadError.textContent = err.message;
    uploadError.style.display = "block";
  } finally {
    uploadSubmit.disabled = false;
  }
});

(async function init() {
  const session = loadSession();
  if (session && session.token) {
    await showChecklist();
  } else {
    showLogin();
  }
})();
