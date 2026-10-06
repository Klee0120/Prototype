import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";
import { openModal } from "../modal.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

let selectedFiscalYear = null;
let groupBy = "month"; // "month" | "description"
let cachedFiscalYears = null;
let searchQuery = "";
let lastData = null; // last-fetched payload, re-filtered/re-rendered locally on search so typing never refetches or loses input focus

function matchesSearch(text, query) {
  return !query || (text || "").toLowerCase().includes(query);
}

async function loadFiscalYears() {
  if (cachedFiscalYears) return cachedFiscalYears;
  const imports = await api.get("/api/admin/gl/imports");
  const years = [...new Set(imports.map((i) => i.fiscalYear))].sort((a, b) => b - a);
  cachedFiscalYears = years;
  return years;
}

function resolveDefaultFiscalYear(years) {
  const currentTwoDigit = new Date().getFullYear() % 100;
  if (years.includes(currentTwoDigit)) return currentTwoDigit;
  return years[0] ?? currentTwoDigit;
}

// Two Spend Breakdown categories ("Meals Empl", "Meals & Ent") pulled into
// their own report, same shape as Cell Phones (see db.getMealsCharges).
// There's no clean per-line name field for Meals the way Cell Phone's
// remark is a bare phone # -- remark here is free Concur text, sometimes a
// name, sometimes a bulk correction with no name on it at all -- so this
// shows it verbatim as "Name / description" rather than guessing a name
// out of it. The category split up top is what actually explains a
// surprising total most of the time: Meals & Ent in particular can carry
// large correction/reversal batches that have nothing to do with any one
// person's spending.
export async function renderMeals(container) {
  renderLoadingState(container, loadingLabelFor("Meals"));
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

  let data;
  try {
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    if (!allYearsSelected) params.set("fiscalYear", String(selectedFiscalYear));
    data = await api.get(`/api/admin/gl/meals?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  lastData = data;

  const yearOptions = [`<option value="all" ${allYearsSelected ? "selected" : ""}>All fiscal years</option>`]
    .concat(years.map((y) => `<option value="${y}" ${!allYearsSelected && selectedFiscalYear === y ? "selected" : ""}>FY${y}</option>`))
    .join("");

  container.innerHTML = `
    <div class="spend-filters-row">
      <label class="spend-fy-select-label">
        Fiscal year
        <select class="meals-fy-select">${yearOptions}</select>
      </label>
      <div class="tabs cellphone-groupby-toggle">
        <button type="button" class="tab ${groupBy === "month" ? "active" : ""}" data-group="month">By month</button>
        <button type="button" class="tab ${groupBy === "description" ? "active" : ""}" data-group="description">By name / description</button>
      </div>
      <label class="spend-fy-select-label">
        Search name / description
        <input type="text" class="meals-search-input" placeholder="Type a name..." value="${escapeHtml(searchQuery)}" />
      </label>
    </div>
    <div class="wom-stat-cards">
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#127869;&#65039;</span>
        <div><div class="wom-stat-label">Total</div><div class="wom-stat-value">${formatMoney(data.totalAmount)}</div></div>
      </div>
      ${data.byCategory
        .map(
          (c) => `
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128203;</span>
          <div><div class="wom-stat-label">${escapeHtml(c.category)}</div><div class="wom-stat-value">${formatMoney(c.total)}</div></div>
        </div>
      `
        )
        .join("")}
    </div>
    <p class="review-checklist-hint">
      "Name / description" is the tracker's own free-text note on each line (Concur reuses the same text across one
      person's expense report, so matching text usually means the same person/trip) -- not every line has a name on it,
      some are bulk corrections.
    </p>
    ${renderUnmatchedLocations(data.unmatchedLocations)}
    <div id="meals-body"></div>
  `;

  container.querySelector(".meals-fy-select").addEventListener("change", (e) => {
    selectedFiscalYear = e.target.value === "all" ? "all" : Number(e.target.value);
    renderMeals(container);
  });
  container.querySelectorAll(".cellphone-groupby-toggle [data-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      groupBy = btn.dataset.group;
      drawBody(container);
    });
  });
  container.querySelector(".meals-search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    drawBody(container);
  });

  drawBody(container);
}

// Filters/re-renders just the results table from the already-fetched
// payload -- typing in the search box (or flipping the By month/By
// description toggle) never refetches or rebuilds the filter row, so the
// search input never loses focus or its cursor position mid-type.
function drawBody(container) {
  const body = container.querySelector("#meals-body");
  const data = lastData;
  if (!data || data.count === 0) {
    body.innerHTML = `<p class="empty-note">No Meals GL lines for this scope.</p>`;
    return;
  }
  if (groupBy === "description") {
    const filtered = data.byDescription.filter((d) => matchesSearch(d.description, searchQuery) || matchesSearch(d.locationLabel, searchQuery));
    body.innerHTML = filtered.length
      ? renderByDescription(filtered)
      : `<p class="empty-note">No name / description matches "${escapeHtml(searchQuery)}".</p>`;
  } else {
    const filtered = data.items.filter((it) => matchesSearch(it.description, searchQuery) || matchesSearch(it.locationLabel, searchQuery));
    body.innerHTML = filtered.length
      ? renderByMonth(filtered)
      : `<p class="empty-note">No name / description matches "${escapeHtml(searchQuery)}".</p>`;
    if (filtered.length) {
      const byId = new Map(filtered.map((it) => [String(it.id), it]));
      body.querySelectorAll("[data-gl-id]").forEach((row) => {
        row.addEventListener("click", () => {
          const it = byId.get(row.dataset.glId);
          if (it) openGlLineModal(it);
        });
      });
    }
  }
}

// The summary table only shows the handful of fields worth a quick scan --
// clicking a row pops up every other field the actual GL export line
// carries (document #, business unit, batch #, PO, the full un-truncated
// remark, etc.), so nothing on the original line is ever hidden from view.
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
        ${row("Category", it.category)}
        ${row("Remark (full)", g.remark)}
        ${row("GL date", it.glDate ? String(it.glDate).slice(0, 10) : null)}
        ${row("Amount", it.amount != null ? formatMoney(it.amount) : null)}
        ${row("Location", it.locationLabel)}
        ${row("Location code (raw)", g.locationCode)}
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
      </div>
    `,
  });
}

