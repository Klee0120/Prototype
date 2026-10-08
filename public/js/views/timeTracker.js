import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";

// A persistent floating widget, mounted once in app.js's render() as a
// sibling of the sidebar/main shell -- NOT inside any single view's own
// draw(), so it survives every tab switch for the rest of the session
// (only a full re-render -- login/logout/session-expiry -- recreates it,
// at which point it re-polls /current and picks a still-running clock
// back up exactly where it was). Admin-only: this tracks an admin's own
// work, same reasoning the Performance tab is admin-only.
//
// Interaction model (confirmed with Krista): clicking a category while
// another one is running auto-switches -- one click, no confirmation,
// since the real workflow is "touch a dozen things today," not "and now
// let me confirm I'm switching tasks." Going idle without starting a new
// category is a separate, deliberate Stop action, so an untracked gap
// (a break, stepping away) never silently gets attributed to whatever
// ran last -- that's what keeps the data trustworthy despite the low-
// friction switching.
export function mountTimeTracker() {
  if (!state.user || state.user.role !== "admin") return null;

  const el = document.createElement("div");
  el.className = "time-tracker";
  let current = null; // the running entry, or null
  let expanded = false;
  let tickTimer = null;
  let poSearchResults = [];
  let poSearchTimer = null;
  // The most recently one-click-logged instant entry -- shown briefly as a
  // confirmation with an optional "attach a reference" follow-up, since the
  // whole point of instant logging is never blocking on that at the moment
  // of the click (see logInstant below).
  let lastInstantEntry = null;
  let instantNoteSaveTimer = null;
  let instantPoSearchResults = [];
  let instantPoSearchTimer = null;

  function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function categoryLabel(key) {
    const c = TIME_LOG_CATEGORIES.find((cat) => cat.key === key);
    return c ? c.label : key;
  }

  function instantCategoryDef(key) {
    return INSTANT_LOG_CATEGORIES.find((c) => c.key === key) || null;
  }

  function liveElapsedSeconds() {
    if (!current) return 0;
    return (Date.now() - new Date(current.startedAt).getTime()) / 1000;
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(() => {
      const pill = el.querySelector(".time-tracker-elapsed");
      if (pill) pill.textContent = formatElapsed(liveElapsedSeconds());
    }, 1000);
  }
  function stopTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  async function refreshCurrent() {
    try {
      current = await api.get("/api/admin/time-log/current");
    } catch {
      current = null;
    }
    render();
  }

  async function startCategory(key) {
    try {
      current = await api.post("/api/admin/time-log/start", { category: key });
      render();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function stopCurrent() {
    try {
      current = null;
      await api.post("/api/admin/time-log/stop", {});
      render();
    } catch (err) {
      window.alert(err.message);
    }
  }

  let noteSaveTimer = null;
  async function saveCurrentDetails(fields) {
    if (!current) return;
    try {
      const updated = await api.patch(`/api/admin/time-log/${current.id}`, fields);
      current = { ...current, ...updated };
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function searchPos(query) {
    if (!query.trim()) {
      poSearchResults = [];
      renderPoResults();
      return;
    }
    try {
      const results = await api.get(`/api/admin/pos?${new URLSearchParams({ search: query })}`);
      poSearchResults = Array.isArray(results) ? results : [];
    } catch {
      poSearchResults = [];
    }
    renderPoResults();
  }

  function renderPoResults() {
    const host = el.querySelector(".time-tracker-po-results");
    if (!host) return;
    if (poSearchResults.length === 0) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = poSearchResults
      .slice(0, 8)
      .map(
        (p) =>
          `<button type="button" class="time-tracker-po-result" data-id="${p.id}">${escapeHtml(p.poNumber || "PO")} ${
            p.description ? `&mdash; ${escapeHtml(p.description)}` : ""
          }</button>`
      )
      .join("");
    host.querySelectorAll(".time-tracker-po-result").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.id);
        await saveCurrentDetails({ relatedPoId: id });
        render();
      });
    });
  }

  // Fires immediately on click -- never touches `current`, so a running
  // timer keeps going undisturbed (see db.js's logInstantTimeEntry).
  async function logInstant(key) {
    try {
      lastInstantEntry = await api.post("/api/admin/time-log/instant", { category: key });
      instantPoSearchResults = [];
      render();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function saveInstantDetails(fields) {
    if (!lastInstantEntry) return;
    try {
      const updated = await api.patch(`/api/admin/time-log/${lastInstantEntry.id}`, fields);
      lastInstantEntry = { ...lastInstantEntry, ...updated };
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function searchInstantPos(query) {
    if (!query.trim()) {
      instantPoSearchResults = [];
      renderInstantPoResults();
      return;
    }
    try {
      const results = await api.get(`/api/admin/pos?${new URLSearchParams({ search: query })}`);
      instantPoSearchResults = Array.isArray(results) ? results : [];
    } catch {
      instantPoSearchResults = [];
    }
    renderInstantPoResults();
  }

  function renderInstantPoResults() {
    const host = el.querySelector(".time-tracker-instant-po-results");
    if (!host) return;
    if (instantPoSearchResults.length === 0) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = instantPoSearchResults
      .slice(0, 8)
      .map(
        (p) =>
          `<button type="button" class="time-tracker-po-result" data-id="${p.id}">${escapeHtml(p.poNumber || "PO")} ${
            p.description ? `&mdash; ${escapeHtml(p.description)}` : ""
          }</button>`
      )
      .join("");
    host.querySelectorAll(".time-tracker-po-result").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.id);
        await saveInstantDetails({ relatedPoId: id });
        render();
      });
    });
  }

  function render() {
    stopTicking();
    const tabLabel = current
      ? `${escapeHtml(categoryLabel(current.category))} &middot; <span class="time-tracker-elapsed">${formatElapsed(liveElapsedSeconds())}</span>`
      : "Track time";

    el.innerHTML = `
      <div class="time-tracker-tab ${current ? "time-tracker-tab-active" : ""}">
        <span class="time-tracker-tab-dot" aria-hidden="true"></span>
        <span class="time-tracker-tab-label">${tabLabel}</span>
        <span class="time-tracker-tab-chevron">${expanded ? "&#9660;" : "&#9650;"}</span>
      </div>
      <div class="time-tracker-panel" ${expanded ? "" : "hidden"}>
        <div class="time-tracker-categories">
          ${TIME_LOG_CATEGORIES.map(
            (c) =>
              `<button type="button" class="time-tracker-cat-btn ${current && current.category === c.key ? "time-tracker-cat-btn-active" : ""}" data-key="${c.key}">${escapeHtml(c.label)}</button>`
          ).join("")}
        </div>
        <div class="time-tracker-instant">
          <div class="time-tracker-instant-label">Quick log</div>
          <div class="time-tracker-instant-buttons">
            ${INSTANT_LOG_CATEGORIES.map(
              (c) =>
                `<button type="button" class="time-tracker-instant-btn" data-key="${c.key}">${escapeHtml(c.label)} <span class="time-tracker-instant-min">${c.minutes} min</span></button>`
            ).join("")}
          </div>
          ${
            lastInstantEntry
              ? `
            <div class="time-tracker-instant-confirm">
              <p class="time-tracker-instant-confirm-text">
                &#10003; Logged ${escapeHtml(instantCategoryDef(lastInstantEntry.category)?.label || lastInstantEntry.category)}
                &middot; ${instantCategoryDef(lastInstantEntry.category)?.minutes ?? ""} min
              </p>
              <input type="text" class="time-tracker-instant-ref" placeholder="Reference # (Request #, Maximo #...)" value="${escapeHtml(lastInstantEntry.note || "")}" />
              <div class="time-tracker-po-link">
                ${
                  lastInstantEntry.relatedPoId
                    ? `<span class="badge badge-approved">PO linked</span> <button type="button" class="btn btn-link time-tracker-instant-po-unlink">Unlink</button>`
                    : `<input type="text" class="time-tracker-instant-po-search" placeholder="Or link a PO (search #, description)..." />
                       <div class="time-tracker-instant-po-results"></div>`
                }
              </div>
              <button type="button" class="btn btn-link time-tracker-instant-dismiss">Done</button>
            </div>
          `
              : ""
          }
        </div>
        ${
          current
            ? `
          <div class="time-tracker-details">
            <textarea class="time-tracker-note" placeholder="Note (optional)">${escapeHtml(current.note || "")}</textarea>
            <div class="time-tracker-po-link">
              ${
                current.relatedPoId
                  ? `<span class="badge badge-approved">PO linked</span> <button type="button" class="btn btn-link time-tracker-po-unlink">Unlink</button>`
                  : `<input type="text" class="time-tracker-po-search" placeholder="Link a PO (search #, description)..." />
                     <div class="time-tracker-po-results"></div>`
              }
            </div>
            <button type="button" class="btn btn-secondary time-tracker-stop-btn">Stop</button>
          </div>
        `
            : `<p class="time-tracker-idle-hint">Pick what you're working on -- clicking a new one auto-switches.</p>`
        }
      </div>
    `;

    el.querySelector(".time-tracker-tab").addEventListener("click", () => {
      expanded = !expanded;
      render();
    });

    el.querySelectorAll(".time-tracker-cat-btn").forEach((btn) => {
      btn.addEventListener("click", () => startCategory(btn.dataset.key));
    });

    el.querySelectorAll(".time-tracker-instant-btn").forEach((btn) => {
      btn.addEventListener("click", () => logInstant(btn.dataset.key));
    });

    const instantRefInput = el.querySelector(".time-tracker-instant-ref");
    if (instantRefInput) {
      instantRefInput.addEventListener("input", () => {
        clearTimeout(instantNoteSaveTimer);
        instantNoteSaveTimer = setTimeout(() => saveInstantDetails({ note: instantRefInput.value }), 700);
      });
      instantRefInput.addEventListener("blur", () => {
        clearTimeout(instantNoteSaveTimer);
        saveInstantDetails({ note: instantRefInput.value });
      });
    }

    const instantPoSearchInput = el.querySelector(".time-tracker-instant-po-search");
    if (instantPoSearchInput) {
      instantPoSearchInput.addEventListener("input", () => {
        clearTimeout(instantPoSearchTimer);
        const q = instantPoSearchInput.value;
        instantPoSearchTimer = setTimeout(() => searchInstantPos(q), 300);
      });
    }
    const instantPoUnlinkBtn = el.querySelector(".time-tracker-instant-po-unlink");
    if (instantPoUnlinkBtn) {
      instantPoUnlinkBtn.addEventListener("click", async () => {
        await saveInstantDetails({ relatedPoId: null });
        render();
      });
    }
    const instantDismissBtn = el.querySelector(".time-tracker-instant-dismiss");
    if (instantDismissBtn) {
      instantDismissBtn.addEventListener("click", () => {
        lastInstantEntry = null;
        render();
      });
    }

    const stopBtn = el.querySelector(".time-tracker-stop-btn");
    if (stopBtn) stopBtn.addEventListener("click", stopCurrent);

    const noteInput = el.querySelector(".time-tracker-note");
    if (noteInput) {
      noteInput.addEventListener("input", () => {
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(() => saveCurrentDetails({ note: noteInput.value }), 700);
      });
      noteInput.addEventListener("blur", () => {
        clearTimeout(noteSaveTimer);
        saveCurrentDetails({ note: noteInput.value });
      });
    }

    const poSearchInput = el.querySelector(".time-tracker-po-search");
    if (poSearchInput) {
      poSearchInput.addEventListener("input", () => {
        clearTimeout(poSearchTimer);
        const q = poSearchInput.value;
        poSearchTimer = setTimeout(() => searchPos(q), 300);
      });
    }
    const poUnlinkBtn = el.querySelector(".time-tracker-po-unlink");
    if (poUnlinkBtn) {
      poUnlinkBtn.addEventListener("click", async () => {
        await saveCurrentDetails({ relatedPoId: null });
        render();
      });
    }

    if (current) startTicking();
  }

  render();
  refreshCurrent();
  return el;
}

// Mirrors db.js's TIME_LOG_CATEGORIES exactly (fixed, not fetched at
// startup, so the widget renders instantly rather than waiting on a round
// trip before showing anything).
const TIME_LOG_CATEGORIES = [
  { key: "po_invoice", label: "PO / Invoice (unplanned)" },
  { key: "vendor_onboarding", label: "Vendor Onboarding" },
  { key: "timekeeping", label: "Timekeeping Review" },
  { key: "project_status", label: "Project Status Review" },
  { key: "ops_meeting", label: "Operations Meeting" },
  { key: "safety_meeting", label: "Safety Meeting" },
  { key: "reclasses", label: "Reclasses" },
  { key: "coi_renewals", label: "COI Renewals" },
  { key: "employee_support", label: "Employee Support" },
  { key: "invoicing", label: "Invoicing" },
  { key: "documents", label: "Document Management" },
  { key: "general", label: "General / Other" },
];

// Mirrors db.js's INSTANT_LOG_CATEGORIES exactly.
const INSTANT_LOG_CATEGORIES = [
  { key: "po_entered_tech_ordered", label: "PO Entered (Tech Ordered)", minutes: 2 },
  { key: "po_attached_tracker", label: "Attach PO to Tracker", minutes: 1 },
];
