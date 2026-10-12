import {
  TIME_LOG_CATEGORIES,
  INSTANT_LOG_CATEGORIES,
  ESTIMATED_LOG_CATEGORIES,
  STALE_WARNING_SECONDS,
  getSession,
  setSession,
  setCachedCurrent,
  apiRequest,
  formatElapsed,
} from "./shared.js";

const root = document.getElementById("root");
const logoutBtn = document.getElementById("logout-btn");

let session = null; // { token, id, name, role, homeLocationCode }
let current = null; // the running entry, or null
let tickTimer = null;

// The category a click has "armed" but not yet started -- see popup.html's
// own comment-free flow below, mirrored exactly from timeTracker.js's
// mountTimeTracker (same reasoning: nothing starts on a single click
// anymore, a forgotten Stop shouldn't be possible to repeat).
let armedCategory = null;
let resolvingStop = null; // the entry being stopped, once a link is required
let afterStartCategory = null;
let resolveSearchResults = [];
let resolveSearchTimer = null;
let resolveFreeText = "";

let poSearchResults = [];
let poSearchTimer = null;

let lastInstantEntry = null;
let instantNoteSaveTimer = null;
let instantPoSearchResults = [];
let instantPoSearchTimer = null;

let techListCache = null;
let techSearchResults = [];
let techSearchQuery = "";

let vendorListCache = null;

const estimatedFormState = {}; // { [key]: { minutes, note } }
function estimatedState(key) {
  if (!estimatedFormState[key]) estimatedFormState[key] = { minutes: "", note: "" };
  return estimatedFormState[key];
}
let estimatedSaveMessage = "";

let recentEntries = [];
let recentEditingId = null;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notifyBadge() {
  chrome.runtime.sendMessage({ type: "serviceworks:refresh-badge" }).catch(() => {});
}

function categoryDef(key) {
  return TIME_LOG_CATEGORIES.find((c) => c.key === key) || null;
}
function categoryLabel(key) {
  return categoryDef(key)?.label || key;
}
function categoryTracksTech(key) {
  return Boolean(categoryDef(key)?.tracksTech);
}
function categoryTracksPo(key) {
  return Boolean(categoryDef(key)?.tracksPo);
}
function categoryTracksVendor(key) {
  return Boolean(categoryDef(key)?.tracksVendor);
}
function categoryRequiresLink(key) {
  return categoryTracksPo(key) || categoryTracksVendor(key);
}
function instantCategoryDef(key) {
  return INSTANT_LOG_CATEGORIES.find((c) => c.key === key) || null;
}

function liveElapsedSeconds() {
  if (!current) return 0;
  return (Date.now() - new Date(current.startedAt).getTime()) / 1000;
}
function isStale() {
  return Boolean(current) && liveElapsedSeconds() > STALE_WARNING_SECONDS;
}

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function formatDateTime(iso) {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    const pill = document.querySelector(".current-elapsed");
    if (pill) pill.textContent = formatElapsed(liveElapsedSeconds());
    const card = document.querySelector(".current-card");
    if (card) card.classList.toggle("current-card-stale", isStale());
    if (isStale() && !document.querySelector(".stale-banner")) renderApp();
  }, 1000);
}
function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

// ---- auth ----

async function init() {
  session = await getSession();
  if (session && session.role === "admin") {
    logoutBtn.hidden = false;
    renderApp();
    refreshCurrent();
    refreshRecent();
  } else {
    session = null;
    logoutBtn.hidden = true;
    renderLogin();
  }
}

