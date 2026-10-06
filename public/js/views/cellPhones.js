import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Module-level, same pattern as spendBreakdown.js's own fiscal-year state --
// survives a territory-filter-triggered re-render without resetting back to
// the default year every time.
let selectedFiscalYear = null; // resolved to a real year (or "all") on first render
let groupBy = "month"; // "month" | "phone"
let cachedFiscalYears = null;

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

// Which number was charged, how much, and in which month -- pulled out of
// Spend Breakdown's generic "Cell Phone" category drill-down (same GL data,
// same territory/fiscal-year scoping) into its own purpose-built report,
// since "CALERO SOFTWARE LLC" on every single line there isn't useful but
// the number in the remark field is (see db.getCellPhoneCharges).
export async function renderCellPhones(container) {
  renderLoadingState(container, loadingLabelFor("Cell Phones"));
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
    data = await api.get(`/api/admin/gl/cell-phones?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const yearOptions = [`<option value="all" ${allYearsSelected ? "selected" : ""}>All fiscal years</option>`]
    .concat(years.map((y) => `<option value="${y}" ${!allYearsSelected && selectedFiscalYear === y ? "selected" : ""}>FY${y}</option>`))
    .join("");

  container.innerHTML = `
    <div class="spend-filters-row">
      <label class="spend-fy-select-label">
        Fiscal year
        <select class="cellphone-fy-select">${yearOptions}</select>
      </label>
      <div class="tabs cellphone-groupby-toggle">
        <button type="button" class="tab ${groupBy === "month" ? "active" : ""}" data-group="month">By month</button>
        <button type="button" class="tab ${groupBy === "phone" ? "active" : ""}" data-group="phone">By phone #</button>
      </div>
    </div>
    <div class="wom-stat-cards">
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128241;</span>
        <div><div class="wom-stat-label">Total charged</div><div class="wom-stat-value">${formatMoney(data.totalAmount)}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128203;</span>
        <div><div class="wom-stat-label">GL lines</div><div class="wom-stat-value">${data.count}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#9742;&#65039;</span>
        <div><div class="wom-stat-label">Distinct numbers</div><div class="wom-stat-value">${data.byPhone.length}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128100;</span>
        <div><div class="wom-stat-label">Matched to roster</div><div class="wom-stat-value">${data.byPhone.filter((p) => p.assignedToName).length} / ${data.byPhone.length}</div></div>
      </div>
    </div>
    <p class="review-checklist-hint">
      "Assigned to" matches each number against every technician's phone # (Basic Info) and any phone-type device on
      their profile -- add a tech's number there to pick up the match here.
    </p>
    ${renderUnmatchedLocations(data.unmatchedLocations)}
    <div id="cellphone-body"></div>
  `;

  container.querySelector(".cellphone-fy-select").addEventListener("change", (e) => {
    selectedFiscalYear = e.target.value === "all" ? "all" : Number(e.target.value);
    renderCellPhones(container);
  });
  container.querySelectorAll(".cellphone-groupby-toggle [data-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      groupBy = btn.dataset.group;
      renderCellPhones(container);
    });
  });

  const body = container.querySelector("#cellphone-body");
  if (data.count === 0) {
    body.innerHTML = `<p class="empty-note">No Cell Phone GL lines for this scope.</p>`;
    return;
  }
  body.innerHTML = groupBy === "phone" ? renderByPhone(data.byPhone) : renderByMonth(data.items);
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
          <thead><tr><th>Phone #</th><th>Assigned to</th><th>GL date</th><th>Location</th><th>Amount</th></tr></thead>
          <tbody>
            ${g.items
              .map(
                (it) => `
              <tr>
                <td>${escapeHtml(it.phoneNumber || "—")}</td>
                <td>${it.assignedToName ? escapeHtml(it.assignedToName) : '<span class="cellphone-unassigned">Not on roster</span>'}</td>
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

function renderByPhone(byPhone) {
  return `
    <table class="detail-table cellphone-table">
      <thead><tr><th>Phone #</th><th>Assigned to</th><th>Location</th><th>Months billed</th><th>GL lines</th><th>Total</th></tr></thead>
      <tbody>
        ${byPhone
          .map(
            (p) => `
          <tr>
            <td>${escapeHtml(p.phoneNumber)}</td>
            <td>${p.assignedToName ? escapeHtml(p.assignedToName) : '<span class="cellphone-unassigned">Not on roster</span>'}</td>
            <td>${p.locationLabel ? escapeHtml(p.locationLabel) : "—"}</td>
            <td>${p.monthCount}</td>
            <td>${p.count}</td>
            <td>${formatMoney(p.total)}</td>
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
