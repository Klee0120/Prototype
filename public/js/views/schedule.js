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

// 0 = Monday .. 6 = Sunday, matching DAY_HEADERS -- JS's own getDay() is
// Sunday-first (0..6), so this just rotates it.
function mondayIndexOf(dateIso) {
  const [y, m, d] = dateIso.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

function mondayOfIso(dateIso) {
  return addDaysIso(dateIso, -mondayIndexOf(dateIso));
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

  const isAdmin = state.user && state.user.role === "admin";
  let detailEntry = null;
  let showAddForm = false;
  let addMessage = "";
  let entriesByKey = {};

  draw();

  async function draw() {
    let locations, woms, technicians;
    try {
      [locations, woms] = await Promise.all([api.get("/api/locations"), api.get("/api/woms")]);
      technicians = isAdmin ? await api.get("/api/admin/technicians") : null;
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const openWoms = woms.filter((w) => w.status === "open");
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const activeTechnicians = isAdmin ? technicians.filter((t) => t.employmentStatus === "active") : null;

    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === state.scheduleLocation ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");

    container.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="schedule-prev-month">&larr; Prev</button>
        <div class="week-range">${monthLabel(state.scheduleMonth)}</div>
        <button class="btn btn-ghost" id="schedule-next-month">Next &rarr;</button>
        <select id="schedule-location-filter"><option value="">All sites</option>${locationOptions}</select>
        <button class="btn btn-secondary" id="schedule-add-toggle">${showAddForm ? "Cancel" : "+ Schedule a WOM"}</button>
      </div>
      <p class="review-checklist-hint">
        WOM projects scheduled out by date, across all technicians -- E&amp;F time and time off
        aren't shown here (see Tech Allocation or Weekly Review for those). These are
        <strong>tentative dates</strong> -- each technician's own planned allocation for that day, not a
        locked commitment -- so treat them as a working plan, not a confirmed schedule. Click an entry
        for that WOM's own details, or <strong>+ Schedule a WOM</strong> to put one on the calendar
        ${isAdmin ? "for any technician" : "for yourself"} across one or more days at once.
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
    container.querySelector("#schedule-add-toggle").addEventListener("click", () => {
      showAddForm = !showAddForm;
      detailEntry = null;
      addMessage = "";
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
        showAddForm = false;
        renderDetail();
      });
    });

    renderDetail();

    function renderDetail() {
      if (showAddForm) {
        renderAddForm();
        return;
      }
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

    // Scheduling a WOM here is just adding a normal allocation for each
    // date in the range -- same data, same rules (open WOM, matching
    // location, week not locked) as Tech Allocation/My Week, just entered
    // from the calendar instead. A technician can only do this for
    // themselves; admin/RFM can do it for anyone, matching who can already
    // edit a given week's allocations server-side. A range can span more
    // than one week, so this batches one GET+PUT per affected week rather
    // than one per day.
    function renderAddForm() {
      const techOptions = isAdmin
        ? activeTechnicians.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")
        : "";
      // Location first, then project name within it -- same two-step
      // pattern as every other WOM-picking dropdown in the app (Tech
      // Allocation/My Week's own day rows), rather than one long flat list
      // of every open WOM everywhere.
      const locationsWithOpenWoms = locations.filter((l) => openWoms.some((w) => w.locationCode === l.code));
      const addLocationOptions = locationsWithOpenWoms
        .map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`)
        .join("");
      const defaultLocationCode = (state.scheduleLocation && locationsWithOpenWoms.some((l) => l.code === state.scheduleLocation) && state.scheduleLocation) || (locationsWithOpenWoms[0] && locationsWithOpenWoms[0].code) || "";

      function womOptionsFor(locationCode) {
        return openWoms
          .filter((w) => w.locationCode === locationCode)
          .slice()
          .sort((a, b) => a.description.localeCompare(b.description))
          .map((w) => `<option value="${escapeHtml(w.code)}">${escapeHtml(w.description)} (${escapeHtml(w.code)})</option>`)
          .join("");
      }

      detailHost.innerHTML = `
        <div class="schedule-detail-panel">
          <button type="button" class="btn btn-link schedule-detail-close">Close</button>
          <div class="schedule-detail-title">Schedule a WOM</div>
          <form class="schedule-add-form">
            ${
              isAdmin
                ? `<label class="schedule-add-field"><span>Technician</span><select name="techId" required><option value="">Choose one</option>${techOptions}</select></label>`
                : `<div>For: ${escapeHtml(state.user.name)}</div>`
            }
            <label class="schedule-add-field">
              <span>Location</span>
              <select name="locationCode" required><option value="">Choose one</option>${addLocationOptions}</select>
            </label>
            <label class="schedule-add-field">
              <span>Project name</span>
              <select name="womCode" required ${defaultLocationCode ? "" : "disabled"}>
                <option value="">${defaultLocationCode ? "Choose one" : "Choose a location first"}</option>
                ${defaultLocationCode ? womOptionsFor(defaultLocationCode) : ""}
              </select>
            </label>
            <div class="schedule-add-daterange">
              <label class="schedule-add-field"><span>First day</span><input name="startDate" type="date" required /></label>
              <label class="schedule-add-field"><span>Last day</span><input name="endDate" type="date" required /></label>
            </div>
            <label class="schedule-add-field"><span>Hours per day</span><input name="hours" type="number" min="0.5" step="0.5" required /></label>
            <button type="submit" class="btn btn-primary">Add to schedule</button>
            <span class="save-message schedule-add-message">${escapeHtml(addMessage)}</span>
          </form>
        </div>
      `;
      detailHost.querySelector(".schedule-detail-close").addEventListener("click", () => {
        showAddForm = false;
        renderDetail();
      });
      if (openWoms.length === 0) {
        detailHost.querySelector(".schedule-add-message").textContent = "No open WOMs to schedule -- a WOM needs a real WOM # before hours can be charged to it.";
      }
      const addLocationSelect = detailHost.querySelector('select[name="locationCode"]');
      if (defaultLocationCode) addLocationSelect.value = defaultLocationCode;
      addLocationSelect.addEventListener("change", (e) => {
        const womSelect = detailHost.querySelector('select[name="womCode"]');
        const locationCode = e.target.value;
        womSelect.disabled = !locationCode;
        womSelect.innerHTML = `<option value="">${locationCode ? "Choose one" : "Choose a location first"}</option>${locationCode ? womOptionsFor(locationCode) : ""}`;
      });
      detailHost.querySelector(".schedule-add-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = form.querySelector(".schedule-add-message");
        const techId = isAdmin ? form.techId.value : state.user.id;
        const womCode = form.womCode.value;
        const hours = Number(form.hours.value);
        const startDate = form.startDate.value;
        const endDate = form.endDate.value;
        if (!techId || !form.locationCode.value || !womCode || !hours || !startDate || !endDate) {
          msg.textContent = "Choose a technician, location, project, date range, and hours.";
          return;
        }
        if (endDate < startDate) {
          msg.textContent = "Last day can't be before first day.";
          return;
        }
        const dates = [];
        for (let cur = startDate; cur <= endDate; cur = addDaysIso(cur, 1)) {
          dates.push(cur);
          if (dates.length > 62) break; // sanity cap -- about two months
        }
        if (dates.length > 62) {
          msg.textContent = "That range is too long -- try 62 days or fewer at a time.";
          return;
        }

        const wom = openWoms.find((w) => w.code === womCode);
        const datesByWeek = {};
        for (const d of dates) {
          const weekMonday = mondayOfIso(d);
          (datesByWeek[weekMonday] = datesByWeek[weekMonday] || []).push(d);
        }

        msg.textContent = "Scheduling…";
        let scheduledDays = 0;
        const weekErrors = [];
        for (const [weekMonday, weekDates] of Object.entries(datesByWeek)) {
          try {
            const week = await api.get(`/api/technicians/${encodeURIComponent(techId)}/weeks/${weekMonday}`);
            const newEntries = weekDates.map((d) => ({
              day: DAY_HEADERS[mondayIndexOf(d)],
              type: "wom",
              locationCode: wom.locationCode,
              womCode,
              hours,
            }));
            const allocations = [...week.allocations, ...newEntries];
            await api.put(`/api/technicians/${encodeURIComponent(techId)}/weeks/${weekMonday}/allocations`, { allocations });
            scheduledDays += weekDates.length;
          } catch (err) {
            weekErrors.push(`week of ${weekMonday}: ${err.message}`);
          }
        }

        if (weekErrors.length === 0) {
          showAddForm = false;
          addMessage = "";
          await draw();
        } else {
          const dayWord = scheduledDays === 1 ? "day" : "days";
          msg.textContent = `${scheduledDays} ${dayWord} scheduled. Some weeks failed: ${weekErrors.join("; ")}`;
        }
      });
    }
  }
}
