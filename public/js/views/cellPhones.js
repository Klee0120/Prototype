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
// Employee/month/unmatched-only are all applied client-side against
// whatever the fiscal-year/territory fetch already pulled back (see
// renderCellPhones) -- the dataset's never more than a few hundred rows,
// so there's no reason to round-trip the server for a narrower slice of
// data it already sent. "Not on roster" is a real, selectable value in
// the employee dropdown (not just the separate checkbox) since someone
// scanning for a specific unidentified number may still want to isolate
// just that one line's month/amount the same way they would for a named
// employee.
let employeeFilter = "";
let monthFilter = "";
let unmatchedOnly = false;
const UNMATCHED_LABEL = "Not on roster";

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

  // Built from this fetch's own items, not a fixed list -- an employee or
  // month with nothing billed this scope just doesn't show up as an
  // option, so the dropdown never offers a choice that would return
  // "0 results" for no visible reason.
  const employeeNames = [...new Set(data.items.map((it) => it.assignedToName || UNMATCHED_LABEL))].sort((a, b) =>
    a === UNMATCHED_LABEL ? 1 : b === UNMATCHED_LABEL ? -1 : a.localeCompare(b)
  );
  const monthEntries = new Map(); // "FY-period" -> label
  for (const it of data.items) {
    const key = `${it.fiscalYear}-${it.periodNumber}`;
    if (!monthEntries.has(key)) {
      monthEntries.set(key, it.month ? `${it.month} FY${it.fiscalYear}` : `Period ${it.periodNumber} FY${it.fiscalYear}`);
    }
  }
  const monthOptions = [...monthEntries.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  // Clears a filter choice that's no longer a real option in this scope
  // (e.g. a fiscal-year switch leaves a previously-picked month that
  // doesn't exist this year) rather than silently filtering against a
  // value nothing can ever match.
  if (employeeFilter && !employeeNames.includes(employeeFilter)) employeeFilter = "";
  if (monthFilter && !monthEntries.has(monthFilter)) monthFilter = "";

  const filteredItems = data.items.filter((it) => {
    if (employeeFilter && (it.assignedToName || UNMATCHED_LABEL) !== employeeFilter) return false;
    if (monthFilter && `${it.fiscalYear}-${it.periodNumber}` !== monthFilter) return false;
    if (unmatchedOnly && it.assignedToName) return false;
    return true;
  });
  const filteredByPhone = aggregateByPhone(filteredItems);
  const filteredTotal = filteredItems.reduce((sum, it) => sum + (it.amount || 0), 0);
  const filteredTerminated = filteredItems.filter((it) => it.assignedToTerminated);
  const filtersActive = Boolean(employeeFilter || monthFilter || unmatchedOnly);

  container.innerHTML = `
    <div class="spend-filters-row">
      <label class="spend-fy-select-label">
        Fiscal year
        <select class="cellphone-fy-select">${yearOptions}</select>
      </label>
      <label class="spend-fy-select-label">
        Employee
        <select class="cellphone-employee-select">
          <option value="">All employees</option>
          ${employeeNames.map((n) => `<option value="${escapeHtml(n)}" ${employeeFilter === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
        </select>
      </label>
      <label class="spend-fy-select-label">
        Month
        <select class="cellphone-month-select">
          <option value="">All months</option>
          ${monthOptions.map(([key, label]) => `<option value="${escapeHtml(key)}" ${monthFilter === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label class="cellphone-unmatched-toggle">
        <input type="checkbox" class="cellphone-unmatched-checkbox" ${unmatchedOnly ? "checked" : ""} />
        Unidentified numbers only
      </label>
      <div class="tabs cellphone-groupby-toggle">
        <button type="button" class="tab ${groupBy === "month" ? "active" : ""}" data-group="month">By month</button>
        <button type="button" class="tab ${groupBy === "phone" ? "active" : ""}" data-group="phone">By phone #</button>
      </div>
    </div>
    <div class="wom-stat-cards">
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128241;</span>
        <div><div class="wom-stat-label">Total charged${filtersActive ? " (filtered)" : ""}</div><div class="wom-stat-value">${formatMoney(filtersActive ? filteredTotal : data.totalAmount)}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128203;</span>
        <div><div class="wom-stat-label">GL lines${filtersActive ? " (filtered)" : ""}</div><div class="wom-stat-value">${filtersActive ? filteredItems.length : data.count}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#9742;&#65039;</span>
        <div><div class="wom-stat-label">Distinct numbers${filtersActive ? " (filtered)" : ""}</div><div class="wom-stat-value">${filtersActive ? filteredByPhone.length : data.byPhone.length}</div></div>
      </div>
      <div class="wom-stat-card">
        <span class="wom-stat-icon">&#128100;</span>
        <div><div class="wom-stat-label">Matched to roster</div><div class="wom-stat-value">${(filtersActive ? filteredByPhone : data.byPhone).filter((p) => p.assignedToName).length} / ${(filtersActive ? filteredByPhone : data.byPhone).length}</div></div>
      </div>
      <div class="wom-stat-card ${(filtersActive ? filteredTerminated.length : data.terminatedCount) > 0 ? "wom-stat-card-danger" : ""}">
        <span class="wom-stat-icon">&#9888;&#65039;</span>
        <div><div class="wom-stat-label">Billing a terminated employee</div><div class="wom-stat-value">${
          filtersActive
            ? `${filteredTerminated.length} line${filteredTerminated.length === 1 ? "" : "s"}${filteredTerminated.length > 0 ? ` &middot; ${formatMoney(filteredTerminated.reduce((s, it) => s + (it.amount || 0), 0))}` : ""}`
            : `${data.terminatedCount} line${data.terminatedCount === 1 ? "" : "s"}${data.terminatedCount > 0 ? ` &middot; ${formatMoney(data.terminatedTotal)}` : ""}`
        }</div></div>
      </div>
    </div>
    <p class="review-checklist-hint">
      "Assigned to" matches each number against every technician's phone # (Basic Info) and any phone- or iPad-type
      device on their profile -- add a tech's number there to pick up the match here. A number still assigned to
      someone whose Employment Status is Terminated is flagged below -- that's a line likely worth cancelling.
    </p>
    ${renderUnmatchedLocations(data.unmatchedLocations)}
    <div id="cellphone-body"></div>
  `;

  container.querySelector(".cellphone-fy-select").addEventListener("change", (e) => {
    selectedFiscalYear = e.target.value === "all" ? "all" : Number(e.target.value);
    monthFilter = ""; // last scope's month selection may not exist in the new one
    renderCellPhones(container);
  });
  container.querySelector(".cellphone-employee-select").addEventListener("change", (e) => {
    employeeFilter = e.target.value;
    renderCellPhones(container);
  });
  container.querySelector(".cellphone-month-select").addEventListener("change", (e) => {
    monthFilter = e.target.value;
    renderCellPhones(container);
  });
  container.querySelector(".cellphone-unmatched-checkbox").addEventListener("change", (e) => {
    unmatchedOnly = e.target.checked;
    renderCellPhones(container);
  });
  container.querySelectorAll(".cellphone-groupby-toggle [data-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      groupBy = btn.dataset.group;
      renderCellPhones(container);
    });
  });

  const body = container.querySelector("#cellphone-body");
  if (filteredItems.length === 0) {
    body.innerHTML = `<p class="empty-note">${data.count === 0 ? "No Cell Phone GL lines for this scope." : "No Cell Phone GL lines match these filters."}</p>`;
    return;
  }
  body.innerHTML = groupBy === "phone" ? renderByPhone(filteredByPhone) : renderByMonth(filteredItems);
}

