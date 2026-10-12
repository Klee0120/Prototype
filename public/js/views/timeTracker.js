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
// Interaction model, revised after Krista found a timer that had run for
// 24+ hours unattended:
// - Nothing starts on a single click anymore. Clicking a category only
//   "arms" it (highlights it); a separate, deliberate "Start tracking"
//   click actually begins the clock -- same reasoning as the existing
//   deliberate Stop, now applied symmetrically to Start.
// - Stopping a category that tracks a PO or a vendor (TIME_LOG_CATEGORIES'
//   tracksPo/tracksVendor flags) requires resolving that link first --
//   search-and-select a real PO/vendor, or (PO only) type a free-text
//   description if no PO record exists yet. If it's already linked (set
//   earlier while running), Stop just stops immediately, no re-prompt.
//   Switching categories while one of these is running goes through the
//   same resolution before the new category is allowed to start, since a
//   switch silently stops the old one exactly like an explicit Stop would.
// - A running entry past STALE_WARNING_SECONDS gets a visible warning
//   (amber tab/banner) so a forgotten timer is impossible to miss instead
//   of silently ticking in the background -- backed up server-side by a
//   hard 12h auto-stop cap (see db.js's getRunningTimeLogEntry).
// - A short "Recent entries" list at the bottom lets a bad entry (the
//   auto-stopped-after-12h case, or a fat-fingered Stop) be corrected
//   after the fact via PATCH's startedAt/endedAt support.
export function mountTimeTracker() {
  if (!state.user || state.user.role !== "admin") return null;

  const el = document.createElement("div");
  el.className = "time-tracker";
  let current = null; // the running entry, or null
  let expanded = false;
  let tickTimer = null;

  // The category a click has "armed" but not yet started -- idle, or
  // mid-switch while something else is running. Cleared once Start is
  // clicked (or the whole thing is cancelled).
  let armedCategory = null;
  // Set while resolving the required PO/vendor link before a stop can go
  // through -- either an explicit Stop click, or a switch away from a
  // PO/vendor-tracking category. `afterStartCategory` is only set in the
  // switch case, so the resolved stop can chain straight into starting it.
  let resolvingStop = null; // the entry being stopped, or null
  let afterStartCategory = null;
  let resolveSearchResults = [];
  let resolveSearchTimer = null;
  let resolveFreeText = "";

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
  // The active technician roster, fetched once and filtered client-side as
  // the admin types -- same pattern as pos.js's vendor picker, and small
  // enough (unlike POs) that a server round trip per keystroke isn't worth it.
  let techListCache = null;
  let techSearchResults = [];
  let techSearchQuery = "";
  // Same pattern for the vendor picker used by tracksVendor categories.
  let vendorListCache = null;
  // End-of-day form state, keyed by category -- a plain object (not two flat
  // strings) so this stays correct if ESTIMATED_LOG_CATEGORIES ever grows
  // past the one category it has today.
  const estimatedFormState = {}; // { [key]: { minutes, note } }
  function estimatedState(key) {
    if (!estimatedFormState[key]) estimatedFormState[key] = { minutes: "", note: "" };
    return estimatedFormState[key];
  }
  let estimatedSaveMessage = "";

  // A running entry past this long gets the stale-timer warning styling.
  // The server's own 12h hard cap (db.js's MAX_RUNNING_MINUTES) is the
  // real backstop; this is just the earlier, softer heads-up.
  const STALE_WARNING_SECONDS = 2 * 60 * 60;

  let recentEntries = [];
  let recentEditingId = null;

  function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function formatClock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatDateTime(iso) {
    return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm", and
  // hands back the same -- no timezone suffix either way, so this just
  // does the local-component formatting/parsing by hand rather than
  // (mis)using toISOString, which is UTC.
  function toLocalInputValue(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocalInputValue(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(() => {
      const pill = el.querySelector(".time-tracker-elapsed");
      if (pill) pill.textContent = formatElapsed(liveElapsedSeconds());
      // The stale threshold is crossed mid-tick, not on a fresh render, so
      // flip the warning styling live instead of waiting for the next
      // unrelated re-render to notice.
      const card = el.querySelector(".time-tracker-current");
      if (card) card.classList.toggle("time-tracker-current-stale", isStale());
      const banner = el.querySelector(".time-tracker-stale-banner");
      if (isStale() && !banner) render();
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

  async function refreshRecent() {
    try {
      const all = await api.get("/api/admin/time-log");
      recentEntries = (Array.isArray(all) ? all : []).filter((e) => e.endedAt).slice(0, 8);
    } catch {
      recentEntries = [];
    }
  }

  async function startCategory(key) {
    try {
      current = await api.post("/api/admin/time-log/start", { category: key });
      armedCategory = null;
      render();
    } catch (err) {
      window.alert(err.message);
    }
  }

  // Called once any required PO/vendor link is resolved (or wasn't needed
  // in the first place). fields carries the resolved relatedPoId/note or
  // relatedVendorId to save at stop time.
  async function stopCurrent(fields = {}) {
    try {
      await api.post("/api/admin/time-log/stop", fields);
      current = null;
      resolvingStop = null;
      resolveFreeText = "";
      resolveSearchResults = [];
      refreshRecent();
      if (afterStartCategory) {
        const next = afterStartCategory;
        afterStartCategory = null;
        await startCategory(next);
      } else {
        armedCategory = null;
        render();
      }
    } catch (err) {
      window.alert(err.message);
    }
  }

  // Entry point for both the explicit Stop button and a switch-triggered
  // implicit stop. Skips the resolution step entirely if the category
  // doesn't require a link, or it's already been linked while running.
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
    render();
  }

  function cancelResolveStop() {
    resolvingStop = null;
    afterStartCategory = null;
    armedCategory = null;
    resolveFreeText = "";
    resolveSearchResults = [];
    render();
  }

  async function confirmResolveStop(fields) {
    await stopCurrent(fields);
  }

  function armCategory(key) {
    armedCategory = armedCategory === key ? null : key;
    render();
  }

  // The single place "actually start something" funnels through, whether
  // idle or switching away from a running category -- see requestStop's
  // own comment for why a switch needs the same link-resolution a direct
  // Stop does.
  function confirmStart() {
    if (!armedCategory) return;
    if (current && current.category !== armedCategory) {
      requestStop(armedCategory);
    } else {
      startCategory(armedCategory);
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

  async function ensureTechList() {
    if (techListCache) return techListCache;
    try {
      const all = await api.get("/api/admin/technicians");
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
    const host = el.querySelector(".time-tracker-tech-results");
    if (!host) return;
    host.innerHTML = techSearchResults
      .slice(0, 8)
      .map((t) => `<button type="button" class="time-tracker-po-result" data-id="${escapeHtml(t.id)}">${escapeHtml(t.name)}</button>`)
      .join("");
    host.querySelectorAll(".time-tracker-po-result").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await saveCurrentDetails({ relatedTechId: btn.dataset.id });
        render();
      });
    });
  }

  async function ensureVendorList() {
    if (vendorListCache) return vendorListCache;
    try {
      const all = await api.get("/api/admin/vendors");
      vendorListCache = Array.isArray(all) ? all : [];
    } catch {
      vendorListCache = [];
    }
    return vendorListCache;
  }

  // Shared by both the required-at-stop vendor resolver and (indirectly)
  // anything else that might want a vendor name later -- PO search stays
  // server-side (POs are too numerous for a client-side list), vendors are
  // small enough to fetch once, same reasoning as the tech picker above.
  async function searchVendorsLocal(query) {
    const list = await ensureVendorList();
    const q = query.trim().toLowerCase();
    return q ? list.filter((v) => v.name.toLowerCase().includes(q)) : list;
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

  // Vendor Correspondence's "end of day" log -- a self-reported duration,
  // not timed live (see db.js's logEstimatedTimeEntry). Deliberately
  // independent of `current`, same as the instant logs above.
  async function logEstimated(key) {
    const form = estimatedState(key);
    const minutes = Number(form.minutes);
    if (!form.minutes || !Number.isFinite(minutes) || minutes <= 0) {
      estimatedSaveMessage = "Enter a number of minutes greater than 0.";
      render();
      return;
    }
    try {
      await api.post("/api/admin/time-log/estimated", { category: key, minutes, note: form.note });
      form.minutes = "";
      form.note = "";
      estimatedSaveMessage = `Logged ${minutes} min.`;
      refreshRecent();
      render();
    } catch (err) {
      estimatedSaveMessage = err.message;
      render();
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
      await api.patch(`/api/admin/time-log/${entryId}`, { startedAt, endedAt });
      recentEditingId = null;
      await refreshRecent();
      render();
    } catch (err) {
      window.alert(err.message);
    }
  }

  function renderResolveForm() {
    const cat = categoryDef(resolvingStop.category);
    const isVendor = cat.tracksVendor;
    return `
      <div class="time-tracker-resolve">
        <p class="time-tracker-resolve-title">
          Before stopping <strong>${escapeHtml(cat.label)}</strong>, link it to ${isVendor ? "a vendor" : "a PO"} to sync it.
        </p>
        <input type="text" class="time-tracker-resolve-search" placeholder="${
          isVendor ? "Search vendor name..." : "Search PO # or description..."
        }" />
        <div class="time-tracker-resolve-results">
          ${resolveSearchResults
            .slice(0, 8)
            .map((r) =>
              isVendor
                ? `<button type="button" class="time-tracker-po-result time-tracker-resolve-pick" data-id="${r.id}">${escapeHtml(r.name)}</button>`
                : `<button type="button" class="time-tracker-po-result time-tracker-resolve-pick" data-id="${r.id}">${escapeHtml(r.poNumber || "PO")} ${
                    r.description ? `&mdash; ${escapeHtml(r.description)}` : ""
                  }</button>`
            )
            .join("")}
        </div>
        ${
          !isVendor
            ? `<p class="time-tracker-resolve-or">No matching PO? Describe it instead:</p>
               <input type="text" class="time-tracker-resolve-freetext" placeholder="PO description or code..." value="${escapeHtml(resolveFreeText)}" />`
            : ""
        }
        <div class="time-tracker-resolve-actions">
          <button type="button" class="btn btn-secondary time-tracker-resolve-confirm" ${
            !isVendor && !resolveFreeText.trim() ? "disabled" : ""
          }>Stop &amp; save</button>
          <button type="button" class="btn btn-link time-tracker-resolve-cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  function render() {
    stopTicking();
    const stale = isStale();
    const tabLabel = current
      ? `${escapeHtml(categoryLabel(current.category))} &middot; <span class="time-tracker-elapsed">${formatElapsed(liveElapsedSeconds())}</span>`
      : "Track time";

    el.innerHTML = `
      <div class="time-tracker-tab ${current ? "time-tracker-tab-active" : ""} ${stale ? "time-tracker-tab-stale" : ""}">
        <span class="time-tracker-tab-dot" aria-hidden="true"></span>
        <span class="time-tracker-tab-label">${tabLabel}</span>
        <span class="time-tracker-tab-chevron">${expanded ? "&#9660;" : "&#9650;"}</span>
      </div>
      <div class="time-tracker-panel" ${expanded ? "" : "hidden"}>
        ${
          resolvingStop
            ? renderResolveForm()
            : `
          <div class="time-tracker-categories">
            ${TIME_LOG_CATEGORIES.map(
              (c) =>
                `<button type="button" class="time-tracker-cat-btn ${
                  current && current.category === c.key ? "time-tracker-cat-btn-active" : ""
                } ${armedCategory === c.key ? "time-tracker-cat-btn-armed" : ""}" data-key="${c.key}">${escapeHtml(c.label)}</button>`
            ).join("")}
          </div>
          ${
            armedCategory
              ? `
            <div class="time-tracker-arm-bar">
              <button type="button" class="btn btn-secondary time-tracker-start-btn">Start tracking: ${escapeHtml(categoryLabel(armedCategory))}</button>
            </div>
          `
              : ""
          }
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
          <div class="time-tracker-estimated">
            <div class="time-tracker-instant-label">End of day log</div>
            ${ESTIMATED_LOG_CATEGORIES.map(
              (c) => `
              <div class="time-tracker-estimated-row" data-key="${c.key}">
                <span class="time-tracker-estimated-cat">${escapeHtml(c.label)}</span>
                <input type="number" class="time-tracker-estimated-minutes" data-key="${c.key}" placeholder="Minutes" min="1" step="1" value="${escapeHtml(estimatedState(c.key).minutes)}" />
                <input type="text" class="time-tracker-estimated-note" data-key="${c.key}" placeholder="Note (optional)" value="${escapeHtml(estimatedState(c.key).note)}" />
                <button type="button" class="btn btn-secondary time-tracker-estimated-log-btn" data-key="${c.key}">Log</button>
              </div>
            `
            ).join("")}
            ${estimatedSaveMessage ? `<p class="time-tracker-estimated-message">${escapeHtml(estimatedSaveMessage)}</p>` : ""}
          </div>
          ${
            current
              ? `
            <div class="time-tracker-current ${stale ? "time-tracker-current-stale" : ""}">
              ${
                stale
                  ? `<p class="time-tracker-stale-banner">&#9888; Still working on this? Started ${formatClock(current.startedAt)}. A forgotten timer auto-stops after 12h.</p>`
                  : ""
              }
              <div class="time-tracker-details">
                <textarea class="time-tracker-note" placeholder="Note (optional)">${escapeHtml(current.note || "")}</textarea>
                ${
                  categoryTracksTech(current.category)
                    ? `
                  <div class="time-tracker-po-link">
                    ${
                      current.relatedTechId
                        ? `<span class="badge badge-approved">Tech: ${escapeHtml(techName(current.relatedTechId))}</span> <button type="button" class="btn btn-link time-tracker-tech-unlink">Unlink</button>`
                        : `<input type="text" class="time-tracker-tech-search" placeholder="Assign a tech (search name/ID)..." />
                           <div class="time-tracker-tech-results"></div>`
                    }
                  </div>
                `
                    : ""
                }
                ${
                  categoryTracksPo(current.category)
                    ? `
                  <div class="time-tracker-po-link">
                    ${
                      current.relatedPoId
                        ? `<span class="badge badge-approved">PO linked</span> <button type="button" class="btn btn-link time-tracker-po-unlink">Unlink</button>`
                        : `<input type="text" class="time-tracker-po-search" placeholder="Link a PO (search #, description)..." />
                           <div class="time-tracker-po-results"></div>`
                    }
                  </div>
                `
                    : ""
                }
                <button type="button" class="btn btn-secondary time-tracker-stop-btn">Stop</button>
              </div>
            </div>
          `
              : `<p class="time-tracker-idle-hint">Pick what you're working on, then confirm Start.</p>`
          }
          ${
            recentEntries.length > 0
              ? `
            <div class="time-tracker-recent">
              <div class="time-tracker-instant-label">Recent entries</div>
              ${recentEntries
                .map((e) =>
                  recentEditingId === e.id
                    ? `
                  <div class="time-tracker-recent-row time-tracker-recent-editing" data-id="${e.id}">
                    <span class="time-tracker-recent-cat">${escapeHtml(categoryLabel(e.category))}</span>
                    <input type="datetime-local" class="time-tracker-recent-start" value="${toLocalInputValue(e.startedAt)}" />
                    <input type="datetime-local" class="time-tracker-recent-end" value="${toLocalInputValue(e.endedAt)}" />
                    <button type="button" class="btn btn-secondary time-tracker-recent-save">Save</button>
                    <button type="button" class="btn btn-link time-tracker-recent-cancel">Cancel</button>
                  </div>
                `
                    : `
                  <div class="time-tracker-recent-row" data-id="${e.id}">
                    <span class="time-tracker-recent-cat">${escapeHtml(categoryLabel(e.category))}</span>
                    <span class="time-tracker-recent-range">${formatDateTime(e.startedAt)} &ndash; ${formatClock(e.endedAt)} (${formatElapsed(e.durationSeconds)})</span>
                    <button type="button" class="btn btn-link time-tracker-recent-edit">Edit times</button>
                  </div>
                `
                )
                .join("")}
            </div>
          `
              : ""
          }
        `
        }
      </div>
    `;

    el.querySelector(".time-tracker-tab").addEventListener("click", () => {
      expanded = !expanded;
      render();
    });

    if (resolvingStop) {
      const searchInput = el.querySelector(".time-tracker-resolve-search");
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
                const results = await api.get(`/api/admin/pos?${new URLSearchParams({ search: q })}`);
                resolveSearchResults = Array.isArray(results) ? results : [];
              } catch {
                resolveSearchResults = [];
              }
            } else {
              resolveSearchResults = [];
            }
            render();
            el.querySelector(".time-tracker-resolve-search")?.focus();
          }, 250);
        });
      }
      el.querySelectorAll(".time-tracker-resolve-pick").forEach((btn) => {
        btn.addEventListener("click", () => {
          const isVendor = categoryDef(resolvingStop.category).tracksVendor;
          confirmResolveStop(isVendor ? { relatedVendorId: Number(btn.dataset.id) } : { relatedPoId: Number(btn.dataset.id) });
        });
      });
      const freeTextInput = el.querySelector(".time-tracker-resolve-freetext");
      if (freeTextInput) {
        freeTextInput.addEventListener("input", () => {
          resolveFreeText = freeTextInput.value;
          const confirmBtn = el.querySelector(".time-tracker-resolve-confirm");
          if (confirmBtn) confirmBtn.disabled = !resolveFreeText.trim();
        });
      }
      el.querySelector(".time-tracker-resolve-confirm")?.addEventListener("click", () => {
        const isVendor = categoryDef(resolvingStop.category).tracksVendor;
        if (isVendor) return; // vendor path only resolves via a picked result
        confirmResolveStop({ note: resolveFreeText.trim() });
      });
      el.querySelector(".time-tracker-resolve-cancel")?.addEventListener("click", cancelResolveStop);
      if (current) startTicking();
      return;
    }

    el.querySelectorAll(".time-tracker-cat-btn").forEach((btn) => {
      btn.addEventListener("click", () => armCategory(btn.dataset.key));
    });
    el.querySelector(".time-tracker-start-btn")?.addEventListener("click", confirmStart);

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
    if (stopBtn) stopBtn.addEventListener("click", () => requestStop());

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

    const techSearchInput = el.querySelector(".time-tracker-tech-search");
    if (techSearchInput) {
      searchTechs(techSearchQuery); // populate right away -- the roster is small enough to show before typing
      techSearchInput.addEventListener("input", () => searchTechs(techSearchInput.value));
    }
    const techUnlinkBtn = el.querySelector(".time-tracker-tech-unlink");
    if (techUnlinkBtn) {
      techUnlinkBtn.addEventListener("click", async () => {
        await saveCurrentDetails({ relatedTechId: null });
        render();
      });
    }

    el.querySelectorAll(".time-tracker-estimated-minutes").forEach((input) => {
      input.addEventListener("input", () => {
        estimatedState(input.dataset.key).minutes = input.value;
      });
    });
    el.querySelectorAll(".time-tracker-estimated-note").forEach((input) => {
      input.addEventListener("input", () => {
        estimatedState(input.dataset.key).note = input.value;
      });
    });
    el.querySelectorAll(".time-tracker-estimated-log-btn").forEach((btn) => {
      btn.addEventListener("click", () => logEstimated(btn.dataset.key));
    });

    el.querySelectorAll(".time-tracker-recent-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        recentEditingId = Number(btn.closest(".time-tracker-recent-row").dataset.id);
        render();
      });
    });
    el.querySelectorAll(".time-tracker-recent-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        recentEditingId = null;
        render();
      });
    });
    el.querySelectorAll(".time-tracker-recent-save").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".time-tracker-recent-row");
        const id = Number(row.dataset.id);
        saveRecentEdit(id, row.querySelector(".time-tracker-recent-start"), row.querySelector(".time-tracker-recent-end"));
      });
    });

    if (current) startTicking();
  }

  render();
  refreshCurrent();
  refreshRecent();
  return el;
}

// Mirrors db.js's TIME_LOG_CATEGORIES exactly (fixed, not fetched at
// startup, so the widget renders instantly rather than waiting on a round
// trip before showing anything). tracksPo/tracksVendor drive the
// required-link-at-stop prompt -- see mountTimeTracker's own comment.
const TIME_LOG_CATEGORIES = [
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

// Mirrors db.js's INSTANT_LOG_CATEGORIES exactly.
const INSTANT_LOG_CATEGORIES = [
  { key: "po_entered_tech_ordered", label: "PO Entered (Tech Ordered)", minutes: 2 },
  { key: "po_attached_tracker", label: "Attach PO to Tracker", minutes: 1 },
  { key: "enter_wom", label: "Enter WOM", minutes: 5 },
  { key: "enter_po_invoice_found", label: "Enter PO (Invoice Found, Missed Order)", minutes: 15 },
];

// Mirrors db.js's ESTIMATED_LOG_CATEGORIES exactly.
const ESTIMATED_LOG_CATEGORIES = [{ key: "vendor_correspondence", label: "Vendor Correspondence" }];
