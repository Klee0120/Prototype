import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";
import { openModal } from "../modal.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// The dataviz skill's validated 8-slot categorical palette (light mode --
// this app has no dark theme). A 9th-and-beyond category is never a
// generated hue; it folds into "Other" instead (see buildChartSlices).
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const OTHER_COLOR = "#8a8a86";
const MAX_SLICES = PALETTE.length - 1; // one slot reserved for "Other"
const DETAIL_PAGE_SIZE = 50;

// Display-only friendlier names for a few of GL's own abbreviated category
// labels -- "Sub" is Toyota's own shorthand for Subcontracting, i.e. the
// vendor-paid contracted services (landscaping, HVAC, janitorial, etc.)
// that only show up once the PO-reference toggle is checked. The category
// used for filtering/the drill-down query is always the real GL label
// (see data-category below) -- this only swaps what's shown on screen.
const CATEGORY_DISPLAY_NAMES = {
  "Sub Recur Labor": "Contracted Services – Recurring Labor",
  "Sub NonRecur Lab": "Contracted Services – Non-Recurring Labor",
  "Sub Recur Matl": "Contracted Services – Recurring Materials",
  "Sub NonRecur Matl": "Contracted Services – Non-Recurring Materials",
  "Sub NonRecur MatlX": "Contracted Services – Non-Recurring Materials (X)",
};

