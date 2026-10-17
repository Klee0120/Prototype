import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Financials > Invoicing -- the WOMs Smartsheet says are work-complete but
// this app doesn't yet consider fully invoiced: a real invoice #, a real
// batch #, and the actual invoice file attached here (see
// db.listWomsNeedingInvoicing). There's nothing to flag by hand the way
// Reclasses has -- invoice #/batch # arrive on their own the moment
// Smartsheet shows them (see applyWomSourceEvidence in db.js); this is a
// read-mostly queue of what's still outstanding, and a WOM drops off it
// automatically the next time this loads once all three are satisfied.
export async function renderInvoicing(container, options = {}) {
  const onOpenWom = options.onOpenWom || (() => {});
  let searchFilter = "";
  let items = [];
  // A WOM missing only the document is already invoiced in every way that
  // actually matters here -- a real invoice # and batch # are both on
  // file, Smartsheet shows them. That's a different, lower-urgency problem
  // (someone needs to attach a file) than a WOM with no invoice # at all
  // (nobody's invoiced Toyota for it yet) -- the latter is the real queue
  // this tab exists for, so it stays the big, default-open view; the
  // document-only ones collapse into their own list rather than drowning
  // out what actually still needs invoicing.
  let showDocOnlyList = false;

  await draw();

  async function draw() {
    renderLoadingState(container, loadingLabelFor("Invoicing"));
    try {
      items = await api.get("/api/woms/invoicing-queue");
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    drawList();
  }

  function filteredItems() {
    if (!searchFilter) return items;
    const q = searchFilter.toLowerCase();
    return items.filter((w) => `${w.code} ${w.description}`.toLowerCase().includes(q));
  }

  function isDocOnly(w) {
    return w.missingRequirements.length === 1 && w.missingRequirements[0] === "Invoice document";
  }

  function renderRow(w) {
    const checklistDone = w.billingChecklist.filter((c) => c.done).length;
    return `
      <tr class="invoicing-row" data-code="${escapeHtml(w.code)}">
        <td><span class="wom-code">${escapeHtml(w.code)}</span><div class="attachment-subtext">${escapeHtml(w.description)}</div></td>
        <td>${escapeHtml(w.locationCode || "—")}</td>
        <td>${formatMoney(w.appliedPrice)}</td>
        <td>${w.invoiceNumber ? escapeHtml(w.invoiceNumber) : "<span class=\"badge badge-rejected\">Missing</span>"}</td>
        <td>${w.batchNumber ? escapeHtml(w.batchNumber) : "—"}</td>
        <td>${checklistDone}/${w.billingChecklist.length}${w.billingChecklistComplete ? " &#9989;" : ""}</td>
        <td>${w.missingRequirements.map((m) => `<span class="badge badge-rejected">${escapeHtml(m)}</span>`).join(" ")}</td>
      </tr>`;
  }

  function renderTable(rows) {
    return `
      <table class="detail-table invoicing-table">
        <thead>
          <tr>
            <th>WOM</th>
            <th>Location</th>
            <th>Applied cost</th>
            <th>Invoice #</th>
            <th>Batch #</th>
            <th>Billing checklist</th>
            <th>Still needs</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(renderRow).join("")}
        </tbody>
      </table>`;
  }

  function drawList() {
    const rows = filteredItems();
    const needsInvoiced = rows.filter((w) => !isDocOnly(w));
    const docOnly = rows.filter(isDocOnly);
    container.innerHTML = `
      <h3 style="margin: 0 0 4px;">Invoicing</h3>
      <p class="review-checklist-hint">
        WOMs Smartsheet shows as work-complete but don't have a real invoice # and batch # here yet -- nobody's
        invoiced Toyota for these. Invoice #/batch # update on their own the moment a sync sees them on the sheet;
        the billing checklist below is Smartsheet's own record, shown for reference only (check it off there, not
        here). A WOM drops off this list once an invoice #/batch # are both on file -- from there it only needs
        its invoice document attached (see below).
      </p>
      <div class="wom-filter-bar">
        <div class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="text" class="invoicing-search" placeholder="Search WOM # or description..." value="${escapeHtml(searchFilter)}" />
        </div>
      </div>
      <p class="review-checklist-hint">${needsInvoiced.length} WOM${needsInvoiced.length === 1 ? "" : "s"} still need${needsInvoiced.length === 1 ? "s" : ""} invoicing.</p>
      ${
        needsInvoiced.length === 0
          ? `<p class="empty-note">${items.filter((w) => !isDocOnly(w)).length === 0 ? "Nothing outstanding -- every work-complete WOM has been invoiced." : "No WOMs match your search."}</p>`
          : renderTable(needsInvoiced)
      }
      ${
        docOnly.length > 0
          ? `
      <p class="invoicing-doc-only-toggle-row">
        <button type="button" class="btn btn-link invoicing-doc-only-toggle">
          ${showDocOnlyList ? "Hide" : "Show"} ${docOnly.length} already-invoiced WOM${docOnly.length === 1 ? "" : "s"} missing just the invoice document
        </button>
      </p>
      ${
        showDocOnlyList
          ? `<p class="review-checklist-hint">Invoice # and batch # are both already on file for these -- the only thing left is attaching the invoice document itself.</p>${renderTable(docOnly)}`
          : ""
      }
      `
          : ""
      }
    `;

    container.querySelector(".invoicing-search").addEventListener("input", (e) => {
      searchFilter = e.target.value;
      drawList();
    });
    container.querySelector(".invoicing-doc-only-toggle")?.addEventListener("click", () => {
      showDocOnlyList = !showDocOnlyList;
      drawList();
    });
    container.querySelectorAll(".invoicing-row").forEach((row) => {
      row.addEventListener("click", () => onOpenWom(row.dataset.code));
    });
  }
}
