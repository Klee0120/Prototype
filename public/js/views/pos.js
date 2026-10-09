import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal, closeModal } from "../modal.js";
import { renderAttachments } from "./attachments.js";
import { TERRITORIES, CW_PO_REQUEST_FORM_URL } from "../constants.js";
import { getTerritory } from "../globalFilters.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00`).toLocaleDateString();
}

// Unlike dateRequested (a plain YYYY-MM-DD from the sheet), lastSeenAt is a
// full ISO timestamp written by the server at import/sync time -- appending
// "T00:00:00" to that (like formatDate does) breaks Date parsing.
function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

const PO_DOC_CATEGORIES = [
  { value: "po_doc", label: "PO Document" },
  { value: "document", label: "Document" },
];

// Budget PO Tracker -- imports the Operations PO Request Tracking Excel
// export (see server/data/db.js's runPoImport for the matching rules) and
// lets Krista work through vendor/region organization at her own pace.
// Local state resets on every visit to this tab (same reasoning as the
// task board's own bulk-select: a stale selection across an unrelated
// filter/subtab change is worse than just starting fresh).
export async function renderPos(container, { openPoId } = {}) {
  let subTab = "active"; // "active" | "needs_organization"
  let detailId = openPoId || null;
  const filters = {
    search: "",
    locationCode: "",
    vendorUnmatched: false,
    regionUnassigned: false,
    adminUnmatched: false,
    womLinkMissing: false,
    subsidiaryMismatch: false,
    objectCodeMismatch: false,
  };
  const selectedIds = new Set();
  let listCache = null;
  let locationsCache = null;
  let lastImport = null;
  let poKpisCache = null;

  draw();

  async function draw() {
    renderLoadingState(container, loadingLabelFor("Budget PO Tracker"));
    try {
      [listCache, lastImport, locationsCache, poKpisCache] = await Promise.all([
        api.get(
          `/api/admin/pos?${new URLSearchParams({
            lifecycleStatus: subTab,
            ...(filters.search ? { search: filters.search } : {}),
            ...(filters.locationCode ? { locationCode: filters.locationCode } : {}),
            ...(filters.vendorUnmatched ? { vendorUnmatched: "true" } : {}),
            ...(filters.regionUnassigned ? { regionUnassigned: "true" } : {}),
            ...(filters.adminUnmatched ? { adminUnmatched: "true" } : {}),
            ...(filters.womLinkMissing ? { womLinkMissing: "true" } : {}),
            ...(filters.subsidiaryMismatch ? { subsidiaryMismatch: "true" } : {}),
            ...(filters.objectCodeMismatch ? { objectCodeMismatch: "true" } : {}),
          })}`
        ),
        api.get("/api/admin/pos/last-import"),
        locationsCache || api.get("/api/locations"),
        poKpisCache || api.get("/api/tasks/po-turnaround-kpis").catch(() => null),
      ]);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    // Each PO's own territory (admin-derived, falling back to its matched
    // location -- see db.js's poTerritory) already comes back from the
    // server, so this is just a straight equality filter.
    const territory = getTerritory();
    if (territory) {
      listCache = listCache.filter((p) => p.territory === territory);
    }
    selectedIds.clear();
    if (detailId) await drawDetail();
    else drawList();
  }

  function lastImportLine() {
    if (!lastImport) return "No import has been run yet.";
    const when = new Date(lastImport.imported_at).toLocaleString();
    return `Last import: ${when} — ${lastImport.created_count} new, ${lastImport.updated_count} updated, ${lastImport.missing_count} not seen in that file.`;
  }

  // "How long to fulfill a request" vs "how long to notice and fix a gap"
  // -- see server's getPoRequestTurnaroundStats for why these are kept
  // separate rather than one blended average.
  function poKpisLine() {
    if (!poKpisCache) return "";
    const fmt = (s) => (s.count ? `avg ${s.avgHours < 24 ? `${s.avgHours}h` : `${(s.avgHours / 24).toFixed(1)}d`} (${s.count})` : "none yet");
    return `PO turnaround -- tech-requested: ${fmt(poKpisCache.techRequested)} · AP-invoice backfills: ${fmt(poKpisCache.apInvoiceBackfill)}`;
  }

  function drawList() {
    const needsCount = subTab === "needs_organization" ? listCache.length : null;
    container.innerHTML = `
      <div class="review-actions">
        <h3 style="margin: 0;">Budget PO Tracker</h3>
        <button type="button" class="btn btn-primary po-import-btn">Import Excel</button>
        <input type="file" class="po-import-file" accept=".xlsx,.xls" hidden />
        <button type="button" class="btn btn-outline po-request-cw-po-btn">+ Request C&amp;W PO ↗</button>
        <button type="button" class="btn btn-outline po-ap-invoice-btn">+ PO for AP Invoice ↗</button>
      </div>
      <p class="review-checklist-hint">${escapeHtml(lastImportLine())}${getTerritory() ? ` Showing <strong>${escapeHtml(getTerritory())}</strong> only.` : ""}</p>
      <p class="review-checklist-hint">${poKpisLine()}</p>
      <div class="pill-toggle-group po-subtabs">
        <button type="button" class="pill-toggle-btn ${subTab === "active" ? "active" : ""}" data-subtab="active">Active POs</button>
        <button type="button" class="pill-toggle-btn ${subTab === "needs_organization" ? "active" : ""}" data-subtab="needs_organization">Needs Organization</button>
      </div>
      ${
        subTab === "needs_organization"
          ? `<p class="review-checklist-hint">These ${needsCount} record${needsCount === 1 ? "" : "s"} are kept out of Task Manager and every vendor profile until you move each one to Active POs. Preserved exactly as imported — nothing here is guessed.</p>`
          : ""
      }
      <div class="wom-filter-bar po-filter-bar">
        <div class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="text" class="po-search" placeholder="Vendor, description, PO #, or requestor" value="${escapeHtml(filters.search)}" />
        </div>
        <select class="po-location-filter">
          <option value="">All locations</option>
          ${locationsCache.map((l) => `<option value="${escapeHtml(l.code)}" ${filters.locationCode === l.code ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}
        </select>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-vendor-unmatched" ${filters.vendorUnmatched ? "checked" : ""} /> Unmatched vendor</label>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-region-unassigned" ${filters.regionUnassigned ? "checked" : ""} /> Unassigned region</label>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-admin-unmatched" ${filters.adminUnmatched ? "checked" : ""} /> Unmatched admin</label>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-wom-link-missing" ${filters.womLinkMissing ? "checked" : ""} /> WOM coding, no WOM #</label>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-subsidiary-mismatch" ${filters.subsidiaryMismatch ? "checked" : ""} /> Subsidiary mismatch</label>
        <label class="po-filter-checkbox"><input type="checkbox" class="po-objectcode-mismatch" ${filters.objectCodeMismatch ? "checked" : ""} /> Object code mismatch</label>
      </div>
      <p class="po-count"></p>
      <div class="po-bulk-toolbar task-bulk-toolbar" id="po-bulk-toolbar"></div>
      <div class="po-list-table-wrap"></div>
    `;

    container.querySelector(".po-import-btn").addEventListener("click", () => {
      container.querySelector(".po-import-file").click();
    });
    container.querySelector(".po-request-cw-po-btn").addEventListener("click", () => openRequestCwPoModal("tech_requested"));
    container.querySelector(".po-ap-invoice-btn").addEventListener("click", () => openRequestCwPoModal("ap_invoice_backfill"));
    container.querySelector(".po-import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      await runImportPreview(file);
    });
    container.querySelectorAll(".po-subtabs .pill-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        subTab = btn.dataset.subtab;
        draw();
      });
    });
    container.querySelector(".po-search").addEventListener("input", (e) => {
      filters.search = e.target.value;
      debounceRefetch();
    });
    container.querySelector(".po-location-filter").addEventListener("change", (e) => {
      filters.locationCode = e.target.value;
      draw();
    });
    container.querySelector(".po-vendor-unmatched").addEventListener("change", (e) => {
      filters.vendorUnmatched = e.target.checked;
      draw();
    });
    container.querySelector(".po-region-unassigned").addEventListener("change", (e) => {
      filters.regionUnassigned = e.target.checked;
      draw();
    });
    container.querySelector(".po-admin-unmatched").addEventListener("change", (e) => {
      filters.adminUnmatched = e.target.checked;
      draw();
    });
    container.querySelector(".po-wom-link-missing").addEventListener("change", (e) => {
      filters.womLinkMissing = e.target.checked;
      draw();
    });
    container.querySelector(".po-subsidiary-mismatch").addEventListener("change", (e) => {
      filters.subsidiaryMismatch = e.target.checked;
      draw();
    });
    container.querySelector(".po-objectcode-mismatch").addEventListener("change", (e) => {
      filters.objectCodeMismatch = e.target.checked;
      draw();
    });

    renderPoTable();
  }

  let searchDebounceTimer = null;
  function debounceRefetch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => draw(), 350);
  }

  // Same definition as the server's own auto-activate rule (a real PO #,
  // a matched location, and a matched vendor -- see isPoFullyResolved in
  // db.js): a brand new or freshly re-confirmed record skips Needs
  // Organization automatically once it meets this, but a record that was
  // already sitting here before that rule shipped won't retroactively
  // move itself -- this button is the manual catch-up for that backlog.
  function isPoReadyToActivate(p) {
    return Boolean(p.poNumber && /^\d+$/.test(String(p.poNumber).trim()) && p.locationCode && p.vendorLinkStatus === "matched");
  }

  function renderPoTable() {
    const wrap = container.querySelector(".po-list-table-wrap");
    const countEl = container.querySelector(".po-count");
    const readyCount = listCache.filter(isPoReadyToActivate).length;
    countEl.innerHTML = `${listCache.length} match${listCache.length === 1 ? "" : "es"}.${
      subTab === "needs_organization" && readyCount > 0
        ? ` <button type="button" class="btn btn-link po-select-ready-btn">Select all ${readyCount} with PO #, location, and vendor all matched</button>`
        : ""
    }`;
    const selectReadyBtn = countEl.querySelector(".po-select-ready-btn");
    if (selectReadyBtn) {
      selectReadyBtn.addEventListener("click", () => {
        listCache.forEach((p) => {
          if (isPoReadyToActivate(p)) selectedIds.add(p.id);
        });
        syncCheckboxesToSelection();
        renderBulkToolbar();
      });
    }
    if (listCache.length === 0) {
      wrap.innerHTML = `<p class="empty-note">No PO records match these filters.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="detail-table po-table">
        <thead>
          <tr>
            <th><input type="checkbox" class="po-select-all-checkbox" title="Select all visible" /></th>
            <th>Date</th>
            <th>Requestor</th>
            <th>Description</th>
            <th>PO #</th>
            <th>Location</th>
            <th>Region</th>
            <th>Vendor</th>
            <th>Admin</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Last Synced</th>
          </tr>
        </thead>
        <tbody>
          ${listCache
            .map(
              (p) => `
            <tr class="po-row" data-id="${p.id}">
              <td><input type="checkbox" class="po-select-checkbox task-select-checkbox" data-id="${p.id}" /></td>
              <td>${formatDate(p.dateRequested)}</td>
              <td>${escapeHtml(p.requestor || "—")}</td>
              <td class="po-desc-cell">${escapeHtml(p.description || "—")}${p.missingFromImport ? ` <span class="badge badge-warn">Not in last import</span>` : ""}${p.hasOpenReclassFlag ? ` <span class="badge badge-submitted">Flagged for reclass</span>` : ""}</td>
              <td>${escapeHtml(p.poNumber || "—")}</td>
              <td>${escapeHtml(p.locationName || "—")}</td>
              <td>${p.region ? escapeHtml(p.region) : `<span class="badge badge-draft">Unassigned</span>`}</td>
              <td>
                ${p.vendorLinkedName ? escapeHtml(p.vendorLinkedName) : escapeHtml(p.vendorName || "—")}
                <span class="badge ${p.vendorLinkStatus === "matched" ? "badge-approved" : "badge-draft"}">${p.vendorLinkStatus === "matched" ? "Matched" : "Needs matching"}</span>
              </td>
              <td>
                ${escapeHtml(p.adminName || "—")}
                ${p.adminName ? `<span class="badge ${p.adminMatched ? "badge-approved" : "badge-draft"}">${p.adminMatched ? "Matched" : "Not in Roster"}</span>` : ""}
              </td>
              <td>${formatMoney(p.poAmount)}</td>
              <td>${escapeHtml(p.status || "—")}</td>
              <td>${p.lastSeenAt ? formatDateTime(p.lastSeenAt) : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;

    wrap.querySelectorAll(".po-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".po-select-checkbox")) return;
        detailId = Number(row.dataset.id);
        draw();
      });
    });
    wrap.querySelectorAll(".po-select-checkbox").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        const id = Number(cb.dataset.id);
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        syncCheckboxesToSelection();
        renderBulkToolbar();
      });
    });
    wrap.querySelector(".po-select-all-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) listCache.forEach((p) => selectedIds.add(p.id));
      else listCache.forEach((p) => selectedIds.delete(p.id));
      syncCheckboxesToSelection();
      renderBulkToolbar();
    });
    syncCheckboxesToSelection();
    renderBulkToolbar();
  }

  // Keeps every row checkbox, and the header's own "select all visible"
  // checkbox, reflecting selectedIds -- needed because selectedIds can
  // change from outside a checkbox click too (the "Select all N with a
  // matched vendor + region assigned" shortcut above).
  function syncCheckboxesToSelection() {
    container.querySelectorAll(".po-select-checkbox").forEach((cb) => {
      cb.checked = selectedIds.has(Number(cb.dataset.id));
    });
    const selectAll = container.querySelector(".po-select-all-checkbox");
    if (selectAll) selectAll.checked = listCache.length > 0 && listCache.every((p) => selectedIds.has(p.id));
  }

  function renderBulkToolbar() {
    const toolbarEl = container.querySelector("#po-bulk-toolbar");
    if (!toolbarEl) return;
    if (selectedIds.size === 0) {
      toolbarEl.innerHTML = "";
      return;
    }
    toolbarEl.innerHTML = `
      <span class="task-bulk-count">${selectedIds.size} selected</span>
      <button class="btn btn-secondary po-bulk-confirm-vendor" type="button">Confirm vendor...</button>
      ${subTab === "needs_organization" ? `<button class="btn btn-secondary po-bulk-activate" type="button">Move to Active POs</button>` : ""}
      <button class="btn btn-secondary po-bulk-flag-reclass" type="button">Flag for reclass</button>
      <button class="btn btn-secondary po-bulk-unflag-reclass" type="button">Unflag reclass</button>
      <button class="btn btn-link po-bulk-clear" type="button">Clear selection</button>
    `;
    toolbarEl.querySelector(".po-bulk-confirm-vendor").addEventListener("click", () => {
      openVendorPickerModal(async (vendorId) => {
        await api.post("/api/admin/pos/bulk/confirm-vendor", { ids: [...selectedIds], vendorId });
        await draw();
      });
    });
    const activateBtn = toolbarEl.querySelector(".po-bulk-activate");
    if (activateBtn) {
      activateBtn.addEventListener("click", async () => {
        if (!window.confirm(`Move ${selectedIds.size} PO record(s) to Active POs? Their linked tasks will start appearing in Task Manager.`)) return;
        await api.post("/api/admin/pos/bulk/activate", { ids: [...selectedIds] });
        await draw();
      });
    }
    toolbarEl.querySelector(".po-bulk-flag-reclass").addEventListener("click", async () => {
      const result = await api.post("/api/admin/reclasses/flag-po", { poIds: [...selectedIds] });
      const bits = [];
      if (result.flaggedCount > 0) bits.push(`${result.flaggedCount} flagged`);
      if (result.skippedCount > 0) bits.push(`${result.skippedCount} already flagged or not found, skipped`);
      window.alert(bits.join(", ") || "Nothing to flag.");
      await draw();
    });
    toolbarEl.querySelector(".po-bulk-unflag-reclass").addEventListener("click", async () => {
      const result = await api.post("/api/admin/reclasses/unflag-po", { poIds: [...selectedIds] });
      const bits = [];
      if (result.unflaggedCount > 0) bits.push(`${result.unflaggedCount} unflagged`);
      if (result.skippedCount > 0) bits.push(`${result.skippedCount} weren't flagged, skipped`);
      window.alert(bits.join(", ") || "Nothing to unflag.");
      await draw();
    });
    toolbarEl.querySelector(".po-bulk-clear").addEventListener("click", () => {
      selectedIds.clear();
      container.querySelectorAll(".po-select-checkbox").forEach((cb) => (cb.checked = false));
      renderBulkToolbar();
    });
  }

  // The admin-side "+ Request C&W PO" button -- same tracked-task prompt as
  // the tech-facing one on Locations & WOM (see techHome.js's
  // openRequestCwPoModal), so a PO requested from here is just as visible
  // in Task Manager, whether the admin is routing it to themselves or to
  // whoever actually owns that territory.
  //
  // Also reused for the "+ PO for AP Invoice" button (origin:
  // "ap_invoice_backfill") -- AP already has a vendor invoice with no PO on
  // file at all, so an admin is generating the missing PO after the fact
  // rather than fulfilling a tech's request. Same task category, same
  // reference-number/import-matching/Mark PO generated machinery either
  // way -- see server/routes/tasks.js's PO_REQUEST_ORIGINS -- just a
  // different title/copy and a separate KPI bucket (see
  // getPoRequestTurnaroundStats), since "how long to fulfill a request"
  // and "how long to notice and fix a gap" measure different things.
  async function openRequestCwPoModal(origin = "tech_requested") {
    const isBackfill = origin === "ap_invoice_backfill";
    let admins;
    try {
      admins = await api.get("/api/tasks/assignable-admins");
    } catch (err) {
      alert(err.message || "Couldn't load the admin list.");
      return;
    }
    const { body } = openModal({
      title: isBackfill ? "Log an AP-Invoice PO Backfill" : "Request a C&W PO",
      bodyHtml: `
        <form class="modal-form request-po-form">
          ${
            isBackfill
              ? `<p class="review-checklist-hint">For a vendor invoice AP already has on hand with no PO on file -- this logs the gap and tracks generating the missing PO.</p>`
              : ""
          }
          <label class="profile-field">
            <span>Which admin should generate it?</span>
            <select name="assignedTo" required>
              <option value="">Select an admin...</option>
              ${admins.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === state.user.id ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field">
            <span>Note (optional)</span>
            <textarea name="note" rows="3" placeholder="${isBackfill ? "Vendor / invoice details" : "What's this PO for?"}"></textarea>
          </label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Submit Task</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".request-po-form");
    // This form's only fields are a <select> and a <textarea> -- neither
    // one implicitly submits a form on Enter the way a text <input> does
    // (confirmed: Chromium just leaves the dropdown sitting there), so
    // without this a user who picks the admin and hits Enter sees nothing
    // happen and no task gets created. Skip it inside the textarea, where
    // Enter should still just add a line break.
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        const created = await api.post("/api/tasks/request-po", {
          assignedTo: form.assignedTo.value,
          note: form.note.value.trim(),
          origin,
        });
        renderRequestPoConfirmation(body, created);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // Swapping straight to Smartsheet the instant the task was created made
  // the whole thing feel like it hadn't done anything -- no visible
  // confirmation the task actually exists before the tab changes out from
  // under you. This pauses on an explicit confirmation step instead, with
  // a reference # to hand to whoever fills out the Smartsheet form (put it
  // in that form's Description field) so the real PO can be matched back
  // to this task later -- there's no automatic link between the two, this
  // is the only thread connecting them.
  function renderRequestPoConfirmation(body, task) {
    const reference = `PO Request Task #${task.id}`;
    body.innerHTML = `
      <div class="request-po-confirmation">
        <p class="review-checklist-hint">✓ Task submitted successfully.</p>
        <div class="request-po-reference-callout">
          <p class="request-po-reference-instruction">COPY AND PASTE THIS NUMBER INTO THE DESCRIPTION OF THE PO REQUEST FORM:</p>
          <div class="request-po-reference-row">
            <span class="request-po-reference-number">${escapeHtml(reference)}</span>
            <button type="button" class="btn btn-secondary request-po-copy-btn">Copy</button>
          </div>
        </div>
        <div class="modal-form-actions">
          <button type="button" class="btn btn-primary request-po-continue-btn">Continue to the PO form ↗</button>
          <button type="button" class="btn btn-secondary request-po-done-btn">Done</button>
        </div>
      </div>
    `;
    const copyBtn = body.querySelector(".request-po-copy-btn");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(reference);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      } catch {
        window.prompt("Copy this reference:", reference);
      }
    });
    body.querySelector(".request-po-continue-btn").addEventListener("click", () => {
      window.open(CW_PO_REQUEST_FORM_URL, "_blank", "noopener");
    });
    body.querySelector(".request-po-done-btn").addEventListener("click", closeModal);
  }

  // A plain name/JDE# search over the existing vendor directory -- never
  // auto-matched by name (see runPoImport), this is purely for a person
  // to pick the right vendor by hand.
  function openVendorPickerModal(onPick) {
    const { body, close } = openModal({
      title: "Confirm vendor",
      bodyHtml: `
        <div class="modal-form">
          <input type="text" class="po-vendor-picker-search" placeholder="Search vendor name or JDE #" />
          <div class="review-list po-vendor-picker-list"></div>
        </div>
      `,
    });
    let vendors = null;
    async function refresh(query) {
      if (!vendors) vendors = await api.get("/api/admin/vendors");
      const q = (query || "").toLowerCase();
      const filtered = q
        ? vendors.filter((v) => v.name.toLowerCase().includes(q) || (v.jdeVendorNumber || "").toLowerCase().includes(q))
        : vendors;
      const list = body.querySelector(".po-vendor-picker-list");
      list.innerHTML = filtered
        .slice(0, 50)
        .map(
          (v) => `<div class="review-row po-vendor-picker-row" data-id="${v.id}">
            <span class="review-row-name">${escapeHtml(v.name)}</span>
            <span class="wom-code">${escapeHtml(v.jdeVendorNumber || "no JDE #")}</span>
          </div>`
        )
        .join("");
      list.querySelectorAll(".po-vendor-picker-row").forEach((row) => {
        row.addEventListener("click", async () => {
          close();
          await onPick(Number(row.dataset.id));
        });
      });
    }
    body.querySelector(".po-vendor-picker-search").addEventListener("input", (e) => refresh(e.target.value));
    refresh("");
  }

  // Tags a real Location with this PO's own E&F job # -- either an existing
  // location that doesn't have a job # on file yet, or a brand new one --
  // instead of the old shortcut that let a bare region get typed directly
  // onto the PO. See db.js's tagLocationForPo/resolvePosForJobNumber.
  function openTagLocationModal(po, onDone) {
    const { body, close } = openModal({
      title: "Tag a location",
      bodyHtml: `
        <div class="modal-form">
          <p class="review-checklist-hint">
            Job # <strong>${escapeHtml(po.efJobNumber)}</strong> has no location match on file. Pick the location this
            job site is, or create a new one -- every PO carrying this job # will resolve to it right away.
          </p>
          <input type="text" class="po-location-picker-search" placeholder="Search locations" />
          <div class="review-list po-location-picker-list"></div>
          <button type="button" class="btn btn-link po-location-new-toggle">+ Create a new location instead</button>
          <form class="po-location-new-form modal-form" hidden>
            <div class="add-tech-grid">
              <input name="code" placeholder="Location code" required />
              <input name="name" placeholder="Location name" required />
              <select name="territory" required>
                <option value="" disabled selected>Select territory…</option>
                ${TERRITORIES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
              </select>
            </div>
            <div class="modal-form-actions">
              <button type="submit" class="btn btn-primary">Create &amp; tag</button>
            </div>
          </form>
          <span class="save-message"></span>
        </div>
      `,
    });
    const msg = body.querySelector(".save-message");

    async function tag(payload) {
      msg.textContent = "";
      try {
        await api.patch(`/api/admin/pos/${po.id}/location-tag`, payload);
        close();
        await onDone();
      } catch (err) {
        msg.textContent = err.message;
      }
    }

    let locations = null;
    async function refresh(query) {
      if (!locations) locations = await api.get("/api/locations");
      const q = (query || "").toLowerCase();
      const filtered = q ? locations.filter((l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)) : locations;
      const list = body.querySelector(".po-location-picker-list");
      list.innerHTML = filtered
        .slice(0, 50)
        .map(
          (l) => `<div class="review-row po-location-picker-row" data-code="${escapeHtml(l.code)}">
            <span class="review-row-name">${escapeHtml(l.name)}</span>
            <span class="wom-code">${l.efJobNumber ? `Job # ${escapeHtml(l.efJobNumber)}` : "No job # yet"}</span>
          </div>`
        )
        .join("");
      list.querySelectorAll(".po-location-picker-row").forEach((row) => {
        row.addEventListener("click", () => tag({ locationCode: row.dataset.code }));
      });
    }
    body.querySelector(".po-location-picker-search").addEventListener("input", (e) => refresh(e.target.value));
    refresh("");

    const newForm = body.querySelector(".po-location-new-form");
    const pickerSearch = body.querySelector(".po-location-picker-search");
    const pickerList = body.querySelector(".po-location-picker-list");
    body.querySelector(".po-location-new-toggle").addEventListener("click", (e) => {
      const showingNewForm = newForm.hidden;
      newForm.hidden = !showingNewForm;
      e.target.textContent = showingNewForm ? "Pick an existing location instead" : "+ Create a new location instead";
      // .review-list sets its own display: flex, which beats the [hidden]
      // UA rule on specificity order -- toggle via inline style instead.
      pickerSearch.style.display = showingNewForm ? "none" : "";
      pickerList.style.display = showingNewForm ? "none" : "";
    });
    newForm.addEventListener("submit", (e) => {
      e.preventDefault();
      tag({
        newLocation: {
          code: newForm.code.value.trim(),
          name: newForm.name.value.trim(),
          territory: newForm.territory.value,
        },
      });
    });
  }

  async function runImportPreview(file) {
    const { body, close } = openModal({
      title: "Import PO Tracker",
      size: "large",
      bodyHtml: `<p class="empty-note">Reading file…</p>`,
    });
    let preview;
    try {
      preview = await api.uploadRawFile("/api/admin/pos/import", file, { dryRun: "true" });
    } catch (err) {
      body.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    body.innerHTML = `
      <p class="review-checklist-hint">
        Read sheet <strong>${escapeHtml(preview.sheetName)}</strong> — ${preview.totalRows} rows.
        ${preview.missingColumns.length ? `<br /><span class="attachments-error">Missing expected column(s): ${preview.missingColumns.map(escapeHtml).join(", ")}</span>` : ""}
        ${
          preview.mergedIntoExistingCount > 0
            ? `<br /><span class="attachments-error">${preview.mergedIntoExistingCount} row${preview.mergedIntoExistingCount === 1 ? "" : "s"} share${preview.mergedIntoExistingCount === 1 ? "s" : ""} a PO # with another record already on file -- combined into that record as one PO with the amounts totaled, rather than kept as separate rows. Worth a look in the sheet to confirm that's right.</span>`
            : ""
        }
      </p>
      <div class="task-tiles">
        <div class="task-tile"><div class="task-tile-count">${preview.createdCount}</div><div class="task-tile-label">New records</div></div>
        <div class="task-tile"><div class="task-tile-count">${preview.updatedCount}</div><div class="task-tile-label">Updated</div></div>
        <div class="task-tile"><div class="task-tile-count">${preview.unchangedCount}</div><div class="task-tile-label">Unchanged</div></div>
        <div class="task-tile"><div class="task-tile-count">${preview.missingCount}</div><div class="task-tile-label">Not in this file</div></div>
        <div class="task-tile"><div class="task-tile-count">${preview.invalidCount}</div><div class="task-tile-label">Skipped (empty row)</div></div>
      </div>
      <p class="review-checklist-hint">
        This is a preview — nothing has been saved yet. Confirm to commit these changes. New and
        updated records land in Needs Organization unless they're already Active; nothing here
        touches Task Manager until you move a record to Active POs yourself.
      </p>
      <div class="modal-form-actions">
        <button type="button" class="btn btn-primary po-import-confirm">Confirm import</button>
        <button type="button" class="btn btn-secondary po-import-cancel">Cancel</button>
      </div>
      <span class="save-message"></span>
    `;
    body.querySelector(".po-import-cancel").addEventListener("click", close);
    body.querySelector(".po-import-confirm").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const msg = body.querySelector(".save-message");
      try {
        await api.uploadRawFile("/api/admin/pos/import", file, { dryRun: "false" });
        close();
        await draw();
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  async function drawDetail() {
    let po, tasks;
    try {
      [po, tasks] = await Promise.all([api.get(`/api/admin/pos/${detailId}`), api.get(`/api/admin/pos/${detailId}/tasks`)]);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    container.innerHTML = `
      <button type="button" class="btn btn-link po-back-btn">&larr; Budget PO Tracker</button>
      <div class="review-actions">
        <h3 style="margin: 0;">${escapeHtml(po.description || "PO record")}</h3>
        <span class="badge ${po.lifecycleStatus === "active" ? "badge-approved" : "badge-draft"}">${po.lifecycleStatus === "active" ? "Active" : "Needs Organization"}</span>
        ${po.missingFromImport ? `<span class="badge badge-warn">Not seen in last import</span>` : ""}
        ${po.hasOpenReclassFlag ? `<span class="badge badge-submitted">Flagged for reclass</span>` : ""}
        ${po.lifecycleStatus !== "active" ? `<button type="button" class="btn btn-primary po-activate-btn">Move to Active POs</button>` : ""}
        <button type="button" class="btn btn-secondary po-flag-reclass-btn">${po.hasOpenReclassFlag ? "Unflag reclass" : "Flag for reclass"}</button>
      </div>
      <table class="detail-table po-detail-table">
        <tbody>
          <tr><th>Line #</th><td>${po.lineNumber != null ? po.lineNumber : "—"}</td><th>PO Number</th><td>${escapeHtml(po.poNumber || "—")}</td></tr>
          <tr><th>Date Requested</th><td>${formatDate(po.dateRequested)}</td><th>Requestor</th><td>${escapeHtml(po.requestor || "—")}</td></tr>
          <tr><th>PO Amount</th><td>${formatMoney(po.poAmount)}</td><th>Change Order</th><td>${escapeHtml(po.changeOrder || "—")}</td></tr>
          <tr><th>Status</th><td>${escapeHtml(po.status || "—")}</td><th>Admin</th><td>${escapeHtml(po.adminName || "—")}</td></tr>
          <tr><th>Last Synced</th><td>${po.lastSeenAt ? formatDateTime(po.lastSeenAt) : "—"}</td><th></th><td></td></tr>
          <tr><th>PPS Job #</th><td>${escapeHtml(po.ppsJobNumber || "—")}</td><th>E1 WOM Job #</th><td>${escapeHtml(po.e1WomJobNumber || "—")}</td></tr>
          <tr><th>WOM Number</th><td>${escapeHtml(po.womNumber || "—")}</td><th>Asset #</th><td>${escapeHtml(po.assetNumber || "—")}</td></tr>
          <tr><th>Maximo WO#</th><td>${escapeHtml(po.maximoWo || "—")}</td><th>Object Code</th><td>${escapeHtml(po.objectCode || "—")}</td></tr>
          <tr><th>Subsidiary</th><td>${escapeHtml(po.subsidiary || "—")}</td><th>Urgent</th><td>${po.urgent ? `Yes${po.urgentNotes ? ` — ${escapeHtml(po.urgentNotes)}` : ""}` : "No"}</td></tr>
        </tbody>
      </table>

      <h4>Location &amp; Region</h4>
      <p>E&amp;F Contract Job #: ${escapeHtml(po.efJobNumber || "—")} — ${
        po.locationCode
          ? `<strong>${escapeHtml(po.locationName || po.locationCode)}</strong> (${escapeHtml(po.region || "no territory on file")})`
          : `No location match on file`
      }</p>
      ${
        po.locationCode
          ? `<p class="review-checklist-hint">Matched by job # against the Locations list. To change it, retag the location on the Locations page.</p>`
          : po.efJobNumber
            ? `<div class="po-location-tag">
                <button type="button" class="btn btn-secondary po-tag-location-btn">Tag a location with this job #</button>
              </div>`
            : `<p class="review-checklist-hint">This PO has no E&amp;F Contract Job # on file, so it can't be matched to a location.</p>`
      }

      <h4>Vendor</h4>
      <p>
        As imported: <strong>${escapeHtml(po.vendorName || "—")}</strong> (Vendor # ${escapeHtml(po.vendorNumber || "none")})
        — <span class="badge ${po.vendorLinkStatus === "matched" ? "badge-approved" : "badge-draft"}">${po.vendorLinkStatus === "matched" ? `Matched to ${escapeHtml(po.vendorLinkedName)}` : "Needs matching"}</span>
      </p>
      <div class="po-vendor-edit">
        <button type="button" class="btn btn-secondary po-vendor-pick-btn">${po.vendorId ? "Change vendor link" : "Confirm vendor"}</button>
        ${po.vendorId ? `<button type="button" class="btn btn-link po-vendor-clear-btn">Clear link</button>` : ""}
      </div>

      <h4>Linked Tasks (${tasks.length})</h4>
      <div class="review-list po-tasks-list"></div>
      <form class="po-add-task-form modal-form">
        <input type="text" name="title" placeholder="New task title" required />
        <button type="submit" class="btn btn-secondary">Add task</button>
      </form>

      <h4>Documents</h4>
      <div class="po-documents"></div>
    `;

    container.querySelector(".po-back-btn").addEventListener("click", () => {
      detailId = null;
      draw();
    });
    const activateBtn = container.querySelector(".po-activate-btn");
    if (activateBtn) {
      activateBtn.addEventListener("click", async () => {
        await api.post(`/api/admin/pos/${po.id}/activate`);
        await draw();
      });
    }
    const flagReclassBtn = container.querySelector(".po-flag-reclass-btn");
    if (flagReclassBtn) {
      flagReclassBtn.addEventListener("click", async () => {
        const path = po.hasOpenReclassFlag ? "/api/admin/reclasses/unflag-po" : "/api/admin/reclasses/flag-po";
        await api.post(path, { poIds: [po.id] });
        await draw();
      });
    }
    const tagLocationBtn = container.querySelector(".po-tag-location-btn");
    if (tagLocationBtn) {
      tagLocationBtn.addEventListener("click", () => {
        openTagLocationModal(po, async () => {
          await draw();
        });
      });
    }
    container.querySelector(".po-vendor-pick-btn").addEventListener("click", () => {
      openVendorPickerModal(async (vendorId) => {
        await api.patch(`/api/admin/pos/${po.id}/vendor`, { vendorId });
        await draw();
      });
    });
    const clearBtn = container.querySelector(".po-vendor-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        await api.delete(`/api/admin/pos/${po.id}/vendor`);
        await draw();
      });
    }

    const tasksList = container.querySelector(".po-tasks-list");
    if (tasks.length === 0) {
      tasksList.innerHTML = `<p class="empty-note">No tasks logged against this PO yet.</p>`;
    } else {
      tasksList.innerHTML = tasks
        .map(
          (t) => `<div class="review-row">
            <div class="review-row-summary">
              <span class="review-row-name">${escapeHtml(t.title)}</span>
              <span class="badge badge-${t.status === "completed" ? "approved" : t.status === "cancelled" ? "rejected" : "draft"}">${escapeHtml(t.status)}</span>
            </div>
          </div>`
        )
        .join("");
    }
    container.querySelector(".po-add-task-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      await api.post(`/api/admin/pos/${po.id}/tasks`, { title: form.title.value.trim() });
      form.title.value = "";
      await draw();
    });

    await renderAttachments(container.querySelector(".po-documents"), {
      title: "PO Documents",
      relatedType: "po",
      relatedId: po.id,
      categories: PO_DOC_CATEGORIES,
      canUpload: true,
    });
  }
}