function displayCategoryName(category) {
  return CATEGORY_DISPLAY_NAMES[category] || category;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeDonutArc(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const startOuter = polarToCartesian(cx, cy, rOuter, endAngle);
  const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
  const startInner = polarToCartesian(cx, cy, rInner, endAngle);
  const endInner = polarToCartesian(cx, cy, rInner, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${startInner.x} ${startInner.y}`,
    "Z",
  ].join(" ");
}

// Only positive totals make a sensible wedge -- a category that nets
// negative (credits/reversals outweighing charges) still shows in the full
// table below with its real signed total, just not as a slice here. Beyond
// the first 7, everything folds into one "Other" slice/color rather than
// generating more hues (see the palette's own documented cap).
function buildChartSlices(categories) {
  const positive = categories.filter((c) => c.total > 0);
  const top = positive.slice(0, MAX_SLICES);
  const rest = positive.slice(MAX_SLICES);
  const otherTotal = rest.reduce((sum, c) => sum + c.total, 0);
  const slices = top.map((c, i) => ({ label: displayCategoryName(c.category), total: c.total, color: PALETTE[i] }));
  if (otherTotal > 0) slices.push({ label: `Other (${rest.length})`, total: otherTotal, color: OTHER_COLOR });
  return slices;
}

function renderDonut(slices, totalForChart) {
  if (totalForChart <= 0) return `<p class="empty-note">Nothing to chart yet.</p>`;
  const cx = 110;
  const cy = 110;
  const rOuter = 100;
  const rInner = 58;
  let angle = 0;
  const paths = slices
    .map((s) => {
      const sweep = (s.total / totalForChart) * 360;
      const startAngle = angle;
      const endAngle = angle + sweep;
      angle = endAngle;
      // A single 100% slice degenerates the arc math (start === end) --
      // draw a full ring instead.
      if (sweep >= 359.99) {
        return `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="${s.color}" stroke-width="${rOuter - rInner}"><title>${escapeHtml(s.label)}: ${formatMoney(s.total)}</title></circle>`;
      }
      const d = describeDonutArc(cx, cy, rOuter, rInner, startAngle, endAngle);
      const pct = ((s.total / totalForChart) * 100).toFixed(1);
      return `<path d="${d}" fill="${s.color}"><title>${escapeHtml(s.label)}: ${formatMoney(s.total)} (${pct}%)</title></path>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="Spend by category">
      ${paths}
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="spend-donut-total-label">${formatMoney(totalForChart)}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="spend-donut-total-sublabel">charted</text>
    </svg>
  `;
}

// Defaults to the GL lines with no PO reference and no WOM reference --
// payroll burden, journal entries, Concur, Pcard, fleet accruals -- since
// GL Reconciliation's own tiles already break the PO-matched and
// PO-number-not-found buckets down separately, and WOM-coded labor is
// already tracked through the WOM feature itself. The two checkboxes below
// widen either scope independently, for comparison.
let includePoReferenced = false;
let includeWomReferenced = false;
// Layers the Budget PO Tracker's own outstanding commitment on top of GL
// actuals -- an Active PO's amount minus whatever's already matched to it
// in the GL, so a partially-invoiced PO only contributes its real
// remaining exposure (never the same dollar counted twice). A point-in-time
// snapshot of today's open commitment, not tied to the fiscal year/period
// filter the way a GL line is -- see db.getPoRemainingAmounts.
let includePoRemaining = false;
// Checking all three scope toggles one after another used to re-fetch and
// re-render on every single click -- check a box, wait for the load, check
// the next, wait again. Debouncing collapses a quick run of clicks into one
// reload after the last change settles, same pattern as the search-input
// debounce elsewhere in this app (e.g. pos.js's debounceRefetch).
let spendToggleDebounceTimer = null;
function debouncedRerenderSpendBreakdown(container) {
  clearTimeout(spendToggleDebounceTimer);
  spendToggleDebounceTimer = setTimeout(() => renderSpendBreakdown(container), 350);
}
// null until resolved against the fiscal years actually on file (see
// resolveDefaultFiscalYear) -- today's calendar year if it has data,
// otherwise whatever's most recent, so last year's numbers don't silently
// blend into this year's once a new fiscal year starts importing alongside
// the old one.
let selectedFiscalYear = null;
// A fiscal-month-to-fiscal-month narrowing within the selected year --
// period numbers, defaulting to that year's full first-to-last range (set
// in renderSpendBreakdown once the calendar loads). periodRangeFiscalYear
// tracks which year that range belongs to, so switching years resets it to
// the new year's own full range rather than carrying over period numbers
// that happen to share the same 1-12 numbering but mean a different month.
let periodFrom = null;
let periodTo = null;
let periodRangeFiscalYear = null;
let cachedFiscalYears = null;
const fiscalCalendarCache = new Map();

async function loadFiscalYears() {
  if (cachedFiscalYears) return cachedFiscalYears;
  const imports = await api.get("/api/admin/gl/imports");
  const years = [...new Set(imports.map((i) => i.fiscalYear))].sort((a, b) => b - a);
  cachedFiscalYears = years;
  return years;
}

async function loadFiscalCalendar(fiscalYear) {
  if (!fiscalCalendarCache.has(fiscalYear)) {
    fiscalCalendarCache.set(fiscalYear, api.get(`/api/admin/gl/fiscal-calendar?fiscalYear=${fiscalYear}`));
  }
  return fiscalCalendarCache.get(fiscalYear);
}

function resolveDefaultFiscalYear(years) {
  const currentTwoDigit = new Date().getFullYear() % 100;
  if (years.includes(currentTwoDigit)) return currentTwoDigit;
  return years[0] ?? currentTwoDigit;
}

// Scoped to the admin nav (see adminReview.js's Spend Breakdown tab), open
// to the same global territory filter every other Financials/PO/WOM view
// already respects -- re-rendered automatically when that filter changes
// (adminReview.js's own onTerritoryChange listener re-runs draw()).
export async function renderSpendBreakdown(container) {
  renderLoadingState(container, loadingLabelFor("Spend Analysis"));
  const territory = getTerritory();

  let years;
  try {
    years = await loadFiscalYears();
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (selectedFiscalYear == null) selectedFiscalYear = resolveDefaultFiscalYear(years);
  const allYearsSelected = selectedFiscalYear === "all";

  // The month-range dropdowns only make sense within one fiscal year --
  // "all fiscal years" hides them entirely rather than letting a stale
  // period range from a different year silently carry over. The fiscal
  // calendar itself (server/data/db.js's getGlFiscalCalendar) is a fixed
  // table of real close dates published a year at a time, not something
  // computable in advance -- a fiscal year that isn't on it yet (next
  // year, before Toyota's calendar for it exists) just means the month
  // dropdowns have nothing to offer yet, not that the fiscal-year filter
  // itself stops working (that part is plain fiscal_year matching on the
  // GL data, independent of this reference table).
  let calendar = [];
  if (!allYearsSelected) {
    try {
      calendar = await loadFiscalCalendar(selectedFiscalYear);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (calendar.length) {
      if (periodRangeFiscalYear !== selectedFiscalYear) {
        periodFrom = calendar[0].periodNumber;
        periodTo = calendar[calendar.length - 1].periodNumber;
        periodRangeFiscalYear = selectedFiscalYear;
      }
    } else {
      periodFrom = null;
      periodTo = null;
      periodRangeFiscalYear = null;
    }
  }
  const hasCalendar = calendar.length > 0;

  let data;
  try {
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    if (!allYearsSelected) {
      params.set("fiscalYear", String(selectedFiscalYear));
      if (hasCalendar) {
        if (periodFrom != null) params.set("periodFrom", String(periodFrom));
        if (periodTo != null) params.set("periodTo", String(periodTo));
      }
    }
    if (includePoReferenced) params.set("noPoReferenceOnly", "false");
    if (includeWomReferenced) params.set("noWomReferenceOnly", "false");
    if (includePoRemaining) params.set("includePoRemaining", "true");
    data = await api.get(`/api/admin/gl/spend-breakdown?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const slices = buildChartSlices(data.categories);
  const totalForChart = slices.reduce((sum, s) => sum + s.total, 0);
  const maxCategoryTotal = Math.max(1, ...data.categories.map((c) => Math.abs(c.total)));
  const isFullYearRange = !calendar.length || (periodFrom === calendar[0].periodNumber && periodTo === calendar[calendar.length - 1].periodNumber);
  const monthRangeLabel =
    !allYearsSelected && !isFullYearRange
      ? (() => {
          const fromName = calendar.find((p) => p.periodNumber === periodFrom)?.monthName;
          const toName = calendar.find((p) => p.periodNumber === periodTo)?.monthName;
          return fromName && toName ? ` (${fromName}${fromName === toName ? "" : ` – ${toName}`})` : "";
        })()
      : "";
  const fyLabel = allYearsSelected ? "All fiscal years" : `FY20${selectedFiscalYear}${monthRangeLabel}`;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-header-title">Spend Analysis</h1>
        <p class="page-header-subtitle">
          ${includePoReferenced ? "Every GL line" : "GL lines with no PO reference"}, by chart-of-accounts category and territory --
          <strong>${fyLabel}</strong>
        </p>
        <p class="overview-hint">
          ${data.entryCount.toLocaleString()} GL line${data.entryCount === 1 ? "" : "s"} on file${territory ? ` for <strong>${escapeHtml(territory)}</strong>` : ""},
          totaling ${formatMoney(data.totalAmount)}.
          ${
            includePoReferenced
              ? "Every transaction type, including PO-referenced lines."
              : `Scoped to GL lines with no PO reference -- payroll burden, journal entries, Concur, Pcard, fleet accruals --
                 which is where things like health insurance and cell phone charges actually post. GL Reconciliation already
                 breaks down the PO-matched and PO-number-not-found buckets.`
          }
          Click a row below to see the actual GL lines behind it.
          ${
            includePoRemaining && data.poRemainingCount > 0
              ? `Totals below include ${formatMoney(data.poRemainingTotal)} of outstanding commitment across ${data.poRemainingCount} open
                 PO${data.poRemainingCount === 1 ? "" : "s"} not yet reflected in the GL -- drilling into a row still only shows the GL
                 lines matched so far, not the open PO itself.`
              : ""
          }
        </p>
        <div class="spend-filters-row">
          <label class="spend-fy-select-label">
            Fiscal year
            <select class="spend-fy-select">
              ${years.map((y) => `<option value="${y}" ${!allYearsSelected && y === selectedFiscalYear ? "selected" : ""}>FY20${y}</option>`).join("")}
              <option value="all" ${allYearsSelected ? "selected" : ""}>All fiscal years</option>
            </select>
          </label>
          ${
            !allYearsSelected && hasCalendar
              ? `
          <label class="spend-fy-select-label">
            From month
            <select class="spend-period-from-select">
              ${calendar.map((p) => `<option value="${p.periodNumber}" ${periodFrom === p.periodNumber ? "selected" : ""}>${escapeHtml(p.monthName)}</option>`).join("")}
            </select>
          </label>
          <label class="spend-fy-select-label">
            To month
            <select class="spend-period-to-select">
              ${calendar.map((p) => `<option value="${p.periodNumber}" ${periodTo === p.periodNumber ? "selected" : ""}>${escapeHtml(p.monthName)}</option>`).join("")}
            </select>
          </label>`
              : !allYearsSelected
                ? `<p class="spend-no-calendar-note">Month breakdown isn't available for FY20${selectedFiscalYear} yet.</p>`
                : ""
          }
          <label class="spend-po-toggle">
            <input type="checkbox" class="spend-include-po-toggle" ${includePoReferenced ? "checked" : ""} />
            Include GL lines that do have a PO reference too
          </label>
          <label class="spend-po-toggle">
            <input type="checkbox" class="spend-include-wom-toggle" ${includeWomReferenced ? "checked" : ""} />
            Include GL lines that do have a WOM reference too
          </label>
          <label class="spend-po-toggle">
            <input type="checkbox" class="spend-include-po-remaining-toggle" ${includePoRemaining ? "checked" : ""} />
            Include current estimated PO (PO Tracker amount not yet on GL)
          </label>
          <form class="spend-search-form">
            <input type="search" class="spend-search-input" placeholder="Search PO # or WOM #" />
            <button type="submit" class="btn btn-secondary">Search</button>
          </form>
        </div>
      </div>
    </div>
    ${
      data.unassignedLocationCount > 0
        ? `<p class="review-checklist-hint spend-unassigned-note">
             ${data.unassignedLocationCount.toLocaleString()} line${data.unassignedLocationCount === 1 ? "" : "s"} couldn't be matched to a
             location and fall under "Unassigned" in the territory breakdown below -- check those business units/facility
             names against Locations if that count looks high.
           </p>`
        : ""
    }
    <div class="spend-breakdown-layout">
      <div class="spend-donut-wrap">
        ${renderDonut(slices, totalForChart)}
        <div class="spend-donut-legend">
          ${slices
            .map(
              (s) => `
            <div class="spend-legend-row">
              <span class="spend-legend-swatch" style="background:${s.color}"></span>
              <span class="spend-legend-label">${escapeHtml(s.label)}</span>
              <span class="spend-legend-value">${formatMoney(s.total)}</span>
            </div>`
            )
            .join("")}
        </div>
      </div>
      <div class="spend-territory-wrap">
        <h3 class="spend-section-heading">By Territory</h3>
        <table class="detail-table spend-territory-table spend-clickable-table">
          <thead><tr><th>Territory</th><th>Total</th><th>Lines</th></tr></thead>
          <tbody>
            ${data.territories
              .map(
                (t) => `
              <tr class="spend-drill-row" data-territory="${escapeHtml(t.territory)}" tabindex="0">
                <td>${escapeHtml(t.territory)}</td>
                <td>${formatMoney(t.total)}</td>
                <td>${t.count.toLocaleString()}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
    <h3 class="spend-section-heading">Every Category</h3>
    <p class="review-checklist-hint">Includes negative-net categories (credits/reversals), which the chart above can't wedge. Click a row to see its GL lines.</p>
    <table class="detail-table spend-category-table spend-clickable-table">
      <thead><tr><th>Category</th><th>Total</th><th>Lines</th><th></th></tr></thead>
      <tbody>
        ${data.categories
          .map((c) => {
            const barPct = Math.min(100, (Math.abs(c.total) / maxCategoryTotal) * 100);
            return `
          <tr class="spend-drill-row" data-category="${escapeHtml(c.category)}" tabindex="0">
            <td>${escapeHtml(displayCategoryName(c.category))}</td>
            <td class="${c.total < 0 ? "cost-amount-danger" : ""}">${formatMoney(c.total)}</td>
            <td>${c.count.toLocaleString()}</td>
            <td class="spend-bar-cell"><span class="spend-bar" style="width:${barPct}%"></span></td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;

  container.querySelector(".spend-include-po-toggle")?.addEventListener("change", (e) => {
    includePoReferenced = e.target.checked;
    debouncedRerenderSpendBreakdown(container);
  });
  container.querySelector(".spend-include-wom-toggle")?.addEventListener("change", (e) => {
    includeWomReferenced = e.target.checked;
    debouncedRerenderSpendBreakdown(container);
  });
  container.querySelector(".spend-include-po-remaining-toggle")?.addEventListener("change", (e) => {
    includePoRemaining = e.target.checked;
    debouncedRerenderSpendBreakdown(container);
  });
  container.querySelector(".spend-fy-select")?.addEventListener("change", (e) => {
    const v = e.target.value;
    selectedFiscalYear = v === "all" ? "all" : Number(v);
    renderSpendBreakdown(container);
  });
  container.querySelector(".spend-period-from-select")?.addEventListener("change", (e) => {
    periodFrom = Number(e.target.value);
    renderSpendBreakdown(container);
  });
  container.querySelector(".spend-period-to-select")?.addEventListener("change", (e) => {
    periodTo = Number(e.target.value);
    renderSpendBreakdown(container);
  });
  container.querySelector(".spend-search-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = container.querySelector(".spend-search-input").value.trim();
    if (!query) return;
    openSpendDetailModal({
      search: query,
      territoryGlobal: territory,
      fiscalYear: allYearsSelected ? null : selectedFiscalYear,
      periodFrom: allYearsSelected || !hasCalendar ? null : periodFrom,
      periodTo: allYearsSelected || !hasCalendar ? null : periodTo,
      fyLabel,
    });
  });

  const openRowDetail = (row) => {
    const category = row.dataset.category || null;
    const territoryFilter = row.dataset.territory || null;
    openSpendDetailModal({
      category,
      territory: territoryFilter,
      territoryGlobal: territory,
      fiscalYear: allYearsSelected ? null : selectedFiscalYear,
      periodFrom: allYearsSelected || !hasCalendar ? null : periodFrom,
      periodTo: allYearsSelected || !hasCalendar ? null : periodTo,
      noPoReferenceOnly: !includePoReferenced,
      noWomReferenceOnly: !includeWomReferenced,
      fyLabel,
    });
  };
  container.querySelectorAll(".spend-drill-row").forEach((row) => {
    row.addEventListener("click", () => openRowDetail(row));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openRowDetail(row);
      }
    });
  });
}

