import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { openModal } from "../modal.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// A small "copy this PO #" affordance next to a PO number wherever it shows
// up in Reconciliation -- lets Krista grab it to search the Budget PO
// Tracker without opening the GL-line detail modal first (which never
// showed the PO # as its own copyable field, only buried in its title).
function poCopyHtml(poNumber) {
  if (!poNumber) return "";
  return `<button type="button" class="po-copy-btn" data-po="${escapeHtml(poNumber)}" title="Copy PO #" aria-label="Copy PO number">⧉</button>`;
}

function wirePoCopyButtons(root) {
  root.querySelectorAll(".po-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      // Stops the click from also bubbling up into a row's own "open the
      // detail modal" handler -- copying shouldn't also navigate away.
      e.stopPropagation();
      const value = btn.dataset.po;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        window.prompt("Copy this PO #:", value);
        return;
      }
      const original = btn.textContent;
      btn.textContent = "✓";
      btn.classList.add("po-copy-btn-done");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("po-copy-btn-done");
      }, 1200);
    });
  });
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
function monthName(periodNumber) {
  return MONTH_NAMES[periodNumber - 1] || `Period ${periodNumber}`;
}

// A compact per-period strip for the whole fiscal year, not just the single
// most-recently-closed gap the overdue banner above already covers -- so
// it's obvious at a glance how much of the year's GL is actually in, not
// just whether the latest month is.
function renderCoverageStrip(coverage) {
  const importedCount = coverage.filter((p) => p.imported).length;
  const dueCount = coverage.filter((p) => p.closedYet).length;
  const fiscalYear = coverage[0] ? coverage[0].fiscalYear : null;
  return `
    <p class="review-checklist-hint">
      <strong>FY${fiscalYear} GL coverage:</strong> ${importedCount} of ${dueCount} closed period${dueCount === 1 ? "" : "s"} imported
      (${coverage.length} period${coverage.length === 1 ? "" : "s"} in the fiscal year).
    </p>
    <div class="gl-coverage-strip">
      ${coverage
        .map((p) => {
          const cls = p.imported ? "badge-approved" : p.closedYet ? "badge-rejected" : "badge-draft";
          const title = p.imported
            ? `${p.monthName} 20${p.fiscalYear} -- imported`
            : p.closedYet
              ? `${p.monthName} 20${p.fiscalYear} -- closed ${p.closedDate}, not imported yet`
              : `${p.monthName} 20${p.fiscalYear} -- doesn't close until ${p.closedDate}`;
          return `<span class="badge ${cls}" title="${escapeHtml(title)}">${escapeHtml(p.monthName.slice(0, 3))}</span>`;
        })
        .join("")}
    </div>
  `;
}

function renderPager(wrapClass, { page, pageSize, total }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return "";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return `
    <div class="gl-pager ${wrapClass}">
      <button type="button" class="btn btn-secondary gl-pager-prev" ${page <= 1 ? "disabled" : ""}>&larr; Prev</button>
      <span>Showing ${start}&ndash;${end} of ${total}</span>
      <button type="button" class="btn btn-secondary gl-pager-next" ${page >= totalPages ? "disabled" : ""}>Next &rarr;</button>
    </div>
  `;
}

// GL Reconciliation -- matches a monthly GL extract against the Budget PO
// Tracker by PO number (see server/routes/gl.js), to show what actually got
// paid against each PO vs. what it was approved for, and whether the GL
// posting used the same object/subsidiary code the PO itself specifies.
// Read-only throughout -- same "Financials reflects numbers, never edits
// project data" rule as Cost Analysis.
//
// Every number here -- the three big lists and the summary tiles -- is
// fetched from the server already paginated/filtered (see
// server/data/db.js's getGlReconciliationSummary/getReconciledPage/etc).
// GL Reconciliation used to pull every GL line ever imported on every page
// load, compute the whole reconciliation in JS, and ship all of it to the
// browser before slicing it into pages client-side -- that only got slower
// as more months were imported, since gl_entries only ever grows (each
// import replaces just its own period). Paginating on the server means a
// page load only ever touches the current page's own rows.
export async function renderGlReconciliation(container) {
  let summary = null;
  let imports = [];
  let status = null;

  // PO reconciliation table filters -- sent to the server, not applied
  // client-side. "PO reference not found" isn't one of these: that's a
  // GL-line-level gap, not a PO-level one, so it's its own section below.
  let glStatusFilter = ""; // "" | "open" | "closed"
  let glSubsidiaryOnly = false;
  let glObjectCodeOnly = false;
  let glAboveOnly = false; // variance > 0 ("posted above PO")
  let glMissingLocationOnly = false;

  const GL_PAGE_SIZE = 100;
  let reconciledPage = 1;
  let unmatchedPage = 1;
  let reconciledItems = []; // current page only, for the detail-modal click lookup

  await draw();

  async function draw() {
    renderLoadingState(container, loadingLabelFor("Reconciliation"));
    try {
      [summary, imports, status] = await Promise.all([
        api.get("/api/admin/gl/reconciliation/summary"),
        api.get("/api/admin/gl/imports"),
        api.get("/api/admin/gl/status"),
      ]);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    drawBody();
  }

  function drawBody() {
    const lastImport = imports[0] || null;
    container.innerHTML = `
      <div class="review-actions">
        <h3 style="margin: 0;">Reconciliation</h3>
        <button type="button" class="btn btn-primary gl-import-btn">Import GL Report</button>
        <input type="file" class="gl-import-file" accept=".xlsx,.xls" hidden />
      </div>
      ${
        status && status.overdue
          ? `
      <p class="attachments-error">
        Waiting on the <strong>${escapeHtml(status.expectedPeriod.monthName)} ${2000 + status.expectedPeriod.fiscalYear}</strong>
        GL report (Period ${status.expectedPeriod.periodNumber}/FY${status.expectedPeriod.fiscalYear}) -- that month's GL closed
        on ${escapeHtml(status.expectedPeriod.closedDate)} and hasn't been imported yet.
      </p>
      `
          : ""
      }
      <p class="review-checklist-hint">
        ${
          lastImport
            ? `Last import: Period ${lastImport.periodNumber}/FY${lastImport.fiscalYear}${lastImport.calendarMonth ? ` (filed as ${escapeHtml(lastImport.calendarMonth)})` : ""}, ${new Date(lastImport.createdAt).toLocaleString()} -- ${lastImport.rowCount} GL lines: ${lastImport.matchedCount} GL lines matched to a PO, ${lastImport.unmatchedCount} GL lines with a PO # not on file, ${lastImport.noPoReferenceCount ?? 0} GL lines with no PO reference (payroll, journal entries, accruals, etc.).`
            : "No GL report imported yet."
        }
        Compares real GL amounts against the Budget PO Tracker -- this never changes anything on the PO or WOM side, it's a read-only check.
      </p>

      ${status && status.coverage ? renderCoverageStrip(status.coverage) : ""}

      <div class="task-tiles">
        <div class="task-tile"><div class="task-tile-count">${summary.reconciledCount}</div><div class="task-tile-label">Unique POs matched to GL</div></div>
        <div class="task-tile"><div class="task-tile-count">${formatMoney(summary.reconciledTotal)}</div><div class="task-tile-label">Net variance (paid &minus; PO amount)</div></div>
        <div class="task-tile"><div class="task-tile-count">${summary.subsidiaryMismatchCount}</div><div class="task-tile-label">Subsidiary mismatches</div></div>
        <div class="task-tile"><div class="task-tile-count">${summary.objectCodeMismatchCount}</div><div class="task-tile-label">Object code mismatches</div></div>
        <div class="task-tile"><div class="task-tile-count">${summary.unmatchedCount}</div><div class="task-tile-label">GL lines, PO # not found</div></div>
      </div>

      <h3>PO reconciliation</h3>
      <p class="review-checklist-hint">
        The PO's own dollar amount (from the Budget PO Tracker) vs. what the GL actually shows paid against it, summed across every GL period
        imported so far -- a PO invoiced across multiple months shows its full running total here, not just
        the latest one. A variance isn't necessarily a problem by itself: a PO still being invoiced (check its
        own PO Status column) is just mid-billing, not wrong yet -- it's worth a look once that status shows
        it's actually done. Subsidiary and Object Code are checked separately against what's on the PO itself
        (comparing just the leading code, since the PO Tracker stores these as "code + description").
      </p>
      <div class="wom-filter-bar gl-po-filter-bar">
        <select class="gl-status-filter">
          <option value="">Open + closed POs</option>
          <option value="open" ${glStatusFilter === "open" ? "selected" : ""}>Open POs</option>
          <option value="closed" ${glStatusFilter === "closed" ? "selected" : ""}>Closed POs</option>
        </select>
        <label class="roster-filter-field">
          <input type="checkbox" class="gl-subsidiary-filter" ${glSubsidiaryOnly ? "checked" : ""} />
          <span>Subsidiary mismatch</span>
        </label>
        <label class="roster-filter-field">
          <input type="checkbox" class="gl-objectcode-filter" ${glObjectCodeOnly ? "checked" : ""} />
          <span>Object code mismatch</span>
        </label>
        <label class="roster-filter-field">
          <input type="checkbox" class="gl-above-filter" ${glAboveOnly ? "checked" : ""} />
          <span>Posted above PO</span>
        </label>
        <label class="roster-filter-field">
          <input type="checkbox" class="gl-missing-location-filter" ${glMissingLocationOnly ? "checked" : ""} />
          <span>Missing location</span>
        </label>
      </div>
      <p class="review-checklist-hint">
        <strong>Open/Closed</strong> is read off the PO's own Status text ("closed"/"fully invoiced" count as closed, everything
        else as open) -- a convenience filter only, never a substitute for reading the real PO Status column.
      </p>
      <div class="gl-table-wrap"></div>

      ${
        summary.unmatchedCount > 0
          ? `
      <h3>GL lines with a PO # not on file</h3>
      <p class="review-checklist-hint">
        These GL lines name a Purchase Order # that isn't in the Budget PO Tracker -- worth checking whether it's
        missing from the tracker, or was billed against the wrong PO #.
      </p>
      <div class="gl-unmatched-wrap"></div>
      `
          : ""
      }
    `;

    container.querySelector(".gl-import-btn").addEventListener("click", () => {
      container.querySelector(".gl-import-file").click();
    });
    container.querySelector(".gl-import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      await runImport(file);
    });

    container.querySelector(".gl-status-filter").addEventListener("change", (e) => {
      glStatusFilter = e.target.value;
      reconciledPage = 1;
      renderReconciledTable();
    });
    container.querySelector(".gl-subsidiary-filter").addEventListener("change", (e) => {
      glSubsidiaryOnly = e.target.checked;
      reconciledPage = 1;
      renderReconciledTable();
    });
    container.querySelector(".gl-objectcode-filter").addEventListener("change", (e) => {
      glObjectCodeOnly = e.target.checked;
      reconciledPage = 1;
      renderReconciledTable();
    });
    container.querySelector(".gl-above-filter").addEventListener("change", (e) => {
      glAboveOnly = e.target.checked;
      reconciledPage = 1;
      renderReconciledTable();
    });
    container.querySelector(".gl-missing-location-filter").addEventListener("change", (e) => {
      glMissingLocationOnly = e.target.checked;
      reconciledPage = 1;
      renderReconciledTable();
    });

    renderReconciledTable();
    if (summary.unmatchedCount > 0) renderUnmatchedTable();
  }

  async function renderReconciledTable() {
    const wrap = container.querySelector(".gl-table-wrap");
    wrap.innerHTML = `<p class="empty-note">Loading…</p>`;
    let pageData;
    try {
      pageData = await api.get(
        `/api/admin/gl/reconciliation/reconciled?${new URLSearchParams({
          page: String(reconciledPage),
          pageSize: String(GL_PAGE_SIZE),
          ...(glStatusFilter ? { status: glStatusFilter } : {}),
          ...(glSubsidiaryOnly && glObjectCodeOnly
            ? { coding: "either" }
            : glSubsidiaryOnly
              ? { coding: "subsidiary" }
              : glObjectCodeOnly
                ? { coding: "objectCode" }
                : {}),
          ...(glAboveOnly ? { aboveOnly: "true" } : {}),
          ...(glMissingLocationOnly ? { missingLocationOnly: "true" } : {}),
        })}`
      );
    } catch (err) {
      wrap.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    reconciledItems = pageData.items;
    if (summary.reconciledCount === 0) {
      wrap.innerHTML = `<p class="empty-note">No PO has a matching GL line yet -- import a GL report to populate this.</p>`;
      return;
    }
    if (pageData.total === 0) {
      wrap.innerHTML = `<p class="empty-note">No PO matches these filters.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="detail-table gl-table">
        <thead>
          <tr>
            <th>PO #</th>
            <th>Vendor</th>
            <th>Location</th>
            <th>WOM #</th>
            <th>PO Status</th>
            <th>GL Period</th>
            <th>PO Amount</th>
            <th>Actual paid (GL)</th>
            <th>Variance</th>
            <th>Subsidiary</th>
            <th>Object Code</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${reconciledItems
            .map(
              (r) => `
            <tr class="gl-row" data-po-id="${r.poId}">
              <td class="wom-code po-number-cell">${escapeHtml(r.poNumber || "—")}${poCopyHtml(r.poNumber)}</td>
              <td>${escapeHtml(r.vendorName || "No vendor matched")}</td>
              <td>${escapeHtml(r.locationCode || "—")}</td>
              <td class="wom-code">${escapeHtml(r.womNumber || "—")}</td>
              <td>${escapeHtml(r.poStatus || "—")}</td>
              <td>${escapeHtml(r.periodLabel || "—")}</td>
              <td>${formatMoney(r.poAmount)}</td>
              <td>${formatMoney(r.actualPaid)}</td>
              <td class="${r.variance > 0 ? "cost-amount-danger" : r.variance < 0 ? "cost-amount-ok" : ""}">${formatMoney(r.variance)}</td>
              <td>${r.subsidiaryMismatch ? `<span class="badge badge-rejected">Mismatch</span>` : `<span class="badge badge-approved">Matches</span>`}</td>
              <td>${r.objectCodeMismatch ? `<span class="badge badge-rejected">Mismatch</span>` : `<span class="badge badge-approved">Matches</span>`}</td>
              <td class="cost-row-chevron">&rsaquo;</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
      ${renderPager("gl-reconciled-pager", pageData)}
    `;
    wrap.querySelectorAll("tr.gl-row").forEach((row) => {
      row.addEventListener("click", () => {
        const r = reconciledItems.find((item) => String(item.poId) === row.dataset.poId);
        if (r) openPoDetailModal(r);
      });
    });
    wirePoCopyButtons(wrap);
    const prevBtn = wrap.querySelector(".gl-reconciled-pager .gl-pager-prev");
    const nextBtn = wrap.querySelector(".gl-reconciled-pager .gl-pager-next");
    if (prevBtn) prevBtn.addEventListener("click", () => { reconciledPage--; renderReconciledTable(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { reconciledPage++; renderReconciledTable(); });
  }

  async function renderUnmatchedTable() {
    const wrap = container.querySelector(".gl-unmatched-wrap");
    wrap.innerHTML = `<p class="empty-note">Loading…</p>`;
    let pageData;
    try {
      pageData = await api.get(`/api/admin/gl/reconciliation/unmatched?${new URLSearchParams({ page: String(unmatchedPage), pageSize: String(GL_PAGE_SIZE) })}`);
    } catch (err) {
      wrap.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="detail-table gl-table">
        <thead>
          <tr>
            <th>GL Period</th>
            <th>GL Date</th>
            <th>PO # (per GL)</th>
            <th>Object Account</th>
            <th>Subsidiary</th>
            <th>Amount</th>
            <th>Invoice #</th>
          </tr>
        </thead>
        <tbody>
          ${pageData.items
            .map(
              (e) => `
            <tr>
              <td>P${escapeHtml(String(e.periodNumber))}/FY${escapeHtml(String(e.fiscalYear))}</td>
              <td>${escapeHtml(e.glDate || "—")}</td>
              <td class="wom-code po-number-cell">${escapeHtml(e.purchaseOrder || "—")}${poCopyHtml(e.purchaseOrder)}</td>
              <td>${escapeHtml(e.objectAccount || "—")}</td>
              <td>${escapeHtml(e.subsidiary || "—")}</td>
              <td>${formatMoney(e.amount)}</td>
              <td>${escapeHtml(e.supplierInvoiceNumber || "—")}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
      ${renderPager("gl-unmatched-pager", pageData)}
    `;
    wirePoCopyButtons(wrap);
    const prevBtn = wrap.querySelector(".gl-unmatched-pager .gl-pager-prev");
    const nextBtn = wrap.querySelector(".gl-unmatched-pager .gl-pager-next");
    if (prevBtn) prevBtn.addEventListener("click", () => { unmatchedPage--; renderUnmatchedTable(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { unmatchedPage++; renderUnmatchedTable(); });
  }

  function openPoDetailModal(r) {
    const { body } = openModal({
      title: `PO ${r.poNumber || ""} -- ${r.description || "reconciliation"}`,
      size: "large",
      bodyHtml: `
        <table class="detail-table">
          <tbody>
            <tr><th>PO Number</th><td class="po-number-cell">${escapeHtml(r.poNumber || "—")}${poCopyHtml(r.poNumber)}</td><th>Location</th><td>${escapeHtml(r.locationCode || "—")}</td></tr>
            <tr><th>Vendor</th><td colspan="3">${escapeHtml(r.vendorName || "No vendor matched")}</td></tr>
            <tr><th>WOM #</th><td>${escapeHtml(r.womNumber || "—")}</td><th>GL lines</th><td>${r.glLineCount}</td></tr>
            <tr><th>PO Status</th><td>${escapeHtml(r.poStatus || "—")}</td><th>GL Period</th><td>${escapeHtml(r.periodLabel || "—")}</td></tr>
            <tr><th>Subsidiary</th><td>${r.subsidiaryMismatch ? "Mismatch" : "Matches"}</td><th>Object Code</th><td>${r.objectCodeMismatch ? "Mismatch" : "Matches"}</td></tr>
            <tr><th>PO Amount</th><td>${formatMoney(r.poAmount)}</td><th>Actual paid (GL)</th><td>${formatMoney(r.actualPaid)}</td></tr>
            <tr><th>Variance</th><td colspan="3">${formatMoney(r.variance)}</td></tr>
          </tbody>
        </table>
        <h4>GL lines</h4>
        <table class="detail-table">
          <thead><tr><th>Period</th><th>Date</th><th>Doc Type</th><th>Doc #</th><th>Object Account</th><th>Subsidiary</th><th>Amount</th><th>Invoice #</th></tr></thead>
          <tbody>
            ${r.lines
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
              </tr>
            `
              )
              .join("")}
            <tr class="gl-lines-total-row">
              <td colspan="6" style="text-align: right;"><strong>Total (actual paid)</strong></td>
              <td><strong>${formatMoney(r.actualPaid)}</strong></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      `,
    });
    wirePoCopyButtons(body);
  }

  async function runImport(file) {
    const { body, close } = openModal({ title: "Import GL Report", bodyHtml: `<p class="empty-note">Reading file…</p>` });
    let preview;
    try {
      preview = await api.uploadRawFile("/api/admin/gl/preview", file);
    } catch (err) {
      body.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    // Confirm the period(s) before committing -- a GL extract only says
    // which month(s) it covers via these two columns, and importing it
    // under the wrong assumption would silently overwrite the wrong
    // period's numbers. Most files are a single period (the normal monthly
    // extract); a rolling multi-month export gets a breakdown instead so
    // the admin can see every period it's about to touch before confirming.
    const periods = preview.periods;
    const isMultiPeriod = periods.length > 1;
    // A period "shrinks" when this file would replace more existing lines
    // than it brings -- the exact shape of the WOM Info report incident (a
    // narrower WOM-only export silently wiping a period that already had
    // the full monthly GL on file). Flagged loudly instead of folded into
    // the same neutral "will be replaced" wording every other re-import
    // gets, and gated behind an explicit acknowledgment before the import
    // button will even run.
    const shrinking = periods.filter((p) => p.existingImport && p.rowCount < p.existingImport.rowCount);
    const totalShrinkAmount = shrinking.reduce((sum, p) => sum + (p.existingImport.rowCount - p.rowCount), 0);
    const today = new Date();
    const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    body.innerHTML = `
      <p class="review-checklist-hint">
        ${
          isMultiPeriod
            ? `This file covers <strong>${periods.length} different periods</strong>, ${preview.totalRowCount} GL lines total.
               Importing will replace GL data for <strong>every period listed below</strong> -- confirm that's what you meant to do.`
            : `This file reads as <strong>${escapeHtml(monthName(periods[0].periodNumber))} 20${periods[0].fiscalYear}</strong>
               (Period ${periods[0].periodNumber}/FY${periods[0].fiscalYear}), ${periods[0].rowCount} GL line${periods[0].rowCount === 1 ? "" : "s"}.
               ${
                 periods[0].existingImport
                   ? `An import already exists for this exact period -- <strong>${periods[0].existingImport.rowCount} GL line${
                       periods[0].existingImport.rowCount === 1 ? "" : "s"
                     }</strong>, imported ${new Date(periods[0].existingImport.createdAt).toLocaleString()} (${
                       periods[0].existingImport.sourceFileName ? escapeHtml(periods[0].existingImport.sourceFileName) : "no file name on record"
                     }). Importing this file will <strong>replace it entirely</strong> -- confirm that's what you meant to do.`
                   : `Importing will replace any GL data already on file for that exact period -- confirm that's the report you meant to drop in.`
               }`
        }
      </p>
      ${
        isMultiPeriod
          ? `<table class="detail-table">
              <thead><tr><th>Period</th><th>GL Lines</th><th>Existing import on file</th></tr></thead>
              <tbody>
                ${periods
                  .map((p) => {
                    const isShrinking = p.existingImport && p.rowCount < p.existingImport.rowCount;
                    return `
                  <tr class="${isShrinking ? "gl-import-shrink-row" : ""}">
                    <td>${escapeHtml(monthName(p.periodNumber))} 20${p.fiscalYear} (P${p.periodNumber}/FY${p.fiscalYear})</td>
                    <td>${p.rowCount}</td>
                    <td>${
                      p.existingImport
                        ? `${p.existingImport.rowCount} lines, imported ${new Date(p.existingImport.createdAt).toLocaleDateString()}${
                            isShrinking
                              ? ` -- <strong class="gl-import-shrink-warning">⚠ will REMOVE ${p.existingImport.rowCount - p.rowCount} lines</strong>`
                              : " -- will be replaced"
                          }`
                        : "None yet"
                    }</td>
                  </tr>
                `;
                  })
                  .join("")}
              </tbody>
            </table>`
          : ""
      }
      ${
        shrinking.length > 0
          ? `<p class="gl-import-shrink-warning">
              ⚠ This import will <strong>remove ${totalShrinkAmount} GL line${totalShrinkAmount === 1 ? "" : "s"}</strong> across
              ${shrinking.length} period${shrinking.length === 1 ? "" : "s"} that${shrinking.length === 1 ? "" : "'ve"} already got more data on file than this file brings --
              usually a sign this file only covers part of what's already imported (e.g. a WOM-only extract, not the full monthly GL report).
              Double check this is really the file you meant before continuing.
            </p>
            <label class="roster-filter-field gl-import-shrink-ack-row">
              <input type="checkbox" class="gl-import-shrink-ack" />
              <span>I understand this will remove ${totalShrinkAmount} GL line${totalShrinkAmount === 1 ? "" : "s"} already on file, and that's what I meant to do</span>
            </label>`
          : ""
      }
      <label class="profile-field">
        <span>What calendar month is this report for?</span>
        <input type="month" class="gl-import-calendar-month" value="${defaultMonth}" required />
      </label>
      <div class="modal-form-actions">
        <button type="button" class="btn btn-secondary gl-import-cancel">Cancel</button>
        <button type="button" class="btn btn-primary gl-import-confirm" ${shrinking.length > 0 ? "disabled" : ""}>Yes, import it</button>
      </div>
    `;
    body.querySelector(".gl-import-cancel").addEventListener("click", close);
    const confirmBtn = body.querySelector(".gl-import-confirm");
    const ackCheckbox = body.querySelector(".gl-import-shrink-ack");
    if (ackCheckbox) {
      ackCheckbox.addEventListener("change", (e) => {
        confirmBtn.disabled = !e.target.checked;
      });
    }
    confirmBtn.addEventListener("click", async () => {
      const calendarMonth = body.querySelector(".gl-import-calendar-month").value;
      if (!calendarMonth) {
        window.alert("Pick which calendar month this report is for before importing.");
        return;
      }
      body.innerHTML = `<p class="empty-note">Importing…</p>`;
      try {
        const result = await api.uploadRawFile("/api/admin/gl/import", file, { calendarMonth });
        body.innerHTML = `
          <p class="review-checklist-hint">
            Imported <strong>${result.rowCount}</strong> GL line${result.rowCount === 1 ? "" : "s"}
            ${result.periods.length > 1 ? `across ${result.periods.length} periods` : `for Period ${result.periods[0].periodNumber}/FY${result.periods[0].fiscalYear}`}
            -- ${result.matchedCount} GL lines matched to a PO on file,
            ${result.unmatchedCount} GL lines named a PO # that isn't in the Budget PO Tracker,
            ${result.noPoReferenceCount ?? 0} GL lines with no PO reference (payroll, journal entries, accruals, etc.).
          </p>
          <div class="modal-form-actions">
            <button type="button" class="btn btn-primary gl-import-close">Done</button>
          </div>
        `;
        body.querySelector(".gl-import-close").addEventListener("click", async () => {
          close();
          await draw();
        });
      } catch (err) {
        body.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }
}
