import { api } from "../api.js";
import { wireDateMaskInput, isoFromUs } from "../dateMask.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";

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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// A jump-to-any-month picker beats paging Prev/Next one month at a time --
// same pattern as the Labor Reports tab's own month/year selects, just a
// forward-leaning range since scheduling is about what's coming up, not
// filed history (a couple years back still covers looking up old plans).
function scheduleYearOptions(selectedYear) {
  const current = new Date().getFullYear();
  const years = new Set();
  for (let y = current - 2; y <= current + 2; y++) years.add(y);
  years.add(selectedYear);
  return [...years]
    .sort((a, b) => a - b)
    .map((y) => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`)
    .join("");
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

// Groups a week's day-by-day entries into contiguous "runs" -- the same
// technician + WOM + hours appearing on consecutive days -- so the
// calendar can draw one bar spanning those days instead of repeating an
// identical entry on every day it covers, then greedily packs runs that
// would otherwise overlap into separate lanes (rows), like a simple Gantt
// chart. `keyOf(dayIndex, entryIndex)` maps back to the flat entriesByKey
// lookup the click handler and detail panel already use.
function buildWeekRuns(week, byDate, keyOf) {
  const openRuns = new Map(); // groupKey -> run still extending
  const runs = [];
  for (let day = 0; day < week.length; day++) {
    const entries = byDate[week[day]] || [];
    const touchedToday = new Set();
    entries.forEach((entry, i) => {
      const groupKey = `${entry.techId || entry.techName}::${entry.womCode}::${entry.hours}`;
      const key = keyOf(week[day], i);
      const open = openRuns.get(groupKey);
      if (open && open.endDay === day - 1 && !touchedToday.has(groupKey)) {
        open.endDay = day;
        open.keys.push(key);
      } else {
        const run = { groupKey, startDay: day, endDay: day, keys: [key], entry };
        runs.push(run);
        openRuns.set(groupKey, run);
      }
      touchedToday.add(groupKey);
    });
    // A run whose groupKey didn't show up today has ended -- remove it so
    // a later occurrence of the same tech/WOM/hours (after a gap) starts a
    // fresh run instead of wrongly bridging across the gap.
    for (const [groupKey, run] of openRuns) {
      if (run.endDay !== day) openRuns.delete(groupKey);
    }
  }

  runs.sort((a, b) => a.startDay - b.startDay);
  const laneEnds = [];
  for (const run of runs) {
    let lane = laneEnds.findIndex((end) => end < run.startDay);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(run.endDay);
    } else {
      laneEnds[lane] = run.endDay;
    }
    run.lane = lane;
  }

  return { runs, laneCount: laneEnds.length };
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

    const [scheduleYear, scheduleMonthNum] = state.scheduleMonth.split("-").map(Number);

    container.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="schedule-prev-month">&larr; Prev</button>
        <div class="report-month-year-nav">
          <label class="report-month-picker">
            <select id="schedule-month-select">${MONTH_NAMES.map((name, i) => `<option value="${i + 1}" ${i + 1 === scheduleMonthNum ? "selected" : ""}>${name}</option>`).join("")}</select>
          </label>
          <label class="report-year-picker">
            <select id="schedule-year-select">${scheduleYearOptions(scheduleYear)}</select>
          </label>
        </div>
        <button class="btn btn-ghost" id="schedule-next-month">Next &rarr;</button>
        <select id="schedule-location-filter"><option value="">All sites</option>${locationOptions}</select>
        <button class="btn btn-secondary" id="schedule-add-toggle">+ Schedule a WOM</button>
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
    container.querySelector("#schedule-month-select").addEventListener("change", (e) => {
      state.scheduleMonth = `${scheduleYear}-${String(Number(e.target.value)).padStart(2, "0")}`;
      detailEntry = null;
      draw();
    });
    container.querySelector("#schedule-year-select").addEventListener("change", (e) => {
      state.scheduleMonth = `${e.target.value}-${String(scheduleMonthNum).padStart(2, "0")}`;
      detailEntry = null;
      draw();
    });
    container.querySelector("#schedule-location-filter").addEventListener("change", (e) => {
      state.scheduleLocation = e.target.value;
      detailEntry = null;
      draw();
    });
    container.querySelector("#schedule-add-toggle").addEventListener("click", () => {
      openAddModal();
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
    const keyOf = (dateIso, i) => `${dateIso}|${i}`;

    host.innerHTML = `
      <div class="schedule-calendar-grid">
        <div class="schedule-calendar-headerrow">${DAY_HEADERS.map((d) => `<div class="schedule-calendar-headercell">${d}</div>`).join("")}</div>
        ${weeks
          .map((week) => {
            const { runs, laneCount } = buildWeekRuns(week, data.byDate, keyOf);
            const daycells = week
              .map((dateIso, i) => {
                const [dy, dm, dd] = dateIso.split("-").map(Number);
                const inMonth = dm === m && dy === y;
                return `<div class="schedule-daycell ${inMonth ? "" : "schedule-calendar-outside"}" style="grid-column:${i + 1}">
                  <div class="schedule-calendar-daynum">${dd}</div>
                </div>`;
              })
              .join("");
            const runBars = runs
              .map((run) => {
                const e = run.entry;
                const maximoLabel = e.maximoNumber ? ` &middot; Maximo #${escapeHtml(e.maximoNumber)}` : "";
                const span = run.endDay - run.startDay + 1;
                return `<button type="button" class="schedule-entry" data-keys="${run.keys.join(",")}" title="Click for WOM details" style="grid-column: ${run.startDay + 1} / span ${span}; grid-row: ${run.lane + 2};">
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
              .join("");
            return `<div class="schedule-week" style="grid-template-rows: repeat(${laneCount + 1}, auto)">${daycells}${runBars}</div>`;
          })
          .join("")}
      </div>
    `;

    host.querySelectorAll(".schedule-entry").forEach((btn) => {
      btn.addEventListener("click", () => {
        const keys = btn.dataset.keys.split(",");
        const first = entriesByKey[keys[0]];
        const last = entriesByKey[keys[keys.length - 1]];
        detailEntry = { ...first, dateIsoEnd: last.dateIso };
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
      const dateLabelFor = (iso) => {
        const [dy2, dm2, dd2] = iso.split("-").map(Number);
        return new Date(dy2, dm2 - 1, dd2).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
      };
      const isRange = e.dateIsoEnd && e.dateIsoEnd !== e.dateIso;
      const dateLabel = isRange ? `${dateLabelFor(e.dateIso)} – ${dateLabelFor(e.dateIsoEnd)}` : dateLabelFor(e.dateIso);
      const hoursLabel = isRange ? `${e.hours}h/day` : `${e.hours}h`;
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
          <div class="schedule-detail-tentative">Tentative -- ${escapeHtml(dateLabel)}, ${hoursLabel} planned by ${escapeHtml(e.techName)}</div>
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
    function openAddModal() {
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
      // Defaults to the technician's own home location -- they can still
      // pick anywhere else that has open work, this just saves the most
      // common case (someone scheduling their own site) a step. Falls back
      // to the calendar's own site filter, then just the first location
      // with open work, if there's no home location on file or it has none.
      function preferredLocationCode(techId) {
        const homeLocationCode = isAdmin
          ? techId && (activeTechnicians.find((t) => t.id === techId) || {}).homeLocationCode
          : state.user.homeLocationCode;
        if (homeLocationCode && locationsWithOpenWoms.some((l) => l.code === homeLocationCode)) return homeLocationCode;
        if (state.scheduleLocation && locationsWithOpenWoms.some((l) => l.code === state.scheduleLocation)) return state.scheduleLocation;
        return (locationsWithOpenWoms[0] && locationsWithOpenWoms[0].code) || "";
      }
      const defaultLocationCode = preferredLocationCode(isAdmin ? "" : state.user.id);

      function womOptionsFor(locationCode) {
        return openWoms
          .filter((w) => w.locationCode === locationCode)
          .slice()
          .sort((a, b) => a.description.localeCompare(b.description))
          .map((w) => `<option value="${escapeHtml(w.code)}">${escapeHtml(w.description)} (${escapeHtml(w.code)})</option>`)
          .join("");
      }

      const { body, close } = openModal({
        title: "Schedule a WOM",
        bodyHtml: `
          <form class="schedule-add-form modal-form">
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
              <label class="schedule-add-field"><span>First day</span><input name="startDate" type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" required /></label>
              <label class="schedule-add-field"><span>Last day</span><input name="endDate" type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" required /></label>
            </div>
            <label class="schedule-add-field"><span>Hours per day</span><input name="hours" type="number" min="0.5" step="0.5" required /></label>
            <div class="modal-form-actions">
              <button type="submit" class="btn btn-primary">Add to schedule</button>
            </div>
            <span class="save-message schedule-add-message"></span>
          </form>
        `,
      });
      if (openWoms.length === 0) {
        body.querySelector(".schedule-add-message").textContent = "No open WOMs to schedule -- a WOM needs a real WOM # before hours can be charged to it.";
      }
      wireDateMaskInput(body.querySelector('input[name="startDate"]'));
      wireDateMaskInput(body.querySelector('input[name="endDate"]'));
      const addLocationSelect = body.querySelector('select[name="locationCode"]');
      if (defaultLocationCode) addLocationSelect.value = defaultLocationCode;
      function applyLocationCode(locationCode) {
        addLocationSelect.value = locationCode;
        const womSelect = body.querySelector('select[name="womCode"]');
        womSelect.disabled = !locationCode;
        womSelect.innerHTML = `<option value="">${locationCode ? "Choose one" : "Choose a location first"}</option>${locationCode ? womOptionsFor(locationCode) : ""}`;
      }
      addLocationSelect.addEventListener("change", (e) => applyLocationCode(e.target.value));
      if (isAdmin) {
        // Re-defaults to the newly-picked technician's own home location --
        // still just a starting point, not a restriction; the location
        // dropdown above stays fully open to pick anywhere else.
        body.querySelector('select[name="techId"]').addEventListener("change", (e) => {
          applyLocationCode(preferredLocationCode(e.target.value));
        });
      }
      body.querySelector(".schedule-add-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = form.querySelector(".schedule-add-message");
        const techId = isAdmin ? form.techId.value : state.user.id;
        const womCode = form.womCode.value;
        const hours = Number(form.hours.value);
        if (!techId || !form.locationCode.value || !womCode || !hours || !form.startDate.value.trim() || !form.endDate.value.trim()) {
          msg.textContent = "Choose a technician, location, project, date range, and hours.";
          return;
        }
        const startDate = isoFromUs(form.startDate.value);
        const endDate = isoFromUs(form.endDate.value);
        if (!startDate || !endDate) {
          msg.textContent = "Dates must be a full MM/DD/YYYY.";
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
        const dayErrors = [];
        // Each day is saved on its own via schedule-wom (day-scoped, ignores
        // the week's own edit lock/window -- scheduling is a planning action,
        // not a timesheet edit), fetching that day's existing entries first
        // so a WOM already on that day isn't clobbered, just added alongside.
        for (const [weekMonday, weekDates] of Object.entries(datesByWeek)) {
          let week;
          try {
            week = await api.get(`/api/technicians/${encodeURIComponent(techId)}/weeks/${weekMonday}`);
          } catch (err) {
            for (const d of weekDates) dayErrors.push(`${d}: ${err.message}`);
            continue;
          }
          for (const d of weekDates) {
            const day = DAY_HEADERS[mondayIndexOf(d)];
            const existingForDay = week.allocations.filter((a) => a.day === day);
            const allocations = [...existingForDay, { day, type: "wom", locationCode: wom.locationCode, womCode, hours }];
            try {
              await api.put(`/api/technicians/${encodeURIComponent(techId)}/weeks/${weekMonday}/schedule-wom`, { day, allocations });
              scheduledDays += 1;
            } catch (err) {
              dayErrors.push(`${d}: ${err.message}`);
            }
          }
        }

        if (dayErrors.length === 0) {
          close();
          await draw();
        } else {
          const dayWord = scheduledDays === 1 ? "day" : "days";
          msg.textContent = `${scheduledDays} ${dayWord} scheduled. Some days failed: ${dayErrors.join("; ")}`;
        }
      });
    }
  }
}
