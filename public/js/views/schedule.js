import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const WOM_STATUS_LABELS = {
  pending: "Awaiting RFM request to Toyota",
  requested: "Requested from Toyota (no WOM # yet)",
  open: "Open",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
  closed: "Closed",
};

function formatMoney(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
// Every date shown is tentative -- a technician's own planned allocation for
// that day, not a locked commitment -- and filterable to one site at a time
// since a mixed-site day is hard to read at a glance. Clicking an entry
// shows that WOM's own detail (status, pricing, budget) without leaving the
// calendar.
export async function renderSchedule(container) {
  if (!state.scheduleMonth) state.scheduleMonth = currentMonthIso();
  if (state.scheduleLocation === undefined) state.scheduleLocation = "";

  let detailEntry = null;
  let entriesByKey = {};

  draw();

  async function draw() {
    let locations;
    try {
      locations = await api.get("/api/locations");
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === state.scheduleLocation ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");

    container.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="schedule-prev-month">&larr; Prev</button>
        <div class="week-range">${monthLabel(state.scheduleMonth)}</div>
        <button class="btn btn-ghost" id="schedule-next-month">Next &rarr;</button>
        <select id="schedule-location-filter"><option value="">All sites</option>${locationOptions}</select>
      </div>
      <p class="review-checklist-hint">
        WOM projects scheduled out by date, across all technicians -- E&amp;F time and time off
        aren't shown here (see Tech Allocation or Weekly Review for those). These are
        <strong>tentative dates</strong> -- each technician's own planned allocation for that day, not a
        locked commitment -- so treat them as a working plan, not a confirmed schedule. Click an entry
        for that WOM's own details.
      </p>
      <div id="schedule-calendar-host"></div>
      <div id="schedule-detail-host"></div>
    `;

    container.querySelector("#schedule-prev-month").addEventListener("click", () => {
      state.scheduleMonth = shiftMonth(state.scheduleMonth, -1);
      detailEntry = null;
      draw();
    });
    container.querySelector("#schedule-next-month").addEventListener("click", () => {
      state.scheduleMonth = shiftMonth(state.scheduleMonth, 1);
      detailEntry = null;
      draw();
    });
    container.querySelector("#schedule-location-filter").addEventListener("change", (e) => {
      state.scheduleLocation = e.target.value;
      detailEntry = null;
      draw();
    });

    const host = container.querySelector("#schedule-calendar-host");
    const detailHost = container.querySelector("#schedule-detail-host");
    let data;
    try {
      const query = state.scheduleLocation ? `?location=${encodeURIComponent(state.scheduleLocation)}` : "";
      data = await api.get(`/api/schedule/${state.scheduleMonth}${query}`);
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

    entriesByKey = {};
    for (const [dateIso, entries] of Object.entries(data.byDate)) {
      entries.forEach((e, i) => {
        entriesByKey[`${dateIso}|${i}`] = { ...e, dateIso };
      });
    }

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
                        .map((e, i) => {
                          const maximoLabel = e.maximoNumber ? ` &middot; Maximo #${escapeHtml(e.maximoNumber)}` : "";
                          return `<button type="button" class="schedule-entry" data-key="${dateIso}|${i}" title="Click for WOM details">
                              <div class="schedule-entry-main">
                                <span class="badge badge-submitted">${e.hours}h</span> ${escapeHtml(e.description || e.womCode)} — ${escapeHtml(e.techName)}
                              </div>
                              <div class="schedule-entry-sub">
                                ${escapeHtml(e.womCode)}${maximoLabel}
                                ${e.locationName ? `<span class="schedule-entry-site">${escapeHtml(e.locationName)}</span>` : ""}
                                <span class="schedule-entry-tentative">Tentative</span>
                              </div>
                            </button>`;
                        })
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

    host.querySelectorAll(".schedule-entry").forEach((btn) => {
      btn.addEventListener("click", () => {
        detailEntry = entriesByKey[btn.dataset.key];
        renderDetail();
      });
    });

    renderDetail();

    function renderDetail() {
      if (!detailEntry) {
        detailHost.innerHTML = "";
        return;
      }
      const e = detailEntry;
      const [dy2, dm2, dd2] = e.dateIso.split("-").map(Number);
      const dateLabel = new Date(dy2, dm2 - 1, dd2).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      const budgetLine =
        e.budgetHours == null ? "" : `<div>${e.remainingHours}h left of ${e.budgetHours}h budgeted</div>`;
      const priceLine =
        e.estimatedPrice == null && e.appliedPrice == null
          ? ""
          : `<div>Est. $${formatMoney(e.estimatedPrice)} / Applied $${formatMoney(e.appliedPrice)}</div>`;
      detailHost.innerHTML = `
        <div class="schedule-detail-panel">
          <button type="button" class="btn btn-link schedule-detail-close">Close</button>
          <div class="schedule-detail-title">${escapeHtml(e.description || e.womCode)} <span class="wom-code">${escapeHtml(e.womCode)}</span></div>
          <div class="schedule-detail-tentative">Tentative -- ${escapeHtml(dateLabel)}, ${e.hours}h planned by ${escapeHtml(e.techName)}</div>
          <div>${e.locationName ? escapeHtml(e.locationName) : "No location on file"}</div>
          ${e.status ? `<div>Status: ${escapeHtml(WOM_STATUS_LABELS[e.status] || e.status)}</div>` : ""}
          ${e.maximoNumber ? `<div>Maximo #${escapeHtml(e.maximoNumber)}</div>` : ""}
          ${e.subsidiaryCode ? `<div>Subsidiary ${escapeHtml(e.subsidiaryCode)}</div>` : ""}
          ${budgetLine}
          ${priceLine}
        </div>
      `;
      detailHost.querySelector(".schedule-detail-close").addEventListener("click", () => {
        detailEntry = null;
        renderDetail();
      });
    }
  }
}
