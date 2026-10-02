import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { openModal } from "../modal.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function codingString(job, object, subsidiary) {
  const parts = [job, object, subsidiary].filter((p) => p != null && p !== "");
  return parts.length ? parts.join(".") : "—";
}

const STATUS_BADGE_CLASS = {
  flagged: "draft",
  reviewed: "submitted",
  draft: "draft",
  submitted: "submitted",
  confirmed_posted: "approved",
};

// GL Reclasses -- modeled on Krista's real reclass submission sheet (see
// server/routes/reclasses.js's parser). Submitting/importing a reclass here
// never changes any posted-actuals figure anywhere else in the app; it's
// tracked as pending until she marks it Confirmed Posted once a later GL
// report shows the correction actually landed.
export async function renderReclasses(container, options = {}) {
  let statusFilter = "";
  let sourceFilter = "";
  let meta = null;
  let itemsCache = null;
  let lastBatch = null;
  // One-shot deep link from Financials -> Cost Analysis's "Reclassed" link
  // (see adminReview.js's reclassItemToOpen) -- opens straight to that
  // item's detail the first time this tab draws, regardless of filters.
  let openItemId = options.openItemId || null;

  draw();

  async function draw() {
    container.innerHTML = `<p class="empty-note">Loading…</p>`;
    try {
      const [items, batches, metaResp] = await Promise.all([
        api.get(
          `/api/admin/reclasses/items?${new URLSearchParams({
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(sourceFilter ? { source: sourceFilter } : {}),
          })}`
        ),
        api.get("/api/admin/reclasses/batches"),
        meta || api.get("/api/admin/reclasses/meta"),
      ]);
      itemsCache = items;
      meta = metaResp;
      lastBatch = batches[0] || null;
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    drawList();

    if (openItemId) {
      const id = openItemId;
      openItemId = null;
      const item = itemsCache.find((r) => r.id === id);
      if (item) openReclassDetailModal(item);
    }
  }

  function drawList() {
    container.innerHTML = `
      <div class="review-actions">
        <h3 style="margin: 0;">Reclasses</h3>
        <button type="button" class="btn btn-primary reclass-import-btn">Import Submission</button>
        <input type="file" class="reclass-import-file" accept=".xlsx,.xls" hidden />
        <button type="button" class="btn btn-secondary reclass-flag-btn">+ Flag a finding</button>
      </div>
      <p class="review-checklist-hint">
        ${
          lastBatch
            ? `Last import: ${new Date(lastBatch.createdAt).toLocaleString()} — ${lastBatch.reasonForChange || "no reason given"}, ${lastBatch.itemCount} line item${lastBatch.itemCount === 1 ? "" : "s"}, ${formatMoney(lastBatch.itemTotal)} total.`
            : "No reclass submission imported yet."
        }
        Submitting or importing a reclass never changes posted actuals here — it stays pending until a later GL import confirms the correction landed.
      </p>
      <div class="wom-filter-bar">
        <select class="reclass-status-filter">
          <option value="">All statuses</option>
          ${meta.statuses.map((s) => `<option value="${s.value}" ${statusFilter === s.value ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}
        </select>
        <select class="reclass-source-filter">
          <option value="">All sources</option>
          <option value="imported" ${sourceFilter === "imported" ? "selected" : ""}>Imported</option>
          <option value="manual" ${sourceFilter === "manual" ? "selected" : ""}>Manually flagged</option>
        </select>
      </div>
      <p class="po-count">${itemsCache.length} item${itemsCache.length === 1 ? "" : "s"}.</p>
      <div class="reclass-table-wrap"></div>
    `;

    container.querySelector(".reclass-import-btn").addEventListener("click", () => {
      container.querySelector(".reclass-import-file").click();
    });
    container.querySelector(".reclass-import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      await runImport(file);
    });
    container.querySelector(".reclass-flag-btn").addEventListener("click", () => openReclassFormModal());
    container.querySelector(".reclass-status-filter").addEventListener("change", (e) => {
      statusFilter = e.target.value;
      draw();
    });
    container.querySelector(".reclass-source-filter").addEventListener("change", (e) => {
      sourceFilter = e.target.value;
      draw();
    });

    renderTable();
  }

  function renderTable() {
    const wrap = container.querySelector(".reclass-table-wrap");
    if (itemsCache.length === 0) {
      wrap.innerHTML = `<p class="empty-note">No reclass items match these filters.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="detail-table reclass-table">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th>Amount</th>
            <th>Vendor</th>
            <th>Comments</th>
            <th>Root Cause</th>
            <th>Source</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${itemsCache
            .map(
              (r) => `
            <tr class="reclass-row" data-id="${r.id}">
              <td>${escapeHtml(codingString(r.fromJobNumber, r.fromObjectCode, r.fromSubsidiary))}</td>
              <td>${escapeHtml(codingString(r.toJobNumber, r.toObjectCode, r.toSubsidiary))}</td>
              <td>${formatMoney(r.fromAmount)}</td>
              <td>${escapeHtml(r.vendor || "—")}</td>
              <td class="po-desc-cell">${escapeHtml(r.comments || "—")}</td>
              <td>${escapeHtml(r.rootCause || "—")}</td>
              <td>${r.source === "imported" ? "Imported" : "Manual"}</td>
              <td><span class="badge badge-${STATUS_BADGE_CLASS[r.status] || "draft"}">${escapeHtml(meta.statuses.find((s) => s.value === r.status)?.label || r.status)}</span></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll(".reclass-row").forEach((row) => {
      row.addEventListener("click", () => {
        const item = itemsCache.find((r) => r.id === Number(row.dataset.id));
        if (item) openReclassDetailModal(item);
      });
    });
  }

  async function runImport(file) {
    const { body, close } = openModal({ title: "Import Reclass Submission", bodyHtml: `<p class="empty-note">Importing…</p>` });
    try {
      const batch = await api.uploadRawFile("/api/admin/reclasses/batches/import", file);
      body.innerHTML = `
        <p class="review-checklist-hint">
          Imported <strong>${batch.items.length}</strong> line item${batch.items.length === 1 ? "" : "s"} from
          ${escapeHtml(batch.region || "an unspecified region")} -- ${escapeHtml(batch.reasonForChange || "no reason given")}.
          All items landed as Submitted (this file is a historical record of what was already sent to Finance) --
          mark each Confirmed Posted once a later GL import shows the correction.
        </p>
        <div class="modal-form-actions">
          <button type="button" class="btn btn-primary reclass-import-close">Done</button>
        </div>
      `;
      body.querySelector(".reclass-import-close").addEventListener("click", async () => {
        close();
        await draw();
      });
    } catch (err) {
      body.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function codingFieldsHtml(prefix, values) {
    return `
      <div class="add-tech-grid">
        <input name="${prefix}JobNumber" placeholder="Job # / Business Unit" value="${escapeHtml(values?.jobNumber || "")}" />
        <input name="${prefix}ObjectCode" placeholder="Object Acct / Code" value="${escapeHtml(values?.objectCode || "")}" />
        <input name="${prefix}Subsidiary" placeholder="Subsidiary / Cost Code" value="${escapeHtml(values?.subsidiary || "")}" />
        <input name="${prefix}WomNumber" placeholder="WOM # (if needed)" value="${escapeHtml(values?.womNumber || "")}" />
        <input name="${prefix}Amount" type="number" step="0.01" placeholder="Amount" value="${values?.amount ?? ""}" />
      </div>
    `;
  }

  function openReclassFormModal() {
    const { body, close } = openModal({
      title: "Flag a Reclass Finding",
      size: "large",
      bodyHtml: `
        <form class="reclass-form modal-form">
          <h4>From (coded as)</h4>
          ${codingFieldsHtml("from", null)}
          <h4>To (should be)</h4>
          ${codingFieldsHtml("to", null)}
          <div class="add-tech-grid">
            <input name="vendor" placeholder="Vendor / source" />
            <select name="impactsFinalInvoice">
              <option value="">Impacts final invoice?</option>
              <option value="Yes">Yes (Impacting)</option>
              <option value="No">No (Non Impacting)</option>
            </select>
            <select name="causedBy">
              <option value="">Caused by...</option>
              ${meta.causedByOptions.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
            </select>
            <select name="rootCause">
              <option value="">Root cause...</option>
              ${meta.rootCauseOptions.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
            </select>
          </div>
          <textarea name="comments" rows="2" placeholder="Comments / reason"></textarea>
          <textarea name="pathForward" rows="2" placeholder="Path forward / action to prevent reoccurrence"></textarea>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Flag finding</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".reclass-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        await api.post("/api/admin/reclasses/items", {
          fromJobNumber: form.fromJobNumber.value.trim(),
          fromObjectCode: form.fromObjectCode.value.trim(),
          fromSubsidiary: form.fromSubsidiary.value.trim(),
          fromWomNumber: form.fromWomNumber.value.trim(),
          fromAmount: form.fromAmount.value,
          toJobNumber: form.toJobNumber.value.trim(),
          toObjectCode: form.toObjectCode.value.trim(),
          toSubsidiary: form.toSubsidiary.value.trim(),
          toWomNumber: form.toWomNumber.value.trim(),
          toAmount: form.toAmount.value,
          vendor: form.vendor.value.trim(),
          impactsFinalInvoice: form.impactsFinalInvoice.value,
          causedBy: form.causedBy.value,
          rootCause: form.rootCause.value,
          comments: form.comments.value.trim(),
          pathForward: form.pathForward.value.trim(),
        });
        close();
        await draw();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function openReclassDetailModal(item) {
    const hasWom = Boolean(item.fromWomNumber || item.toWomNumber);
    const { body, close } = openModal({
      title: `Reclass #${item.id}`,
      size: "large",
      bodyHtml: `
        <table class="detail-table">
          <tbody>
            <tr><th>From</th><td>${escapeHtml(codingString(item.fromJobNumber, item.fromObjectCode, item.fromSubsidiary))}${item.fromWomNumber ? ` / WOM ${escapeHtml(item.fromWomNumber)}` : ""}</td><th>Amount</th><td>${formatMoney(item.fromAmount)}</td></tr>
            <tr><th>To</th><td>${escapeHtml(codingString(item.toJobNumber, item.toObjectCode, item.toSubsidiary))}${item.toWomNumber ? ` / WOM ${escapeHtml(item.toWomNumber)}` : ""}</td><th>Amount</th><td>${formatMoney(item.toAmount)}</td></tr>
            <tr><th>Vendor</th><td>${escapeHtml(item.vendor || "—")}</td><th>Impacts Final Invoice</th><td>${escapeHtml(item.impactsFinalInvoice || "—")}</td></tr>
            <tr><th>Caused By</th><td>${escapeHtml(item.causedBy || "—")}</td><th>Root Cause</th><td>${escapeHtml(item.rootCause || "—")}</td></tr>
            <tr><th>Source</th><td>${item.source === "imported" ? "Imported" : "Manual"}</td><th>Region</th><td>${escapeHtml(item.region || "—")}</td></tr>
          </tbody>
        </table>
        <h4>Comments</h4>
        <p>${escapeHtml(item.comments || "—")}</p>
        <h4>Path Forward</h4>
        <p>${escapeHtml(item.pathForward || "—")}</p>
        ${hasWom ? `<h4>Linked PO / GL</h4><div class="reclass-gl-links">Loading…</div>` : ""}
        <form class="reclass-status-form modal-form">
          <label class="profile-field">
            <span>Status</span>
            <select name="status">
              ${meta.statuses.map((s) => `<option value="${s.value}" ${item.status === s.value ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field">
            <span>Confirming GL reference (once posted)</span>
            <input name="confirmedGlReference" value="${escapeHtml(item.confirmedGlReference || "")}" placeholder="e.g. document # from a later GL import" />
          </label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    if (hasWom) loadReclassGlLinks(body, item);
    const form = body.querySelector(".reclass-status-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        await api.patch(`/api/admin/reclasses/items/${item.id}`, {
          status: form.status.value,
          confirmedGlReference: form.confirmedGlReference.value.trim(),
        });
        close();
        await draw();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // Read-only: looks up the item's own WOM #(s) against the Budget PO
  // Tracker's wom_number field, then shows whatever GL has actually posted
  // against each matching PO -- lets the admin eyeball whether the
  // correction shows up yet, without the app declaring it posted on its own.
  async function loadReclassGlLinks(body, item) {
    const wrap = body.querySelector(".reclass-gl-links");
    if (!wrap) return;
    let data;
    try {
      data = await api.get(`/api/admin/reclasses/items/${item.id}/gl-links`);
    } catch (err) {
      wrap.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const sides = [
      { label: "From", womNumber: data.fromWomNumber, links: data.fromLinks },
      { label: "To", womNumber: data.toWomNumber, links: data.toLinks },
    ].filter((s) => s.womNumber);
    if (sides.every((s) => s.links.length === 0)) {
      wrap.innerHTML = `<p class="empty-note">No PO in the Budget PO Tracker names ${sides.map((s) => `WOM ${escapeHtml(s.womNumber)}`).join(" or ")}.</p>`;
      return;
    }
    wrap.innerHTML = `
      <p class="review-checklist-hint">
        Looked up by WOM # against the Budget PO Tracker -- not a confirmation this reclass posted. Check the
        GL lines below yourself before marking Confirmed Posted.
      </p>
      ${sides
        .map((side) =>
          side.links.length === 0
            ? `<p class="empty-note">${side.label} WOM ${escapeHtml(side.womNumber)}: no PO on file.</p>`
            : side.links
                .map(
                  (po) => `
          <table class="detail-table">
            <tbody>
              <tr><th>${side.label} WOM</th><td>${escapeHtml(side.womNumber)}</td><th>PO #</th><td class="wom-code">${escapeHtml(po.poNumber || "—")}</td></tr>
              <tr><th>PO Status</th><td>${escapeHtml(po.poStatus || "—")}</td><th>PO Amount</th><td>${formatMoney(po.poAmount)}</td></tr>
              <tr><th>GL lines</th><td>${po.glLineCount}</td><th>Actual paid (GL)</th><td>${formatMoney(po.actualPaid)}</td></tr>
            </tbody>
          </table>
          ${
            po.lines.length > 0
              ? `
          <table class="detail-table">
            <thead><tr><th>Period</th><th>Date</th><th>Doc Type</th><th>Doc #</th><th>Object Account</th><th>Subsidiary</th><th>Amount</th><th>Invoice #</th></tr></thead>
            <tbody>
              ${po.lines
                .map(
                  (l) => `
                <tr>
                  <td>P${escapeHtml(String(l.periodNumber))}/FY${escapeHtml(String(l.fiscalYear))}</td>
                  <td>${escapeHtml(l.glDate || "—")}</td>
                  <td>${escapeHtml(l.documentType || "—")}</td>
                  <td>${escapeHtml(l.documentNumber || "—")}</td>
                  <td>${escapeHtml(l.objectAccount || "—")}</td>
                  <td>${escapeHtml(l.subsidiary || "—")}</td>
                  <td>${formatMoney(l.amount)}</td>
                  <td>${escapeHtml(l.supplierInvoiceNumber || "—")}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>`
              : `<p class="empty-note">No GL report imported has a line matched to this PO yet.</p>`
          }
        `
                )
                .join("")
        )
        .join("")}
    `;
  }
}
