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
const logoutRow = document.getElementById("logout-row");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");

function showLogin(message) {
  checklistView.hidden = true;
  contactView.hidden = true;
  uploadView.hidden = true;
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

function renderCoiReviewResult(coiReview) {
  if (!coiReview) {
    coiReviewResult.hidden = true;
    return;
  }
  const hints = coiReview.extractionHints || {};
  const notes = [];
  if (hints.acord25 === false) notes.push("We couldn't confirm this is on an ACORD 25 (2016/03) form -- double check before it's reviewed.");
  if (hints.language === false) notes.push("We couldn't find the required additional-insured language -- double check it's present and matches exactly.");
  coiReviewResult.hidden = false;
  coiReviewResult.innerHTML = `
    <strong>Your COI is in for review.</strong>
    ${notes.length ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "<p>Nothing obviously missing from what we could read off the file -- a C&amp;W Services admin will still review it before it's approved.</p>"}
  `;
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
