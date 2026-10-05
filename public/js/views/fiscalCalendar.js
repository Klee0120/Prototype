import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

// A plain reference table for Toyota's own published close calendar --
// periods, month names, and the real dates (fiscal month end, WOM close,
// GL/HFM close) an admin needs to look up without digging through GL
// Reconciliation. Read-only: this never drives anything itself, it's the
// same getGlFiscalCalendar data GL Reconciliation/Spend Breakdown/Reclasses
// already use, just surfaced on its own for quick reference.
let cachedYears = null;
let selectedFiscalYear = null;

async function loadYears() {
  if (cachedYears) return cachedYears;
  cachedYears = await api.get("/api/admin/gl/fiscal-calendar-years");
  return cachedYears;
}

function resolveDefaultFiscalYear(years) {
  const currentTwoDigit = new Date().getFullYear() % 100;
  if (years.includes(currentTwoDigit)) return currentTwoDigit;
  return years[0] ?? currentTwoDigit;
}

function statusBadge(period) {
  if (period.imported) return { cls: "badge-approved", label: "Imported" };
  if (period.closedYet) return { cls: "badge-rejected", label: "Closed, not imported" };
  return { cls: "badge-draft", label: "Upcoming" };
}

export async function renderFiscalCalendar(container) {
  renderLoadingState(container, loadingLabelFor("Fiscal Calendar"));

  let years;
  try {
    years = await loadYears();
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (years.length === 0) {
    container.innerHTML = `<h3 style="margin: 0 0 4px;">Fiscal Calendar</h3><p class="empty-note">No fiscal calendar is on file yet.</p>`;
    return;
  }
  if (selectedFiscalYear == null || !years.includes(selectedFiscalYear)) {
    selectedFiscalYear = resolveDefaultFiscalYear(years);
  }

  let periods;
  try {
    periods = await api.get(`/api/admin/gl/fiscal-calendar?fiscalYear=${selectedFiscalYear}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = `
    <h3 style="margin: 0 0 4px;">Fiscal Calendar</h3>
    <p class="review-checklist-hint">
      Reference only -- Toyota's own published close calendar, the same dates GL Reconciliation, Spend
      Breakdown, and Reclasses already use. Published a year at a time, so a future fiscal year not listed
      here just hasn't been published yet.
    </p>
    <div class="wom-filter-bar">
      <label class="profile-field">
        <span>Fiscal year</span>
        <select class="fiscal-calendar-fy-select">
          ${years.map((y) => `<option value="${y}" ${y === selectedFiscalYear ? "selected" : ""}>FY${y}</option>`).join("")}
        </select>
      </label>
    </div>
    <table class="detail-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Month</th>
          <th>Fiscal Month Ends</th>
          <th>WOM Close Date</th>
          <th>GL Close (HFM Load)</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${periods
          .map((p) => {
            const status = statusBadge(p);
            return `
              <tr>
                <td>${p.periodNumber}</td>
                <td>${escapeHtml(p.monthName)}</td>
                <td>${escapeHtml(p.fiscalMonthEnd)}</td>
                <td>${escapeHtml(p.womCloseDate)}</td>
                <td>${escapeHtml(p.closedDate)}</td>
                <td><span class="badge ${status.cls}">${status.label}</span></td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;

  container.querySelector(".fiscal-calendar-fy-select").addEventListener("change", (e) => {
    selectedFiscalYear = Number(e.target.value);
    renderFiscalCalendar(container);
  });
}
