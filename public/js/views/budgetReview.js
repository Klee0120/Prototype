import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// Module-level, same pattern as spendBreakdown.js's/cellPhones.js's own
// filter state -- survives a territory-filter-triggered re-render instead
// of resetting back to defaults every time. null means "not decided yet";
// resolved to an actual Set once the real category list comes back from
// the server (see renderBudgetReview).
let selectedCategories = null;
let excludeBurden = false;

export async function renderBudgetReview(container) {
  renderLoadingState(container, loadingLabelFor("Budget Review"));
  const territory = getTerritory();

  let data;
  try {
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    if (excludeBurden) params.set("excludeBurden", "true");
    if (selectedCategories) {
      for (const c of selectedCategories) params.append("categories", c);
    }
    data = await api.get(`/api/admin/gl/budget-review?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  // First load: nothing picked yet means "every category," matching the
  // request with no categories param above. Leave selectedCategories null
  // (not every category explicitly checked) so a newly-imported category
  // that shows up later is included by default too, not silently excluded
  // for having missed an explicit check.
  const allCategories = data.categories;

  container.innerHTML = `
    <p class="review-checklist-hint">
      Backs the budget-presentation ask directly: a few sites get a 5-year R&amp;M-spend-vs-budget table and an
      OT-rate trend in the FY27 deck, but not every site does (Kansas City, for one, only shows up in the deck's
      summary row). This pulls the same two signals from data already in ServiceWorks -- R&amp;M spend from the GL
      import, OT rate from logged hours -- for every site, not just the ones that got a slide. It can't reproduce
      the deck's 5-year CM/SR work-order counts (that's Maximo data, not anything this app imports), and only
      covers whatever fiscal years actually have a GL import or logged hours on file -- check the coverage note
      per column below before treating a gap as "zero."
    </p>
    <div class="spend-filters-row">
      <button type="button" class="btn btn-secondary budget-review-category-toggle">
        GL categories counted as R&amp;M (${selectedCategories ? selectedCategories.size : allCategories.length} of ${allCategories.length})
      </button>
      <label class="budget-review-burden-toggle">
        <input type="checkbox" class="budget-review-exclude-burden" ${excludeBurden ? "checked" : ""} />
        Exclude burden costs
      </label>
    </div>
    <div class="budget-review-category-panel" hidden>
      ${allCategories
        .map(
          (c) => `
        <label class="budget-review-category-option">
          <input type="checkbox" value="${escapeHtml(c)}" ${!selectedCategories || selectedCategories.has(c) ? "checked" : ""} />
          ${escapeHtml(c)}
        </label>
      `
        )
        .join("")}
    </div>
    <div id="budget-review-body"></div>
  `;

  container.querySelector(".budget-review-category-toggle").addEventListener("click", () => {
    const panel = container.querySelector(".budget-review-category-panel");
    panel.hidden = !panel.hidden;
  });
  container.querySelector(".budget-review-exclude-burden").addEventListener("change", (e) => {
    excludeBurden = e.target.checked;
    renderBudgetReview(container);
  });
  container.querySelectorAll(".budget-review-category-option input").forEach((input) => {
    input.addEventListener("change", () => {
      const checked = new Set(
        [...container.querySelectorAll(".budget-review-category-option input:checked")].map((i) => i.value)
      );
      // Every box checked is the same as "no filter" -- keep it null so a
      // category that shows up in a later import is still included.
      selectedCategories = checked.size === allCategories.length ? null : checked;
      renderBudgetReview(container);
    });
  });

  renderBody(container, container.querySelector("#budget-review-body"), data.rows);
}

function renderBody(container, body, rows) {
  if (rows.length === 0) {
    body.innerHTML = `<p class="empty-note">No R&amp;M spend or logged hours on file yet for this scope.</p>`;
    return;
  }

  const byLocation = new Map();
  for (const r of rows) {
    const key = r.locationCode || "unassigned";
    const g = byLocation.get(key) || { locationName: r.locationName || r.locationCode || "Unassigned", rows: [] };
    g.rows.push(r);
    byLocation.set(key, g);
  }

  body.innerHTML = [...byLocation.values()]
    .map(
      (g) => `
    <h3 class="cellphone-month-header">${escapeHtml(g.locationName)}</h3>
    <table class="detail-table budget-review-table">
      <thead>
        <tr>
          <th>Fiscal Year</th>
          <th>R&amp;M Spend (GL)</th>
          <th>Budget</th>
          <th>Variance</th>
          <th>OT Hours</th>
          <th>Total Hours</th>
          <th>OT Rate</th>
        </tr>
      </thead>
      <tbody>
        ${g.rows
          .map(
            (r) => `
          <tr data-location="${escapeHtml(r.locationCode || "")}" data-fy="${r.fiscalYear}">
            <td>FY${r.fiscalYear}</td>
            <td>${formatMoney(r.rmSpend)}</td>
            <td class="budget-review-budget-cell">
              <input type="number" step="1" class="budget-review-budget-input" value="${r.rmBudget != null ? r.rmBudget : ""}" placeholder="Not set" />
            </td>
            <td class="${r.variance != null && r.variance > 0 ? "danger" : ""}">${r.variance != null ? formatMoney(r.variance) : "—"}</td>
            <td>${r.otHours != null ? r.otHours.toLocaleString() : "—"}</td>
            <td>${r.totalHours != null ? r.totalHours.toLocaleString() : "—"}</td>
            <td>${r.otRatePct != null ? `${r.otRatePct}%` : "—"}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `
    )
    .join("");

  body.querySelectorAll(".budget-review-budget-input").forEach((input) => {
    input.addEventListener("blur", async () => {
      const tr = input.closest("tr");
      const locationCode = tr.dataset.location;
      const fiscalYear = Number(tr.dataset.fy);
      if (!locationCode) return;
      const raw = input.value.trim();
      if (raw === "") return;
      const amount = Number(raw);
      if (!Number.isFinite(amount)) return;
      try {
        await api.put("/api/admin/gl/rm-budgets", { locationCode, fiscalYear, amount });
        renderBudgetReview(container);
      } catch (err) {
        window.alert(err.message);
      }
    });
  });
}
