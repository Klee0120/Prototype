import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { getTerritory } from "../globalFilters.js";

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
  const slices = top.map((c, i) => ({ label: c.category, total: c.total, color: PALETTE[i] }));
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

// Defaults to the GL lines with no PO reference -- payroll burden, journal
// entries, Concur, Pcard, fleet accruals -- since GL Reconciliation's own
// tiles already break the PO-matched and PO-number-not-found buckets down
// separately. The "include PO-referenced lines too" checkbox below widens
// it to every GL line on file, for comparison.
let includePoReferenced = false;

// Scoped to the admin nav (see adminReview.js's Spend Breakdown tab), open
// to the same global territory filter every other Financials/PO/WOM view
// already respects -- re-rendered automatically when that filter changes
// (adminReview.js's own onTerritoryChange listener re-runs draw()).
export async function renderSpendBreakdown(container) {
  renderLoadingState(container, loadingLabelFor("Spend Breakdown"));
  const territory = getTerritory();
  let data;
  try {
    const params = new URLSearchParams();
    if (territory) params.set("territory", territory);
    if (includePoReferenced) params.set("noPoReferenceOnly", "false");
    data = await api.get(`/api/admin/gl/spend-breakdown?${params}`);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const slices = buildChartSlices(data.categories);
  const totalForChart = slices.reduce((sum, s) => sum + s.total, 0);
  const maxCategoryTotal = Math.max(1, ...data.categories.map((c) => Math.abs(c.total)));

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-header-title">Spend Breakdown</h1>
        <p class="page-header-subtitle">${includePoReferenced ? "Every GL line" : "GL lines with no PO reference"}, by chart-of-accounts category and territory</p>
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
        </p>
        <label class="spend-po-toggle">
          <input type="checkbox" class="spend-include-po-toggle" ${includePoReferenced ? "checked" : ""} />
          Include GL lines that do have a PO reference too
        </label>
      </div>
    </div>
    ${
      data.unassignedLocationCount > 0
        ? `<p class="review-checklist-hint spend-unassigned-note">
             ${data.unassignedLocationCount.toLocaleString()} line${data.unassignedLocationCount === 1 ? "" : "s"} couldn't be matched to a
             location by name and fall under "Unassigned" in the territory breakdown below -- check those facility
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
        <table class="detail-table spend-territory-table">
          <thead><tr><th>Territory</th><th>Total</th><th>Lines</th></tr></thead>
          <tbody>
            ${data.territories
              .map(
                (t) => `
              <tr>
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
    <p class="review-checklist-hint">Includes negative-net categories (credits/reversals), which the chart above can't wedge.</p>
    <table class="detail-table spend-category-table">
      <thead><tr><th>Category</th><th>Total</th><th>Lines</th><th></th></tr></thead>
      <tbody>
        ${data.categories
          .map((c) => {
            const barPct = Math.min(100, (Math.abs(c.total) / maxCategoryTotal) * 100);
            return `
          <tr>
            <td>${escapeHtml(c.category)}</td>
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
    renderSpendBreakdown(container);
  });
}
