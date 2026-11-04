import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory, setTerritory } from "../globalFilters.js";

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Same module-level-state pattern as cellPhones.js/meals.js.
let selectedFiscalYear = null;
let selectedPeriod = ""; // "" = whole fiscal year, else a period number as a string
let ruleFilter = ""; // "" = every rule
let showResolved = false;
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

// The dataviz skill's validated 8-slot categorical palette (light mode --
// this app has no dark theme), same copy spendBreakdown.js keeps -- each
// view owns its own small copy rather than sharing one module, matching
// how excludeBurden/etc. are already duplicated per view in this codebase.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

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

// Count-based (not dollar-based) -- "where are the most reclasses
// happening" is a question about review volume/effort, not exposure size;
// large_amount alone would otherwise dwarf every other slice by dollars
// despite being one of the smaller line counts.
function renderRuleDonut(byRule, totalCount) {
  if (totalCount <= 0) return `<p class="empty-note">Nothing to chart yet.</p>`;
  const cx = 110;
  const cy = 110;
  const rOuter = 100;
  const rInner = 58;
  let angle = 0;
  const slices = byRule.map((r, i) => ({ label: r.label, count: r.count, color: PALETTE[i % PALETTE.length] }));
  const paths = slices
    .map((s) => {
      const sweep = (s.count / totalCount) * 360;
      const startAngle = angle;
      const endAngle = angle + sweep;
      angle = endAngle;
      if (sweep >= 359.99) {
        return `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="${s.color}" stroke-width="${rOuter - rInner}"><title>${escapeHtml(s.label)}: ${s.count}</title></circle>`;
      }
      const d = describeDonutArc(cx, cy, rOuter, rInner, startAngle, endAngle);
      const pct = ((s.count / totalCount) * 100).toFixed(1);
      return `<path d="${d}" fill="${s.color}"><title>${escapeHtml(s.label)}: ${s.count} (${pct}%)</title></path>`;
    })
    .join("");
  const legend = slices
    .map(
      (s) => `
      <div class="spend-legend-row">
        <span class="spend-legend-swatch" style="background:${s.color}"></span>
        <span class="spend-legend-label">${escapeHtml(s.label)}</span>
        <span class="spend-legend-value">${s.count}</span>
      </div>`
    )
    .join("");
  return `
    <div class="spend-donut-wrap">
      <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="Flagged lines by rule">
        ${paths}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="spend-donut-total-label">${totalCount}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="spend-donut-total-sublabel">flagged lines</text>
      </svg>
      <div class="spend-donut-legend">${legend}</div>
    </div>
  `;
}

function renderTerritoryBreakdown(byTerritory, activeTerritory) {
  if (!byTerritory || byTerritory.length === 0) return "";
  const maxCount = Math.max(...byTerritory.map((t) => t.count));
  return `
    <div class="glscreen-territory-breakdown">
      <h3 class="glscreen-section-title">Lines by territory</h3>
      <table class="glscreen-territory-table">
        ${byTerritory
          .map(
            (t) => `
          <tr class="glscreen-territory-row ${activeTerritory === t.territory ? "active" : ""}" data-territory="${escapeHtml(t.territory)}">
            <td class="glscreen-territory-name">${escapeHtml(t.territory)}</td>
            <td class="spend-bar-cell"><span class="spend-bar" style="width:${maxCount ? (t.count / maxCount) * 100 : 0}%"></span></td>
            <td class="glscreen-territory-count">${t.count}</td>
            <td class="glscreen-territory-total">${formatMoney(t.total)}</td>
          </tr>`
          )
          .join("")}
      </table>
      ${activeTerritory ? `<button type="button" class="btn btn-link glscreen-clear-territory-btn">Clear territory filter</button>` : `<p class="review-checklist-hint">Click a territory to filter everything below to just that one.</p>`}
    </div>
  `;
}