function renderByMonth(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.fiscalYear}-${String(it.periodNumber).padStart(2, "0")}`;
    const g = groups.get(key) || {
      label: it.month ? `${it.month} FY${it.fiscalYear}` : `Period ${it.periodNumber} FY${it.fiscalYear}`,
      items: [],
      total: 0,
    };
    g.items.push(it);
    g.total += it.amount || 0;
    groups.set(key, g);
  }
  const sortedKeys = [...groups.keys()].sort().reverse();
  return sortedKeys
    .map((key) => {
      const g = groups.get(key);
      return `
        <h3 class="cellphone-month-header">${escapeHtml(g.label)} <span class="cellphone-month-total">${formatMoney(g.total)} &middot; ${g.items.length} lines</span></h3>
        <table class="detail-table cellphone-table">
          <thead><tr><th>Category</th><th>Name / description</th><th>GL date</th><th>Location</th><th>Amount</th></tr></thead>
          <tbody>
            ${g.items
              .map(
                (it) => `
              <tr class="cellphone-row-clickable" data-gl-id="${it.id}" title="Click to view the full GL line">
                <td>${escapeHtml(it.category)}</td>
                <td>${it.description ? escapeHtml(it.description) : "—"}</td>
                <td>${it.glDate ? escapeHtml(String(it.glDate).slice(0, 10)) : "—"}</td>
                <td>${it.locationLabel ? escapeHtml(it.locationLabel) : "—"}</td>
                <td>${formatMoney(it.amount)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `;
    })
    .join("");
}

function renderByDescription(byDescription) {
  return `
    <table class="detail-table cellphone-table">
      <thead><tr><th>Category</th><th>Name / description</th><th>Location</th><th>Months</th><th>GL lines</th><th>Total</th></tr></thead>
      <tbody>
        ${byDescription
          .map(
            (d) => `
          <tr>
            <td>${escapeHtml(d.category)}</td>
            <td>${escapeHtml(d.description)}</td>
            <td>${d.locationLabel ? escapeHtml(d.locationLabel) : "—"}</td>
            <td>${d.monthCount}</td>
            <td>${d.count}</td>
            <td>${formatMoney(d.total)}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// Sites whose Location Code never matched anything in the app's own
// Locations tab -- they can't resolve to a territory, so the global
// territory filter (top right) silently drops them the same way it would
// drop a genuinely different territory's data, rather than showing an
// error. Listed here so a Midwest-only view is actually trustworthy --
// anything below needs adding to Locations (with its territory set)
// before it'll show up under a territory filter at all.
function renderUnmatchedLocations(unmatchedLocations) {
  if (!unmatchedLocations || unmatchedLocations.length === 0) return "";
  return `
    <div class="wom-info-box cellphone-unmatched-box">
      <strong>${unmatchedLocations.length} location${unmatchedLocations.length === 1 ? "" : "s"} not on the Locations tab</strong>
      -- these can't resolve a territory, so picking one in the filter above (top right) excludes them entirely rather
      than showing them as "Unassigned." Add them to Locations with the right territory to fix that.
      <table class="detail-table cellphone-table">
        <thead><tr><th>Location (from the GL export)</th><th>GL lines</th><th>Amount</th></tr></thead>
        <tbody>
          ${unmatchedLocations
            .map(
              (l) => `
            <tr>
              <td>${escapeHtml(l.locationLabel)}</td>
              <td>${l.count}</td>
              <td>${formatMoney(l.total)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}
