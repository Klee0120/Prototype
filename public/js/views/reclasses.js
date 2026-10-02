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
export async function renderReclasses(container) {
  let statusFilter = "";
  let sourceFilter = "";
  let meta = null;
  let itemsCache = null;
  let lastBatch = null;

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
}