// Mirrors db.js's getCellPhoneCharges own byPhone aggregation, run
// client-side against whatever subset the employee/month/unmatched
// filters leave -- so "By phone #" reflects the same filtered items "By
// month" shows, rather than always summing the server's full, unfiltered
// fiscal-year scope regardless of what's picked above.
function aggregateByPhone(items) {
  const byPhone = new Map();
  for (const it of items) {
    const key = it.phoneNumber || "Unknown #";
    const p =
      byPhone.get(key) ||
      {
        phoneNumber: key,
        total: 0,
        count: 0,
        months: new Set(),
        locationLabel: it.locationLabel,
        assignedToName: it.assignedToName,
        assignedToTerminated: it.assignedToTerminated,
      };
    p.total += it.amount || 0;
    p.count += 1;
    p.months.add(it.month);
    byPhone.set(key, p);
  }
  const round = (n) => Math.round(n * 100) / 100;
  return [...byPhone.values()].map((p) => ({ ...p, total: round(p.total), monthCount: p.months.size }));
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
                <td>${
                  it.assignedToName
                    ? `${escapeHtml(it.assignedToName)}${it.assignedToTerminated ? ' <span class="badge badge-rejected">Terminated</span>' : ""}`
                    : '<span class="cellphone-unassigned">Not on roster</span>'
                }</td>
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
            <td>${
              p.assignedToName
                ? `${escapeHtml(p.assignedToName)}${p.assignedToTerminated ? ' <span class="badge badge-rejected">Terminated</span>' : ""}`
                : '<span class="cellphone-unassigned">Not on roster</span>'
            }</td>
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
