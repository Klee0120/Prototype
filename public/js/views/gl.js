import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { openModal } from "../modal.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  let glCodingFilter = ""; // "" | "subsidiary" | "objectCode" | "either"
  let glAboveOnly = false; // variance > 0 ("posted above PO")
  let glMissingLocationOnly = false;

  const GL_PAGE_SIZE = 100;
  let reconciledPage = 1;
  let unmatchedPage = 1;
  let noPoReferencePage = 1;
  let reconciledItems = []; // current page only, for the detail-modal click lookup

  await draw();

  async function draw() {
    container.innerHTML = `<p class="empty-note">Loading…</p>`;
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
        <h3 style="margin: 0;">GL Reconciliation</h3>
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
            ? `Last import: Period ${lastImport.periodNumber}/FY${lastImport.fiscalYear}, ${new Date(lastImport.createdAt).toLocaleString()} -- ${lastImport.rowCount} GL lines: ${lastImport.matchedCount} GL lines matched to a PO, ${lastImport.unmatchedCount} GL lines with a PO # not on file, ${lastImport.noPoReferenceCount ?? 0} GL lines with no PO reference (payroll, journal entries, accruals, etc.).`
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
        <div class="task-tile"><div class="task-tile-count">${summary.noPoReferenceCount}</div><div class="task-tile-label">GL lines, no PO reference</div></div>
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
        <select class="gl-coding-filter">
          <option value="">Any coding</option>
          <option value="subsidiary" ${glCodingFilter === "subsidiary" ? "selected" : ""}>Subsidiary mismatch</option>
          <option value="objectCode" ${glCodingFilter === "objectCode" ? "selected" : ""}>Object code mismatch</option>
          <option value="either" ${glCodingFilter === "either" ? "selected" : ""}>Any coding mismatch</option>
        </select>
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

      ${
        summary.noPoReferenceCount > 0
          ? `
      <h3>GL lines with no PO reference</h3>
      <p class="review-checklist-hint">
        These GL lines never named a Purchase Order # at all -- payroll, journal entries, accruals, and similar
        entries legitimately have no PO. Not an exception by itself; listed here for visibility, not as a
        to-do.
      </p>
      <div class="gl-no-po-ref-wrap"></div>
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
    container.querySelector(".gl-coding-filter").addEventListener("change", (e) => {
      glCodingFilter = e.target.value;
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
    if (summary.noPoReferenceCount > 0) renderNoPoReferenceTable();
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
          ...(glCodingFilter ? { coding: glCodingFilter } : {}),
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
              <td class="wom-code">${escapeHtml(r.poNumber || "—")}</td>
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
              <td class="wom-code">${escapeHtml(e.purchaseOrder || "—")}</td>
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
    const prevBtn = wrap.querySelector(".gl-unmatched-pager .gl-pager-prev");
    const nextBtn = wrap.querySelector(".gl-unmatched-pager .gl-pager-next");
    if (prevBtn) prevBtn.addEventListener("click", () => { unmatchedPage--; renderUnmatchedTable(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { unmatchedPage++; renderUnmatchedTable(); });
  }

  // Same shape as renderUnmatchedTable, but "PO # (per GL)" would always
  // read "—" here (that's the whole point of this list) -- Document Type is
  // shown in its place instead, since that's what actually distinguishes a
  // payroll/journal/accrual line from a real invoice.
  async function renderNoPoReferenceTable() {
    const wrap = container.querySelector(".gl-no-po-ref-wrap");
    wrap.innerHTML = `<p class="empty-note">Loading…</p>`;
    let pageData;
    try {
      pageData = await api.get(
        `/api/admin/gl/reconciliation/no-po-reference?${new URLSearchParams({ page: String(noPoReferencePage), pageSize: String(GL_PAGE_SIZE) })}`
      );
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
            <th>Document Type</th>
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
              <td>${escapeHtml(e.documentType || "—")}</td>
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
      ${renderPager("gl-no-po-ref-pager", pageData)}
    `;
    const prevBtn = wrap.querySelector(".gl-no-po-ref-pager .gl-pager-prev");
    const nextBtn = wrap.querySelector(".gl-no-po-ref-pager .gl-pager-next");
    if (prevBtn) prevBtn.addEventListener("click", () => { noPoReferencePage--; renderNoPoReferenceTable(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { noPoReferencePage++; renderNoPoReferenceTable(); });
  }

  function openPoDetailModal(r) {
    openModal({
      title: `PO ${r.poNumber || ""} -- ${r.description || "reconciliation"}`,
      size: "large",
      bodyHtml: `
        <table class="detail-table">
          <tbody>
            <tr><th>Vendor</th><td>${escapeHtml(r.vendorName || "No vendor matched")}</td><th>Location</th><td>${escapeHtml(r.locationCode || "—")}</td></tr>
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

    // Confirm the period before committing -- a GL extract only says which
    // month it covers via these two columns, and importing it under the
    // wrong assumption would silently overwrite the wrong period's numbers.
    const existing = preview.existingImport;
    body.innerHTML = `
      <p class="review-checklist-hint">
        This file reads as <strong>${escapeHtml(monthName(preview.periodNumber))} 20${preview.fiscalYear}</strong>
        (Period ${preview.periodNumber}/FY${preview.fiscalYear}), ${preview.rowCount} GL line${preview.rowCount === 1 ? "" : "s"}.
        ${
          existing
            ? `An import already exists for this exact period -- <strong>${existing.rowCount} GL line${existing.rowCount === 1 ? "" : "s"}</strong>,
               imported ${new Date(existing.createdAt).toLocaleString()} (${existing.sourceFileName ? escapeHtml(existing.sourceFileName) : "no file name on record"}).
               Importing this file will <strong>replace it entirely</strong> -- confirm that's what you meant to do.`
            : `Importing will replace any GL data already on file for that exact period -- confirm that's the report you meant to drop in.`
        }
      </p>
      <div class="modal-form-actions">
        <button type="button" class="btn btn-secondary gl-import-cancel">Cancel</button>
        <button type="button" class="btn btn-primary gl-import-confirm">Yes, import it</button>
      </div>
    `;
    body.querySelector(".gl-import-cancel").addEventListener("click", close);
    body.querySelector(".gl-import-confirm").addEventListener("click", async () => {
      body.innerHTML = `<p class="empty-note">Importing…</p>`;
      try {
        const result = await api.uploadRawFile("/api/admin/gl/import", file);
        body.innerHTML = `
          <p class="review-checklist-hint">
            Imported <strong>${result.rowCount}</strong> GL line${result.rowCount === 1 ? "" : "s"} for Period
            ${result.periodNumber}/FY${result.fiscalYear} -- ${result.matchedCount} GL lines matched to a PO on file,
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
