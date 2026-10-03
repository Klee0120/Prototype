import { api } from "../api.js";
import { escapeHtml } from "../app.js";

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

  await draw();

  async function draw() {
    container.innerHTML = `<p class="empty-note">Loading…</p>`;
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

  function drawList() {
    const rows = filteredItems();
    container.innerHTML = `
      <h3 style="margin: 0 0 4px;">Invoicing</h3>
      <p class="review-checklist-hint">
        WOMs Smartsheet shows as work-complete but not yet fully invoiced here -- a real invoice #, a real batch #,
        and the actual invoice file attached. Invoice #/batch # update on their own the moment a sync sees them on
        the sheet; the billing checklist below is Smartsheet's own record, shown for reference only (check it off
        there, not here). A WOM drops off this list once all three requirements are met.
      </p>
      <div class="wom-filter-bar">
        <div class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="text" class="invoicing-search" placeholder="Search WOM # or description..." value="${escapeHtml(searchFilter)}" />
        </div>
      </div>
      <p class="review-checklist-hint">${rows.length} WOM${rows.length === 1 ? "" : "s"} still need${rows.length === 1 ? "s" : ""} invoicing.</p>
      ${
        rows.length === 0
          ? `<p class="empty-note">${items.length === 0 ? "Nothing outstanding -- every work-complete WOM is fully invoiced." : "No WOMs match your search."}</p>`
          : `<table class="detail-table invoicing-table">
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
                ${rows
                  .map((w) => {
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
                  })
                  .join("")}
              </tbody>
            </table>`
      }
    `;

    container.querySelector(".invoicing-search").addEventListener("input", (e) => {
      searchFilter = e.target.value;
      drawList();
    });
    container.querySelectorAll(".invoicing-row").forEach((row) => {
      row.addEventListener("click", () => onOpenWom(row.dataset.code));
    });
  }
}
