import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { DAY_NAMES, shiftWeek, weekRangeLabel } from "../weekUtil.js";

const KIND_BADGE_CLASS = { ef: "approved", wom: "submitted", timeoff: "draft" };

// Read-only "who's where this week" grid, shared by both the admin and
// technician shells -- built entirely from allocations already in this app
// (no live Teams/Outlook connection yet; see README "Where this stands" for
// what a future integration would need). The point right now is letting
// anyone check a teammate's already-committed work before piling on more,
// without needing IT to approve anything first.
export async function renderSchedule(container) {
  draw();

  async function draw() {
    container.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="schedule-prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="schedule-next-week">Next &rarr;</button>
      </div>
      <p class="review-checklist-hint">
        Where everyone's allocated this week, at a glance -- check here before assigning someone
        more work so nothing gets double-booked. Pulled from allocations already in this app, not
        a live calendar connection (yet).
      </p>
      <div id="schedule-grid-host"></div>
    `;

    container.querySelector("#schedule-prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      draw();
    });
    container.querySelector("#schedule-next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      draw();
    });

    const gridHost = container.querySelector("#schedule-grid-host");
    let rows;
    try {
      rows = await api.get(`/api/schedule/${state.weekMonday}`);
    } catch (err) {
      gridHost.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    if (rows.length === 0) {
      gridHost.innerHTML = `<p class="empty-note">No active technicians to show.</p>`;
      return;
    }

    gridHost.innerHTML = `
      <div class="schedule-table-wrap">
        <table class="detail-table schedule-table">
          <thead>
            <tr>
              <th>Technician</th>
              ${DAY_NAMES.map((d) => `<th>${d}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td class="schedule-tech-name">${escapeHtml(r.techName)}</td>
                ${DAY_NAMES.map((d) => `<td>${renderDayCell(r.days[d])}</td>`).join("")}
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderDayCell(entries) {
    if (!entries || entries.length === 0) return `<span class="schedule-empty-cell">—</span>`;
    return entries
      .map(
        (e) =>
          `<div class="schedule-entry"><span class="badge badge-${KIND_BADGE_CLASS[e.kind] || "draft"}">${e.hours}h</span> ${escapeHtml(e.label)}</div>`
      )
      .join("");
  }
}
