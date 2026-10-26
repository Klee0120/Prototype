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

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const loginView = document.getElementById("login-view");
const checklistView = document.getElementById("checklist-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");

function showLogin(message) {
  checklistView.hidden = true;
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
  document.getElementById("vendor-name").textContent = data.vendorName;
  document.getElementById("summary-line").textContent = `${data.approvedCount}/${data.totalCount} document cases approved`;
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

(async function init() {
  const session = loadSession();
  if (session && session.token) {
    await showChecklist();
  } else {
    showLogin();
  }
})();