// Krista's own manual reclass-review checklist (worked by hand today
// against a ~6500-line monthly GL extract), run automatically here over
// whatever's already imported -- see db.getGlScreeningFlags for the exact
// rule logic. This never writes anything on its own: a flagged line only
// becomes a real Reclass list entry when an admin explicitly adds it
// (one row at a time, or several at once), via the same POST
// /api/admin/reclasses/items route the Reclasses tab's own "+ Add
// finding" form uses, just with source: "auto_flagged" and the flagged
// line's own coding pre-filled in. "Resolve" is separate from that --
// it just marks a finding as looked-at so it drops off the active list
// (see db.resolveGlScreeningItem), independent of whether it was ever
// actually submitted as a reclass.
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
    if (showResolved) params.set("includeResolved", "true");
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
      <label class="cellphone-unmatched-toggle">
        <input type="checkbox" class="glscreen-show-resolved-toggle" ${showResolved ? "checked" : ""} />
        Show resolved
      </label>
      <button type="button" class="btn btn-secondary glscreen-export-btn">Export to Excel</button>
    </div>
    <p class="review-checklist-hint">
      Runs Krista's own reclass-review checklist (amount, Temp Labor, Concur, Labor subsidiary, WOM
      subledger, E&amp;F/WOM mixing, credits on WOM jobs, PPS subsidiary) over every imported GL line in this scope.
      Nothing is added to the Reclass list until you pick a line and click Add -- this only surfaces candidates.
      Resolving a line takes it off your active list without submitting a reclass; it stays resolved even if the
      same transaction shows up again in a later GL pull.
    </p>
    ${renderTerritoryBreakdown(data.byTerritory, territory)}
    <h3 class="glscreen-section-title">Where reclasses are happening</h3>
    ${renderRuleDonut(data.byRule, data.count)}
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
    ${
      ruleFilter === "large_amount"
        ? `<div class="wom-info-box glscreen-large-amount-banner">
            <strong>Confirm E&amp;F vs. WOM</strong> -- every line here is over $7,500, non-labor, has no WOM subledger, and carries a real
            invoice remark. For each one: is this genuinely E&amp;F spend, or should it have been coded to a WOM? Resolve it once you've
            checked, whichever way it turns out.
          </div>`
        : ""
    }
    <div class="glscreen-bulk-bar">
      <span class="glscreen-selected-count">0 selected</span>
      <button type="button" class="btn btn-primary glscreen-add-selected-btn" disabled>Add selected to Reclass list</button>
      <button type="button" class="btn btn-secondary glscreen-resolve-selected-btn" disabled>Resolve selected</button>
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
  container.querySelector(".glscreen-show-resolved-toggle").addEventListener("change", (e) => {
    showResolved = e.target.checked;
    renderGlScreening(container);
  });
  container.querySelectorAll(".glscreen-rule-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      ruleFilter = btn.dataset.rule;
      renderGlScreening(container);
    });
  });
  container.querySelectorAll(".glscreen-territory-row").forEach((row) => {
    row.addEventListener("click", () => {
      setTerritory(row.dataset.territory === territory ? null : row.dataset.territory);
    });
  });
  container.querySelector(".glscreen-clear-territory-btn")?.addEventListener("click", () => setTerritory(null));
  container.querySelector(".glscreen-add-selected-btn").addEventListener("click", () => addFlaggedToReclass(container, [...selectedIds]));
  container.querySelector(".glscreen-resolve-selected-btn").addEventListener("click", () => resolveFlagged(container, [...selectedIds]));
  container.querySelector(".glscreen-export-btn").addEventListener("click", async (e) => {
    const btn = e.target;
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    params.set("fiscalYear", String(selectedFiscalYear));
    if (selectedPeriod) params.set("periodNumber", selectedPeriod);
    if (showResolved) params.set("includeResolved", "true");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Exporting…";
    try {
      await api.downloadFromUrl(
        `/api/admin/gl/screening/export?${params}`,
        `GL_Screening_Flags_${new Date().toISOString().slice(0, 10)}.xlsx`
      );
    } catch (err) {
      window.alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

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
  bar.querySelector(".glscreen-resolve-selected-btn").disabled = selectedIds.size === 0;
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
          .map((it) => {
            const allResolved = it.reasons.every((r) => r.resolved);
            return `
          <tr class="${allResolved ? "glscreen-row-resolved" : ""}">
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
                    `<span class="badge badge-${r.resolved ? "draft" : SEVERITY_BADGE_CLASS[r.severity] || "draft"}" title="${escapeHtml(r.detail || "")}">${escapeHtml(r.label)}${r.resolved ? " (resolved)" : ""}</span>`
                )
                .join(" ")}
              ${it.onReclassList ? `<span class="badge badge-submitted" title="A matching line already exists on the Reclass list">On Reclass list</span>` : ""}
            </td>
            <td class="glscreen-row-actions">
              <button type="button" class="btn btn-link glscreen-add-one-btn" data-id="${it.id}">Add to Reclass</button>
              ${
                allResolved
                  ? `<button type="button" class="btn btn-link glscreen-unresolve-one-btn" data-id="${it.id}">Unresolve</button>`
                  : `<button type="button" class="btn btn-link glscreen-resolve-one-btn" data-id="${it.id}">Resolve</button>`
              }
            </td>
          </tr>
        `;
          })
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
  body.querySelectorAll(".glscreen-resolve-one-btn").forEach((btn) => {
    btn.addEventListener("click", () => resolveFlagged(container, [Number(btn.dataset.id)]));
  });
  body.querySelectorAll(".glscreen-unresolve-one-btn").forEach((btn) => {
    btn.addEventListener("click", () => unresolveFlagged(container, [Number(btn.dataset.id)]));
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

// "Resolve" is independent of the Reclass list -- it's just "I looked at
// this, take it off my active list" (see db.resolveGlScreeningItem). A
// line can carry more than one reason; resolving the whole line resolves
// every reason on it at once, matching the "take this off my list" mental
// model rather than asking which specific reason to clear.
async function resolveFlagged(container, ids) {
  const items = lastData.items.filter((it) => ids.includes(it.id));
  if (items.length === 0) return;
  const errors = [];
  for (const it of items) {
    for (const reason of it.reasons) {
      if (reason.resolved) continue;
      try {
        await api.post("/api/admin/gl/screening/resolve", {
          ruleKey: reason.ruleKey,
          businessUnit: it.businessUnit,
          objectAccountCode: it.objectAccountCode,
          subsidiary: it.subsidiary,
          amount: it.amount,
          glDate: it.glDate,
        });
      } catch (err) {
        errors.push(`${it.businessUnit || "line"}: ${err.message}`);
      }
    }
  }
  if (errors.length > 0) {
    window.alert(`Some lines failed to resolve:\n${errors.join("\n")}`);
  }
  await renderGlScreening(container);
}

async function unresolveFlagged(container, ids) {
  const items = lastData.items.filter((it) => ids.includes(it.id));
  if (items.length === 0) return;
  const errors = [];
  for (const it of items) {
    for (const reason of it.reasons) {
      if (!reason.resolved) continue;
      try {
        await api.post("/api/admin/gl/screening/unresolve", {
          ruleKey: reason.ruleKey,
          businessUnit: it.businessUnit,
          objectAccountCode: it.objectAccountCode,
          subsidiary: it.subsidiary,
          amount: it.amount,
          glDate: it.glDate,
        });
      } catch (err) {
        errors.push(`${it.businessUnit || "line"}: ${err.message}`);
      }
    }
  }
  if (errors.length > 0) {
    window.alert(`Some lines failed to unresolve:\n${errors.join("\n")}`);
  }
  await renderGlScreening(container);
}