function formatGlDetailRow(item) {
  return `
    <tr class="cellphone-row-clickable" data-gl-id="${item.id}" title="Click to view the full GL line">
      <td>${escapeHtml(item.glDate || "—")}</td>
      <td>${escapeHtml(item.objectAccount || "—")}</td>
      <td>${escapeHtml(item.vendorOrDescription || "—")}</td>
      <td>${escapeHtml(item.territory || "Unassigned")}</td>
      <td>${escapeHtml(item.locationCode || "—")}</td>
      <td class="${item.amount < 0 ? "cost-amount-danger" : ""}">${formatMoney(item.amount)}</td>
    </tr>
  `;
}

// The summary row only shows the handful of fields worth a quick scan --
// clicking it pops up every other field the actual GL export line carries
// (document #, business unit, batch #, PO, the full un-truncated remark,
// etc.), same shape/purpose as Meals' own full-GL-line popup.
function openGlLineModal(it) {
  const g = it.glLine || {};
  const row = (label, value) => `
    <div class="gl-line-detail-row">
      <span class="gl-line-detail-label">${escapeHtml(label)}</span>
      <span class="gl-line-detail-value">${value != null && value !== "" ? escapeHtml(String(value)) : "—"}</span>
    </div>
  `;
  openModal({
    title: "Full GL line",
    bodyHtml: `
      <div class="gl-line-detail">
        ${row("Vendor / description", it.vendorOrDescription)}
        ${row("Remark (full)", g.remark)}
        ${row("Name alpha", g.nameAlpha)}
        ${row("GL date", it.glDate)}
        ${row("Amount", it.amount != null ? formatMoney(it.amount) : null)}
        ${row("Territory", it.territory)}
        ${row("Location code", it.locationCode)}
        ${row("Object account", g.objectAccount)}
        ${row("Object account code", g.objectAccountCode)}
        ${row("Document type", g.documentType)}
        ${row("Document number", g.documentNumber)}
        ${row("Journal entry line #", g.journalEntryLineNumber)}
        ${row("Business unit", g.businessUnit)}
        ${row("Subsidiary", g.subsidiary)}
        ${row("Batch number", g.batchNumber)}
        ${row("Supplier invoice number", g.supplierInvoiceNumber)}
        ${row("Invoice date", g.invoiceDate ? String(g.invoiceDate).slice(0, 10) : null)}
        ${row("Purchase order", g.purchaseOrder)}
        ${row("Subledger (WOM)", g.subledgerGl)}
      </div>
    `,
  });
}

