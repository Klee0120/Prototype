// Shared between popup.js and background.js (both load this as an ES module).
// Mirrors public/js/views/timeTracker.js's category lists and endpoints
// exactly -- see that file's own comment for why these are fixed constants
// rather than fetched at startup.

export const API_BASE = "https://services-works.com";

export const STORAGE_KEYS = {
  session: "serviceworks_session", // { token, id, name, role, homeLocationCode }
  current: "serviceworks_current", // cached /time-log/current entry, or null
};

// tracksPo/tracksVendor mirror db.js/timeTracker.js exactly -- they drive
// the required-link-before-stop prompt (see popup.js's own comment).
export const TIME_LOG_CATEGORIES = [
  { key: "po_invoice", label: "PO / Invoice (unplanned)", tracksPo: true },
  { key: "vendor_onboarding", label: "Vendor Onboarding", tracksVendor: true },
  { key: "timekeeping", label: "Timekeeping (Review of Tech)", tracksTech: true },
  { key: "timekeeping_ukg", label: "Timekeeping - Enter UKG", tracksTech: true },
  { key: "project_status", label: "Project Status Review" },
  { key: "ops_meeting", label: "Operations Meeting" },
  { key: "safety_meeting", label: "Safety Meeting" },
  { key: "reclasses", label: "Reclasses", tracksPo: true },
  { key: "coi_renewals", label: "COI Renewals", tracksVendor: true },
  { key: "employee_support", label: "Employee Support" },
  { key: "invoicing", label: "Invoicing", tracksPo: true },
  { key: "documents", label: "Document Management" },
  { key: "order_supplies", label: "Order Supplies/Parts", tracksPo: true },
  { key: "uniform_ordering", label: "Uniform Ordering" },
  { key: "general", label: "General / Other" },
];

// Same threshold as timeTracker.js's own STALE_WARNING_SECONDS -- past
// this, both the popup and the toolbar badge switch to the warning style.
export const STALE_WARNING_SECONDS = 2 * 60 * 60;

export const INSTANT_LOG_CATEGORIES = [
  { key: "po_entered_tech_ordered", label: "PO Entered (Tech Ordered)", minutes: 2 },
  { key: "po_attached_tracker", label: "Attach PO to Tracker", minutes: 1 },
  { key: "enter_wom", label: "Enter WOM", minutes: 5 },
  { key: "enter_po_invoice_found", label: "Enter PO (Invoice Found, Missed Order)", minutes: 15 },
];

export const ESTIMATED_LOG_CATEGORIES = [{ key: "vendor_correspondence", label: "Vendor Correspondence" }];

export async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.session);
  return stored[STORAGE_KEYS.session] || null;
}

export async function setSession(session) {
  if (session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.session);
  }
}

export async function getCachedCurrent() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.current);
  return stored[STORAGE_KEYS.current] || null;
}

export async function setCachedCurrent(entry) {
  await chrome.storage.local.set({ [STORAGE_KEYS.current]: entry || null });
}

// Same request shape as public/js/api.js's request(), adapted for the
// extension: no cookie/session to fall back on, so a missing token just
// means "not logged in" rather than a 401 to report.
export async function apiRequest(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-session-token"] = token;

  const res = await fetch(`${API_BASE}${path}`, {
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
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Compact form for the toolbar badge, which has very little horizontal
// room (Chrome truncates past ~4 characters) -- "1h05" / "42m" rather than
// the popup's own full h:mm:ss display.
export function formatBadgeElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m}m`;
}