function renderLogin(errorMessage) {
  root.innerHTML = `
    <form id="login-form" class="login-form">
      <label for="login-id">Employee ID</label>
      <input id="login-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <label for="login-pin">PIN</label>
      <input id="login-pin" name="pin" type="password" autocomplete="current-password" placeholder="Enter your PIN" required />
      <button type="submit" class="btn btn-primary">Log in</button>
      ${errorMessage ? `<p class="form-error">${escapeHtml(errorMessage)}</p>` : ""}
      <p class="form-hint">Admin accounts only -- this widget tracks your own time against ServiceWorks.</p>
    </form>
  `;
  const form = document.getElementById("login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = form.id.value.trim();
    const pin = form.pin.value.trim();
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const user = await apiRequest("POST", "/api/auth/login", { id, pin });
      if (user.role !== "admin") {
        renderLogin("This widget is for admin accounts only.");
        return;
      }
      session = user;
      await setSession(session);
      logoutBtn.hidden = false;
      renderApp();
      refreshCurrent();
      refreshRecent();
    } catch (err) {
      renderLogin(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

logoutBtn.addEventListener("click", async () => {
  session = null;
  current = null;
  await setSession(null);
  await setCachedCurrent(null);
  logoutBtn.hidden = true;
  notifyBadge();
  renderLogin();
});

// ---- data actions ----

async function refreshCurrent() {
  try {
    current = await apiRequest("GET", "/api/admin/time-log/current", undefined, session.token);
  } catch {
    current = null;
  }
  await setCachedCurrent(current);
  notifyBadge();
  renderApp();
}

async function refreshRecent() {
  try {
    const all = await apiRequest("GET", "/api/admin/time-log", undefined, session.token);
    recentEntries = (Array.isArray(all) ? all : []).filter((e) => e.endedAt).slice(0, 8);
  } catch {
    recentEntries = [];
  }
}

async function startCategory(key) {
  try {
    current = await apiRequest("POST", "/api/admin/time-log/start", { category: key }, session.token);
    armedCategory = null;
    await setCachedCurrent(current);
    notifyBadge();
    renderApp();
  } catch (err) {
    window.alert(err.message);
  }
}

async function stopCurrent(fields = {}) {
  try {
    await apiRequest("POST", "/api/admin/time-log/stop", fields, session.token);
    current = null;
    resolvingStop = null;
    resolveFreeText = "";
    resolveSearchResults = [];
    await setCachedCurrent(null);
    notifyBadge();
    refreshRecent();
    if (afterStartCategory) {
      const next = afterStartCategory;
      afterStartCategory = null;
      await startCategory(next);
    } else {
      armedCategory = null;
      renderApp();
    }
  } catch (err) {
    window.alert(err.message);
  }
}

function requestStop(continueToCategory) {
  if (!current) return;
  afterStartCategory = continueToCategory || null;
  const needsLink = categoryRequiresLink(current.category) && !current.relatedPoId && !current.relatedVendorId;
  if (!needsLink) {
    stopCurrent();
    return;
  }
  resolvingStop = current;
  resolveFreeText = "";
  resolveSearchResults = [];
  renderApp();
}

function cancelResolveStop() {
  resolvingStop = null;
  afterStartCategory = null;
  armedCategory = null;
  resolveFreeText = "";
  resolveSearchResults = [];
  renderApp();
}

function armCategory(key) {
  armedCategory = armedCategory === key ? null : key;
  renderApp();
}

function confirmStart() {
  if (!armedCategory) return;
  if (current && current.category !== armedCategory) {
    requestStop(armedCategory);
  } else {
    startCategory(armedCategory);
  }
}

async function saveCurrentDetails(fields) {
  if (!current) return;
  try {
    const updated = await apiRequest("PATCH", `/api/admin/time-log/${current.id}`, fields, session.token);
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
    const results = await apiRequest("GET", `/api/admin/pos?${new URLSearchParams({ search: query })}`, undefined, session.token);
    poSearchResults = Array.isArray(results) ? results : [];
  } catch {
    poSearchResults = [];
  }
  renderPoResults();
}

function renderPoResults() {
  const host = document.querySelector(".po-results");
  if (!host) return;
  if (poSearchResults.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="search-results">${poSearchResults
    .slice(0, 6)
    .map(
      (p) =>
        `<button type="button" class="search-result-btn" data-id="${p.id}">${escapeHtml(p.poNumber || "PO")} ${
          p.description ? `&mdash; ${escapeHtml(p.description)}` : ""
        }</button>`
    )
    .join("")}</div>`;
  host.querySelectorAll(".search-result-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await saveCurrentDetails({ relatedPoId: Number(btn.dataset.id) });
      renderApp();
    });
  });
}

async function ensureTechList() {
  if (techListCache) return techListCache;
  try {
    const all = await apiRequest("GET", "/api/admin/technicians", undefined, session.token);
    techListCache = (Array.isArray(all) ? all : []).filter((t) => t.employmentStatus === "active");
  } catch {
    techListCache = [];
  }
  return techListCache;
}
function techName(id) {
  const t = (techListCache || []).find((tech) => tech.id === id);
  return t ? t.name : id;
}
async function searchTechs(query) {
  techSearchQuery = query;
  const list = await ensureTechList();
  const q = query.trim().toLowerCase();
  techSearchResults = q ? list.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)) : list;
  renderTechResults();
}
function renderTechResults() {
  const host = document.querySelector(".tech-results");
  if (!host) return;
  host.innerHTML = `<div class="search-results">${techSearchResults
    .slice(0, 6)
    .map((t) => `<button type="button" class="search-result-btn" data-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>`)
    .join("")}</div>`;
  host.querySelectorAll(".search-result-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await saveCurrentDetails({ relatedTechId: btn.dataset.id });
      renderApp();
    });
  });
}

async function ensureVendorList() {
  if (vendorListCache) return vendorListCache;
  try {
    const all = await apiRequest("GET", "/api/admin/vendors", undefined, session.token);
    vendorListCache = Array.isArray(all) ? all : [];
  } catch {
    vendorListCache = [];
  }
  return vendorListCache;
}
async function searchVendorsLocal(query) {
  const list = await ensureVendorList();
  const q = query.trim().toLowerCase();
  return q ? list.filter((v) => v.name.toLowerCase().includes(q)) : list;
}

async function logInstant(key) {
  try {
    lastInstantEntry = await apiRequest("POST", "/api/admin/time-log/instant", { category: key }, session.token);
    instantPoSearchResults = [];
    renderApp();
  } catch (err) {
    window.alert(err.message);
  }
}
async function saveInstantDetails(fields) {
  if (!lastInstantEntry) return;
  try {
    const updated = await apiRequest("PATCH", `/api/admin/time-log/${lastInstantEntry.id}`, fields, session.token);
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
    const results = await apiRequest("GET", `/api/admin/pos?${new URLSearchParams({ search: query })}`, undefined, session.token);
    instantPoSearchResults = Array.isArray(results) ? results : [];
  } catch {
    instantPoSearchResults = [];
  }
  renderInstantPoResults();
}
function renderInstantPoResults() {
  const host = document.querySelector(".instant-po-results");
  if (!host) return;
  if (instantPoSearchResults.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<div class="search-results">${instantPoSearchResults
    .slice(0, 6)
    .map(
      (p) =>
        `<button type="button" class="search-result-btn" data-id="${p.id}">${escapeHtml(p.poNumber || "PO")} ${
          p.description ? `&mdash; ${escapeHtml(p.description)}` : ""
        }</button>`
    )
    .join("")}</div>`;
  host.querySelectorAll(".search-result-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await saveInstantDetails({ relatedPoId: Number(btn.dataset.id) });
      renderApp();
    });
  });
}

async function logEstimated(key) {
  const form = estimatedState(key);
  const minutes = Number(form.minutes);
  if (!form.minutes || !Number.isFinite(minutes) || minutes <= 0) {
    estimatedSaveMessage = "Enter a number of minutes greater than 0.";
    renderApp();
    return;
  }
  try {
    await apiRequest("POST", "/api/admin/time-log/estimated", { category: key, minutes, note: form.note }, session.token);
    form.minutes = "";
    form.note = "";
    estimatedSaveMessage = `Logged ${minutes} min.`;
    refreshRecent();
    renderApp();
  } catch (err) {
    estimatedSaveMessage = err.message;
    renderApp();
  }
}

async function saveRecentEdit(entryId, startInput, endInput) {
  const startedAt = fromLocalInputValue(startInput.value);
  const endedAt = fromLocalInputValue(endInput.value);
  if (!startedAt || !endedAt) {
    window.alert("Enter valid start and end times.");
    return;
  }
  try {
    await apiRequest("PATCH", `/api/admin/time-log/${entryId}`, { startedAt, endedAt }, session.token);
    recentEditingId = null;
    await refreshRecent();
    renderApp();
  } catch (err) {
    window.alert(err.message);
  }
}

// ---- render ----

function renderResolveForm() {
  const cat = categoryDef(resolvingStop.category);
  const isVendor = cat.tracksVendor;
  return `
    <div class="card">
      <p class="card-title">Link before stopping</p>
      <p class="resolve-text">Before stopping <strong>${escapeHtml(cat.label)}</strong>, link it to ${isVendor ? "a vendor" : "a PO"} to sync it.</p>
      <input type="text" class="link-search-input resolve-search-input" placeholder="${isVendor ? "Search vendor name..." : "Search PO # or description..."}" />
      <div class="resolve-results"></div>
      ${
        !isVendor
          ? `<p class="resolve-or">No matching PO? Describe it instead:</p>
             <input type="text" class="link-search-input resolve-freetext-input" placeholder="PO description or code..." value="${escapeHtml(resolveFreeText)}" />`
          : ""
      }
      <div class="resolve-actions">
        <button type="button" class="btn btn-primary resolve-confirm-btn" ${!isVendor && !resolveFreeText.trim() ? "disabled" : ""}>Stop &amp; save</button>
        <button type="button" class="btn btn-secondary resolve-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
}
function renderResolveResults() {
  const host = document.querySelector(".resolve-results");
  if (!host) return;
  const isVendor = categoryDef(resolvingStop.category).tracksVendor;
  host.innerHTML =
    resolveSearchResults.length === 0
      ? ""
      : `<div class="search-results">${resolveSearchResults
          .slice(0, 6)
          .map((r) =>
            isVendor
              ? `<button type="button" class="search-result-btn resolve-pick-btn" data-id="${r.id}">${escapeHtml(r.name)}</button>`
              : `<button type="button" class="search-result-btn resolve-pick-btn" data-id="${r.id}">${escapeHtml(r.poNumber || "PO")} ${
                  r.description ? `&mdash; ${escapeHtml(r.description)}` : ""
                }</button>`
          )
          .join("")}</div>`;
  host.querySelectorAll(".resolve-pick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopCurrent(isVendor ? { relatedVendorId: Number(btn.dataset.id) } : { relatedPoId: Number(btn.dataset.id) });
    });
  });
}

function renderApp() {
  stopTicking();

  if (resolvingStop) {
    root.innerHTML = `<p class="user-row">Signed in as ${escapeHtml(session.name || session.id)}</p>${renderResolveForm()}`;
    const searchInput = document.querySelector(".resolve-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(resolveSearchTimer);
        const q = searchInput.value;
        const isVendor = categoryDef(resolvingStop.category).tracksVendor;
        resolveSearchTimer = setTimeout(async () => {
          if (isVendor) {
            resolveSearchResults = await searchVendorsLocal(q);
          } else if (q.trim()) {
            try {
              const results = await apiRequest("GET", `/api/admin/pos?${new URLSearchParams({ search: q })}`, undefined, session.token);
              resolveSearchResults = Array.isArray(results) ? results : [];
            } catch {
              resolveSearchResults = [];
            }
          } else {
            resolveSearchResults = [];
          }
          renderResolveResults();
        }, 250);
      });
    }
    renderResolveResults();
    const freeTextInput = document.querySelector(".resolve-freetext-input");
    if (freeTextInput) {
      freeTextInput.addEventListener("input", () => {
        resolveFreeText = freeTextInput.value;
        const confirmBtn = document.querySelector(".resolve-confirm-btn");
        if (confirmBtn) confirmBtn.disabled = !resolveFreeText.trim();
      });
    }
    document.querySelector(".resolve-confirm-btn")?.addEventListener("click", () => {
      const isVendor = categoryDef(resolvingStop.category).tracksVendor;
      if (isVendor) return;
      stopCurrent({ note: resolveFreeText.trim() });
    });
    document.querySelector(".resolve-cancel-btn")?.addEventListener("click", cancelResolveStop);
    if (current) startTicking();
    return;
  }

  const stale = isStale();

  root.innerHTML = `
    <p class="user-row">Signed in as ${escapeHtml(session.name || session.id)}</p>

    <div class="card current-card ${stale ? "current-card-stale" : ""}">
      ${
        current
          ? `
        ${stale ? `<p class="stale-banner">&#9888; Still working on this? Started ${formatClock(current.startedAt)}. Auto-stops after 12h.</p>` : ""}
        <div class="current-row">
          <span class="current-category">${escapeHtml(categoryLabel(current.category))}</span>
          <span class="current-elapsed">${formatElapsed(liveElapsedSeconds())}</span>
        </div>
        <textarea class="note-input" placeholder="Note (optional)">${escapeHtml(current.note || "")}</textarea>
        ${
          categoryTracksTech(current.category)
            ? `
          <div class="link-block">
            ${
              current.relatedTechId
                ? `<span class="badge">Tech: ${escapeHtml(techName(current.relatedTechId))}</span> <button type="button" class="btn btn-secondary tech-unlink-btn">Unlink</button>`
                : `<input type="text" class="link-search-input tech-search-input" placeholder="Assign a tech (search name/ID)..." /><div class="tech-results"></div>`
            }
          </div>
        `
            : ""
        }
        ${
          categoryTracksPo(current.category)
            ? `
          <div class="link-block">
            ${
              current.relatedPoId
                ? `<span class="badge">PO linked</span> <button type="button" class="btn btn-secondary po-unlink-btn">Unlink</button>`
                : `<input type="text" class="link-search-input po-search-input" placeholder="Link a PO (search #, description)..." /><div class="po-results"></div>`
            }
          </div>
        `
            : ""
        }
        <button type="button" class="btn btn-secondary stop-btn">Stop</button>
      `
          : `<p class="card-title">Pick what you're working on</p>
             <div class="cat-grid">
               ${TIME_LOG_CATEGORIES.map(
                 (c) => `<button type="button" class="cat-btn ${armedCategory === c.key ? "cat-btn-armed" : ""}" data-key="${c.key}">${escapeHtml(c.label)}</button>`
               ).join("")}
             </div>`
      }
      ${
        armedCategory
          ? `<button type="button" class="btn btn-primary start-btn" style="margin-top:8px;width:100%;">Start tracking: ${escapeHtml(categoryLabel(armedCategory))}</button>`
          : current
            ? ""
            : `<p class="idle-hint" style="margin-top:8px;">Pick a category, then confirm Start.</p>`
      }
    </div>

    ${
      current
        ? `
      <div class="card">
        <p class="card-title">Switch to</p>
        <div class="cat-grid">
          ${TIME_LOG_CATEGORIES.map(
            (c) =>
              `<button type="button" class="cat-btn ${current.category === c.key ? "cat-btn-active" : ""} ${
                armedCategory === c.key ? "cat-btn-armed" : ""
              }" data-key="${c.key}">${escapeHtml(c.label)}</button>`
          ).join("")}
        </div>
        ${
          armedCategory && armedCategory !== current.category
            ? `<button type="button" class="btn btn-primary start-btn" style="margin-top:8px;width:100%;">Start tracking: ${escapeHtml(categoryLabel(armedCategory))}</button>`
            : ""
        }
      </div>
    `
        : ""
    }

    <div class="card">
      <p class="card-title">Quick log</p>
      <div class="instant-grid">
        ${INSTANT_LOG_CATEGORIES.map(
          (c) => `<button type="button" class="instant-btn" data-key="${c.key}"><span>${escapeHtml(c.label)}</span><span class="instant-min">${c.minutes} min</span></button>`
        ).join("")}
      </div>
      ${
        lastInstantEntry
          ? `
        <div class="instant-confirm">
          <p class="instant-confirm-text">&#10003; Logged ${escapeHtml(instantCategoryDef(lastInstantEntry.category)?.label || lastInstantEntry.category)} &middot; ${
              instantCategoryDef(lastInstantEntry.category)?.minutes ?? ""
            } min</p>
          <input type="text" class="link-search-input instant-ref-input" placeholder="Reference # (Request #, Maximo #...)" value="${escapeHtml(lastInstantEntry.note || "")}" />
          <div class="link-block">
            ${
              lastInstantEntry.relatedPoId
                ? `<span class="badge">PO linked</span> <button type="button" class="btn btn-secondary instant-po-unlink-btn">Unlink</button>`
                : `<input type="text" class="link-search-input instant-po-search-input" placeholder="Or link a PO (search #, description)..." /><div class="instant-po-results"></div>`
            }
          </div>
          <button type="button" class="btn btn-secondary instant-dismiss-btn">Done</button>
        </div>
      `
          : ""
      }
    </div>

    <div class="card">
      <p class="card-title">End of day log</p>
      ${ESTIMATED_LOG_CATEGORIES.map(
        (c) => `
        <div class="estimated-row" data-key="${c.key}">
          <span class="estimated-cat">${escapeHtml(c.label)}</span>
          <div class="estimated-inputs">
            <input type="number" class="estimated-minutes-input" data-key="${c.key}" placeholder="Minutes" min="1" step="1" value="${escapeHtml(estimatedState(c.key).minutes)}" />
            <input type="text" class="estimated-note-input" data-key="${c.key}" placeholder="Note (optional)" value="${escapeHtml(estimatedState(c.key).note)}" />
            <button type="button" class="btn btn-secondary estimated-log-btn" data-key="${c.key}">Log</button>
          </div>
        </div>
      `
      ).join("")}
      ${estimatedSaveMessage ? `<p class="message">${escapeHtml(estimatedSaveMessage)}</p>` : ""}
    </div>

    ${
      recentEntries.length > 0
        ? `
      <div class="card">
        <p class="card-title">Recent entries</p>
        ${recentEntries
          .map((e) =>
            recentEditingId === e.id
              ? `
            <div class="recent-row recent-editing" data-id="${e.id}">
              <span class="recent-cat">${escapeHtml(categoryLabel(e.category))}</span>
              <input type="datetime-local" class="recent-start-input" value="${toLocalInputValue(e.startedAt)}" />
              <input type="datetime-local" class="recent-end-input" value="${toLocalInputValue(e.endedAt)}" />
              <div class="estimated-inputs">
                <button type="button" class="btn btn-secondary recent-save-btn">Save</button>
                <button type="button" class="btn btn-secondary recent-cancel-btn">Cancel</button>
              </div>
            </div>
          `
              : `
            <div class="recent-row" data-id="${e.id}">
              <span class="recent-cat">${escapeHtml(categoryLabel(e.category))}</span>
              <span class="recent-range">${formatDateTime(e.startedAt)}&ndash;${formatClock(e.endedAt)} (${formatElapsed(e.durationSeconds)})</span>
              <button type="button" class="btn btn-secondary recent-edit-btn">Edit times</button>
            </div>
          `
          )
          .join("")}
      </div>
    `
        : ""
    }
  `;

  wireApp();
  if (current) startTicking();
}

function wireApp() {
  document.querySelectorAll(".cat-btn").forEach((btn) => btn.addEventListener("click", () => armCategory(btn.dataset.key)));
  document.querySelector(".start-btn")?.addEventListener("click", confirmStart);
  document.querySelectorAll(".instant-btn").forEach((btn) => btn.addEventListener("click", () => logInstant(btn.dataset.key)));

  const stopBtn = document.querySelector(".stop-btn");
  if (stopBtn) stopBtn.addEventListener("click", () => requestStop());

  let noteSaveTimer = null;
  const noteInput = document.querySelector(".note-input");
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

  const poSearchInput = document.querySelector(".po-search-input");
  if (poSearchInput) {
    poSearchInput.addEventListener("input", () => {
      clearTimeout(poSearchTimer);
      const q = poSearchInput.value;
      poSearchTimer = setTimeout(() => searchPos(q), 300);
    });
  }
  const poUnlinkBtn = document.querySelector(".po-unlink-btn");
  if (poUnlinkBtn) poUnlinkBtn.addEventListener("click", async () => { await saveCurrentDetails({ relatedPoId: null }); renderApp(); });

  const techSearchInput = document.querySelector(".tech-search-input");
  if (techSearchInput) {
    searchTechs(techSearchQuery);
    techSearchInput.addEventListener("input", () => searchTechs(techSearchInput.value));
  }
  const techUnlinkBtn = document.querySelector(".tech-unlink-btn");
  if (techUnlinkBtn) techUnlinkBtn.addEventListener("click", async () => { await saveCurrentDetails({ relatedTechId: null }); renderApp(); });

  const instantRefInput = document.querySelector(".instant-ref-input");
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
  const instantPoSearchInput = document.querySelector(".instant-po-search-input");
  if (instantPoSearchInput) {
    instantPoSearchInput.addEventListener("input", () => {
      clearTimeout(instantPoSearchTimer);
      const q = instantPoSearchInput.value;
      instantPoSearchTimer = setTimeout(() => searchInstantPos(q), 300);
    });
  }
  const instantPoUnlinkBtn = document.querySelector(".instant-po-unlink-btn");
  if (instantPoUnlinkBtn) instantPoUnlinkBtn.addEventListener("click", async () => { await saveInstantDetails({ relatedPoId: null }); renderApp(); });
  const instantDismissBtn = document.querySelector(".instant-dismiss-btn");
  if (instantDismissBtn) instantDismissBtn.addEventListener("click", () => { lastInstantEntry = null; renderApp(); });

  document.querySelectorAll(".estimated-minutes-input").forEach((input) => {
    input.addEventListener("input", () => { estimatedState(input.dataset.key).minutes = input.value; });
  });
  document.querySelectorAll(".estimated-note-input").forEach((input) => {
    input.addEventListener("input", () => { estimatedState(input.dataset.key).note = input.value; });
  });
  document.querySelectorAll(".estimated-log-btn").forEach((btn) => {
    btn.addEventListener("click", () => logEstimated(btn.dataset.key));
  });

  document.querySelectorAll(".recent-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      recentEditingId = Number(btn.closest(".recent-row").dataset.id);
      renderApp();
    });
  });
  document.querySelectorAll(".recent-cancel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      recentEditingId = null;
      renderApp();
    });
  });
  document.querySelectorAll(".recent-save-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".recent-row");
      const id = Number(row.dataset.id);
      saveRecentEdit(id, row.querySelector(".recent-start-input"), row.querySelector(".recent-end-input"));
    });
  });
}

init();
