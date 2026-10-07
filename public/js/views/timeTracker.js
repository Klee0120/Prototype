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