// A category or territory row's own GL lines -- "which phones did we pay
// for, and when" instead of just a total. Same filters as the row it was
// clicked from, so the modal's own total always lines up with the row.
async function openSpendDetailModal({ category, territory, territoryGlobal, fiscalYear, periodFrom, periodTo, noPoReferenceOnly, noWomReferenceOnly, search, fyLabel }) {
  const title = search ? `Search "${search}" -- GL lines` : category ? `${displayCategoryName(category)} -- GL lines` : `${territory} -- GL lines`;
  const { body } = openModal({ title, bodyHtml: `<div class="spend-detail-modal-body">Loading…</div>`, size: "large" });

  let page = 1;
  const effectiveTerritory = territory || territoryGlobal || null;

  async function loadPage() {
    body.innerHTML = `<div class="spend-detail-modal-body">Loading…</div>`;
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (effectiveTerritory) params.set("territory", effectiveTerritory);
    if (fiscalYear != null) params.set("fiscalYear", String(fiscalYear));
    if (periodFrom != null) params.set("periodFrom", String(periodFrom));
    if (periodTo != null) params.set("periodTo", String(periodTo));
    if (search) {
      // Searching for a specific PO # or WOM # overrides the no-reference
      // defaults server-side (see db.getGlSpendDetailPage) -- not sent here
      // at all, so there's nothing to accidentally contradict.
      params.set("search", search);
    } else {
      params.set("noPoReferenceOnly", String(noPoReferenceOnly));
      params.set("noWomReferenceOnly", String(noWomReferenceOnly));
    }
    params.set("page", String(page));
    params.set("pageSize", String(DETAIL_PAGE_SIZE));

    let pageData;
    try {
      pageData = await api.get(`/api/admin/gl/spend-breakdown/detail?${params}`);
    } catch (err) {
      body.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const totalPages = Math.max(1, Math.ceil(pageData.total / pageData.pageSize));
    const start = pageData.total === 0 ? 0 : (page - 1) * pageData.pageSize + 1;
    const end = Math.min(pageData.total, page * pageData.pageSize);

    body.innerHTML = `
      <p class="review-checklist-hint">${fyLabel}${effectiveTerritory ? ` -- ${escapeHtml(effectiveTerritory)}` : ""} -- ${pageData.total.toLocaleString()} GL line${pageData.total === 1 ? "" : "s"}</p>
      <table class="detail-table spend-detail-table">
        <thead>
          <tr><th>GL Date</th><th>Object Account</th><th>Vendor / Description</th><th>Territory</th><th>Location Code</th><th>Amount</th></tr>
        </thead>
        <tbody>
          ${pageData.items.length ? pageData.items.map(formatGlDetailRow).join("") : `<tr><td colspan="6" class="empty-note">No GL lines on file for this.</td></tr>`}
        </tbody>
      </table>
      ${
        totalPages > 1
          ? `<div class="gl-pager spend-detail-pager">
               <button type="button" class="btn btn-secondary spend-detail-prev" ${page <= 1 ? "disabled" : ""}>&larr; Prev</button>
               <span>Showing ${start}&ndash;${end} of ${pageData.total}</span>
               <button type="button" class="btn btn-secondary spend-detail-next" ${page >= totalPages ? "disabled" : ""}>Next &rarr;</button>
             </div>`
          : ""
      }
    `;

    if (pageData.items.length) {
      const byId = new Map(pageData.items.map((it) => [String(it.id), it]));
      body.querySelectorAll("[data-gl-id]").forEach((row) => {
        row.addEventListener("click", () => {
          const it = byId.get(row.dataset.glId);
          if (it) openGlLineModal(it);
        });
      });
    }

    body.querySelector(".spend-detail-prev")?.addEventListener("click", () => {
      page--;
      loadPage();
    });
    body.querySelector(".spend-detail-next")?.addEventListener("click", () => {
      page++;
      loadPage();
    });
  }

  await loadPage();
}
