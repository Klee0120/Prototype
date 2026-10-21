import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Same module-level-state pattern as cellPhones.js/meals.js.
let selectedFiscalYear = null;
let selectedPeriod = ""; // "" = whole fiscal year, else a period number as a string
let ruleFilter = ""; // "" = every rule
let cachedFiscalYears = null;
let lastData = null;
// Row ids (gl_entries.id) currently checked for the bulk "Add selected to
// Reclass list" action -- cleared on every refetch (a new fiscal year/
// period/rule scope is a fresh list, carrying a stale selection across
// would risk silently adding a row that's no longer even shown).
let selectedIds = new Set();

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

const SEVERITY_BADGE_CLASS = { review: "draft", action: "submitted", high: "rejected" };
const SEVERITY_LABEL = { review: "Review", action: "Reclass", high: "High" };

// Krista's own manual reclass-review checklist (worked by hand today
// against a ~6500-line monthly GL extract), run automatically here over
// whatever's already imported -- see db.getGlScreeningFlags for the exact
// rule logic. This never writes anything on its own: a flagged line only
// becomes a real Reclass list entry when an admin explicitly adds it
// (one row at a time, or several at once), via the same POST
// /api/admin/reclasses/items route the Reclasses tab's own "+ Add
// finding" form uses, just with source: "auto_flagged" and the flagged
// line's own coding pre-filled in.
export async function renderGlScreening(container) {
  renderLoadingState(container, loadingLabelFor("GL Screening"));
  const territory = getTerritory();

  let years;
  try {
    years = await loadFiscalYears();
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (selectedFiscalYear == null) selectedFiscalYear = resolveDefaultFiscalYear(years);

  let data;
  try {
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    params.set("fiscalYear", String(selectedFiscalYear));
    if (selectedPeriod) params.set("periodNumber", selectedPeriod);
    data = await api.get(`/api/admin/gl/screening?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  lastData = data;
  selectedIds = new Set();

  const yearOptions = years.map((y) => `<option value="${y}" ${selectedFiscalYear === y ? "selected" : ""}>FY${y}</option>`).join("");
  const periodOptions = [`<option value="">Whole fiscal year</option>`]
    .concat(
      [...new Set(data.items.map((it) => it.periodNumber))]
        .sort((a, b) => a - b)
        .map((p) => {
          const label = data.items.find((it) => it.periodNumber === p)?.month;
          return `<option value="${p}" ${selectedPeriod === String(p) ? "selected" : ""}>${label ? `${label} FY${selectedFiscalYear}` : `Period ${p}`}</option>`;
        })
    )
    .join("");

  container.innerHTML = `
    <div class="spend-filters-row">
      <label class="spend-fy-select-label">
        Fiscal year
        <select class="glscreen-fy-select">${yearOptions}</select>
      </label>
      <label class="spend-fy-select-label">
        Period
        <select class="glscreen-period-select">${periodOptions}</select>
      </label>
    </div>
    <p class="review-checklist-hint">
      Runs Krista's own reclass-review checklist (amount, Calero/iPad, Temp Labor, Concur, Labor subsidiary, WOM
      subledger, E&amp;F/WOM mixing, credits on WOM jobs, PPS subsidiary) over every imported GL line in this scope.
      Nothing is added to the Reclass list until you pick a line and click Add -- this only surfaces candidates.
    </p>
    <div class="glscreen-rule-chips">
      <button type="button" class="tab glscreen-rule-chip ${ruleFilter === "" ? "active" : ""}" data-rule="">All (${data.count})</button>
      ${data.byRule
        .map(
          (r) =>
            `<button type="button" class="tab glscreen-rule-chip ${ruleFilter === r.ruleKey ? "active" : ""}" data-rule="${escapeHtml(r.ruleKey)}">
              <span class="badge badge-${SEVERITY_BADGE_CLASS[r.severity] || "draft"}">${r.count}</span> ${escapeHtml(r.label)}
            </button>`
        )
        .join("")}
    </div>
    <div class="glscreen-bulk-bar">
      <span class="glscreen-selected-count">0 selected</span>
      <button type="button" class="btn btn-primary glscreen-add-selected-btn" disabled>Add selected to Reclass list</button>
    </div>
    <div id="glscreen-body"></div>
  `;

  container.querySelector(".glscreen-fy-select").addEventListener("change", (e) => {
    selectedFiscalYear = Number(e.target.value);
    selectedPeriod = "";
    renderGlScreening(container);
  });
  container.querySelector(".glscreen-period-select").addEventListener("change", (e) => {
    selectedPeriod = e.target.value;
    renderGlScreening(container);
  });
  container.querySelectorAll(".glscreen-rule-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      ruleFilter = btn.dataset.rule;
      renderGlScreening(container);
    });
  });
  container.querySelector(".glscreen-add-selected-btn").addEventListener("click", () => addFlaggedToReclass(container, [...selectedIds]));

  drawBody(container);
}

function filteredItems() {
  const data = lastData;
  if (!data) return [];
  if (!ruleFilter) return data.items;
  return data.items.filter((it) => it.reasons.some((r) => r.ruleKey === ruleFilter));
}

function updateBulkBar(container) {
  const bar = container.querySelector(".glscreen-bulk-bar");
  if (!bar) return;
  bar.querySelector(".glscreen-selected-count").textContent = `${selectedIds.size} selected`;
  bar.querySelector(".glscreen-add-selected-btn").disabled = selectedIds.size === 0;
}

function drawBody(container) {
  const body = container.querySelector("#glscreen-body");
  const items = filteredItems();
  if (items.length === 0) {
    body.innerHTML = `<p class="empty-note">${lastData && lastData.count === 0 ? "No GL lines flagged for this scope." : "No lines match this rule."}</p>`;
    return;
  }
  body.innerHTML = `
    <table class="detail-table cellphone-table glscreen-table">
      <thead>
        <tr>
          <th></th>
          <th>GL date</th>
          <th>Vendor / payee</th>
          <th>Object account</th>
          <th>Subsidiary</th>
          <th>Amount</th>
          <th>Why flagged</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map(
            (it) => `
          <tr>
            <td><input type="checkbox" class="glscreen-row-check" data-id="${it.id}" ${selectedIds.has(it.id) ? "checked" : ""} /></td>
            <td>${it.glDate ? escapeHtml(String(it.glDate).slice(0, 10)) : "—"}</td>
            <td>${it.nameAlpha ? escapeHtml(it.nameAlpha) : "—"}</td>
            <td>${escapeHtml(it.objectAccount || "—")}</td>
            <td>${escapeHtml(it.subsidiary || "—")}</td>
            <td>${formatMoney(it.amount)}</td>
            <td class="glscreen-reasons">
              ${it.reasons
                .map(
                  (r) =>
                    `<span class="badge badge-${SEVERITY_BADGE_CLASS[r.severity] || "draft"}" title="${escapeHtml(r.detail || "")}">${escapeHtml(r.label)}</span>`
                )
                .join(" ")}
            </td>
            <td><button type="button" class="btn btn-link glscreen-add-one-btn" data-id="${it.id}">Add to Reclass</button></td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  body.querySelectorAll(".glscreen-row-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBulkBar(container);
    });
  });
  body.querySelectorAll(".glscreen-add-one-btn").forEach((btn) => {
    btn.addEventListener("click", () => addFlaggedToReclass(container, [Number(btn.dataset.id)]));
  });
}

// Turns one or more flagged GL lines into real reclass_items rows, via the
// exact same route (POST /api/admin/reclasses/items) the Reclasses tab's
// own manual "+ Add finding" form posts to -- source: "auto_flagged" is
// the only thing that marks these as having come from this tool rather
// than typed by hand. The one rule with a known fix (Temp Labor/Allegis)
// pre-fills its suggested toObjectCode; every other rule leaves To blank
// since there's no single right answer this tool can determine on its
// own -- that's still Krista's own call, made from the Reclasses tab
// after adding it.
async function addFlaggedToReclass(container, ids) {
  const items = lastData.items.filter((it) => ids.includes(it.id));
  if (items.length === 0) return;
  if (!window.confirm(`Add ${items.length} line${items.length === 1 ? "" : "s"} to the Reclass list?`)) return;
  const errors = [];
  for (const it of items) {
    const suggestedToObjectCode = it.reasons.find((r) => r.suggestedToObjectCode)?.suggestedToObjectCode;
    const suggestedToSubsidiary = it.reasons.find((r) => r.suggestedToSubsidiary)?.suggestedToSubsidiary;
    try {
      await api.post("/api/admin/reclasses/items", {
        fromJobNumber: it.businessUnit || "",
        fromObjectCode: it.objectAccountCode || "",
        fromSubsidiary: it.subsidiary || "",
        fromWomNumber: it.subledgerGl || "",
        fromAmount: it.amount,
        toObjectCode: suggestedToObjectCode || "",
        toSubsidiary: suggestedToSubsidiary || "",
        vendor: it.nameAlpha || "",
        comments: `GL Screening flagged: ${it.reasons.map((r) => `${r.label}${r.detail ? ` (${r.detail})` : ""}`).join("; ")}`,
        source: "auto_flagged",
      });
    } catch (err) {
      errors.push(`${it.businessUnit || "line"}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    window.alert(`Added ${items.length - errors.length} of ${items.length}. Failed:\n${errors.join("\n")}`);
  }
  await renderGlScreening(container);
}
