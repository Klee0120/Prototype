import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function currentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(monthIso, delta) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthIso) {
  const [y, m] = monthIso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// A month calendar of WOM project work only (no E&F, no time off) -- shared
// by the admin and technician shells, and open to any logged-in user, since
// the point is letting anyone see what's already scheduled before adding
// more to a project or a person's plate. Not a live Teams/Outlook
// connection; see README "Where this stands" for what that would need.
export async function renderSchedule(container) {
  if (!state.scheduleMonth) state.scheduleMonth = currentMonthIso();

  draw();

  async function draw() {
    container.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="schedule-prev-month">&larr; Prev</button>
        <div class="week-range">${monthLabel(state.scheduleMonth)}</div>
        <button class="btn btn-ghost" id="schedule-next-month">Next &rarr;</button>
      </div>
      <p class="review-checklist-hint">
        WOM projects scheduled out by date, across all technicians -- E&amp;F time and time off
        aren't shown here (see Tech Allocation or Weekly Review for those).
      </p>
      <div id="schedule-calendar-host"></div>
    `;

    container.querySelector("#schedule-prev-month").addEventListener("click", () => {
      state.scheduleMonth = shiftMonth(state.scheduleMonth, -1);
      draw();
    });
    container.querySelector("#schedule-next-month").addEventListener("click", () => {
      state.scheduleMonth = shiftMonth(state.scheduleMonth, 1);
      draw();
    });

    const host = container.querySelector("#schedule-calendar-host");
    let data;
    try {
      data = await api.get(`/api/schedule/${state.scheduleMonth}`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const [y, m] = state.scheduleMonth.split("-").map(Number);
    const days = [];
    for (let cursor = data.gridStart; cursor <= data.gridEnd; cursor = addDaysIso(cursor, 1)) {
      days.push(cursor);
    }
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

    host.innerHTML = `
      <table class="detail-table schedule-calendar">
        <thead><tr>${DAY_HEADERS.map((d) => `<th>${d}</th>`).join("")}</tr></thead>
        <tbody>
          ${weeks
            .map(
              (week) => `
            <tr>
              ${week
                .map((dateIso) => {
                  const [dy, dm, dd] = dateIso.split("-").map(Number);
                  const inMonth = dm === m && dy === y;
                  const entries = data.byDate[dateIso] || [];
                  return `
                    <td class="schedule-calendar-cell ${inMonth ? "" : "schedule-calendar-outside"}">
                      <div class="schedule-calendar-daynum">${dd}</div>
                      ${entries
                        .map(
                          (e) =>
                            `<div class="schedule-entry" title="${escapeHtml(e.description)}"><span class="badge badge-submitted">${e.hours}h</span> ${escapeHtml(e.womCode)} — ${escapeHtml(e.techName)}</div>`
                        )
                        .join("")}
                    </td>`;
                })
                .join("")}
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
  }
}
