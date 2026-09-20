import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { DAY_NAMES, shiftWeek, weekRangeLabel } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted — awaiting review",
  approved: "Approved & locked",
  rejected: "Returned — needs changes",
};

const TIME_OFF_OPTIONS = [
  { value: "vacation", label: "Vacation" },
  { value: "sick", label: "Sick" },
  { value: "bereavement", label: "Bereavement" },
  { value: "holiday", label: "Holiday" },
];

export async function renderTechWeek(container) {
  const techId = state.user.id;
  const [week, woms, locations] = await Promise.all([
    api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`),
    api.get("/api/woms"),
    api.get("/api/locations"),
  ]);

  // Working copy of allocations so rows can be edited locally before a save
  // round-trip.
  const allocations = week.allocations.map((a) => ({ ...a }));
  const womByCode = Object.fromEntries(woms.map((w) => [w.code, w]));
  const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
  const homeLocationCode = week.technician.homeLocationCode;

  let saveMessage = "";

  container.innerHTML = `<div id="tw-main"></div><div id="tw-attachments"></div>`;
  const main = container.querySelector("#tw-main");
  const attachmentsHost = container.querySelector("#tw-attachments");

  draw();
  renderAttachments(attachmentsHost, {
    title: "Attachments",
    relatedType: "week",
    relatedId: `${techId}|${state.weekMonday}`,
    categories: [
      { value: "ukg_screenshot", label: "UKG Timesheet Screenshot" },
      { value: "receipt", label: "Receipt / Invoice" },
    ],
    canUpload: true,
    emptyText: "No UKG screenshots or receipts attached yet.",
  });

  function openWomsAt(locationCode) {
    return woms.filter((w) => w.status === "open" && w.locationCode === locationCode);
  }

  function dayTotal(day) {
    return round2(allocations.filter((a) => a.day === day).reduce((s, a) => s + Number(a.hours || 0), 0));
  }

  function canSubmitWeek() {
    if (week.locked) return false;
    return DAY_NAMES.every((day) => Math.abs(dayTotal(day) - (week.ukgHoursByDay[day] || 0)) < 0.01);
  }

  function draw() {
    const locked = week.locked;
    const weekAllocated = round2(allocations.reduce((s, a) => s + Number(a.hours || 0), 0));

    main.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>

      <div class="ukg-banner">
        <div>
          <div class="ukg-label">UKG total hours (source of truth)</div>
          <div class="ukg-value">${week.ukgTotal}h</div>
        </div>
        <div>
          <div class="ukg-label">Allocated hours</div>
          <div class="ukg-value ${Math.abs(weekAllocated - week.ukgTotal) < 0.01 ? "ok" : "warn"}">${weekAllocated}h</div>
        </div>
      </div>

      <div class="status-banner status-${week.status}">
        <strong>${STATUS_LABELS[week.status]}</strong>
        ${week.status === "rejected" && week.note ? `<div class="status-note">Admin note: ${escapeHtml(week.note)}</div>` : ""}
        ${week.status === "approved" ? `<div class="status-note">This week is locked. Contact an admin to make corrections.</div>` : ""}
      </div>

      <div class="day-grid" id="day-grid"></div>

      ${locked ? "" : `
        <div class="action-row">
          <button class="btn btn-secondary" id="save-draft">Save draft</button>
          <button class="btn btn-primary" id="submit-week" ${canSubmitWeek() ? "" : "disabled"}>Submit for review</button>
          <span class="save-message">${escapeHtml(saveMessage)}</span>
        </div>
      `}
    `;

    const grid = main.querySelector("#day-grid");
    DAY_NAMES.forEach((day) => grid.appendChild(renderDayCard(day, locked)));

    main.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      renderTechWeek(container);
    });
    main.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      renderTechWeek(container);
    });

    if (!locked) {
      main.querySelector("#save-draft").addEventListener("click", () => saveDraft());
      main.querySelector("#submit-week").addEventListener("click", submit);
    }
  }

  function renderDayCard(day, locked) {
    const card = document.createElement("div");
    card.className = "day-card";
    const ukgActual = week.ukgHoursByDay[day] || 0;
    const splits = allocations.filter((a) => a.day === day && a.type !== "timeoff");
    const timeOff = allocations.find((a) => a.day === day && a.type === "timeoff") || null;
    const total = dayTotal(day);
    const delta = round2(total - ukgActual);
    const remaining = round2(ukgActual - total);

    card.innerHTML = `
      <div class="day-card-header">
        <span class="day-name">${day}</span>
        <span class="day-ukg-actual">UKG ACTUAL: <strong>${ukgActual}h</strong></span>
      </div>
      <div class="day-rows"></div>
      ${locked ? "" : `
        <div class="day-actions">
          <button class="btn btn-link add-split" type="button">+ Add split</button>
          <button class="btn btn-link default-home" type="button" ${homeLocationCode ? "" : "disabled"}>
            Default to home — ${homeLocationCode ? remaining : "0.00"} hrs
          </button>
        </div>
      `}
      <div class="day-balance">
        <span class="balance-pill ${Math.abs(delta) < 0.01 ? "ok" : "warn"}">
          ${Math.abs(delta) < 0.01 ? "● Balanced" : `● Off by ${Math.abs(delta)}`}
        </span>
      </div>
      ${locked ? "" : `<div class="time-off-row"></div>`}
    `;

    const rowsEl = card.querySelector(".day-rows");
    if (splits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "day-row-empty";
      empty.textContent = locked ? "No hours logged." : "Not yet allocated.";
      rowsEl.appendChild(empty);
    }
    splits.forEach((row) => rowsEl.appendChild(renderSplitRow(row, locked)));

    if (timeOff) {
      const label = TIME_OFF_OPTIONS.find((o) => o.value === timeOff.timeOffType)?.label || timeOff.timeOffType;
      if (locked) {
        const row = document.createElement("div");
        row.className = "day-row";
        row.innerHTML = `<span class="row-wom">Time off — ${escapeHtml(label)}</span><span class="row-hours">${timeOff.hours}h</span>`;
        rowsEl.appendChild(row);
      }
    }

    if (!locked) {
      card.querySelector(".add-split").addEventListener("click", () => {
        const locationCode = homeLocationCode || (locations[0] && locations[0].code) || "";
        allocations.push({ day, type: "ef", locationCode, womCode: null, hours: 0 });
        draw();
      });
      card.querySelector(".default-home").addEventListener("click", () => {
        if (!homeLocationCode || remaining <= 0) return;
        const existingHome = allocations.find(
          (a) => a.day === day && a.type === "ef" && a.locationCode === homeLocationCode
        );
        if (existingHome) existingHome.hours = round2(existingHome.hours + remaining);
        else allocations.push({ day, type: "ef", locationCode: homeLocationCode, womCode: null, hours: remaining });
        draw();
      });

      const timeOffHost = card.querySelector(".time-off-row");
      timeOffHost.appendChild(renderTimeOffRow(day, timeOff));
    }

    return card;
  }

  function renderSplitRow(row, locked) {
    const idx = allocations.indexOf(row);
    const rowEl = document.createElement("div");
    rowEl.className = "split-row";

    if (locked) {
      const label =
        row.type === "wom"
          ? `${row.womCode} — ${womByCode[row.womCode] ? womByCode[row.womCode].description : ""}`
          : `E&F — ${locationByCode[row.locationCode] ? locationByCode[row.locationCode].name : row.locationCode}`;
      rowEl.className = "day-row";
      rowEl.innerHTML = `<span class="row-wom">${escapeHtml(label)}</span><span class="row-hours">${row.hours}h</span>`;
      return rowEl;
    }

    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === row.locationCode ? "selected" : ""}>${escapeHtml(l.name)}${l.code === homeLocationCode ? " (home)" : ""}</option>`)
      .join("");

    const womOptionsForLocation = openWomsAt(row.locationCode);
    const womOptions = womOptionsForLocation
      .map((w) => {
        const remainingLabel = w.remainingHours == null ? "" : ` (${w.remainingHours}h left)`;
        return `<option value="${escapeHtml(w.code)}" ${w.code === row.womCode ? "selected" : ""}>${escapeHtml(w.code)} — ${escapeHtml(w.description)}${remainingLabel}</option>`;
      })
      .join("");

    rowEl.innerHTML = `
      <div class="split-row-fields">
        <select class="split-type-select">
          <option value="ef" ${row.type === "ef" ? "selected" : ""}>E&amp;F — Location</option>
          <option value="wom" ${row.type === "wom" ? "selected" : ""}>WOM Project</option>
        </select>
        <select class="split-location-select">${locationOptions}</select>
        ${row.type === "wom" ? `<select class="split-wom-select">${womOptions || `<option value="">No open WOMs at this location</option>`}</select>` : ""}
        <input class="split-hours-input" type="number" min="0" step="0.25" value="${row.hours}" />
        <button class="btn btn-icon remove-split" type="button" aria-label="Remove split">&times;</button>
      </div>
      ${row.type === "wom" && row.womCode ? `<button class="btn btn-link mark-complete-btn" type="button">Mark this WOM project complete</button>` : ""}
    `;

    rowEl.querySelector(".split-type-select").addEventListener("change", (e) => {
      allocations[idx].type = e.target.value;
      if (e.target.value === "wom") {
        const firstOpen = openWomsAt(allocations[idx].locationCode)[0];
        allocations[idx].womCode = firstOpen ? firstOpen.code : null;
      } else {
        allocations[idx].womCode = null;
      }
      draw();
    });
    rowEl.querySelector(".split-location-select").addEventListener("change", (e) => {
      allocations[idx].locationCode = e.target.value;
      if (allocations[idx].type === "wom") {
        const firstOpen = openWomsAt(e.target.value)[0];
        allocations[idx].womCode = firstOpen ? firstOpen.code : null;
      }
      draw();
    });
    const womSelect = rowEl.querySelector(".split-wom-select");
    if (womSelect) {
      womSelect.addEventListener("change", (e) => {
        allocations[idx].womCode = e.target.value;
        draw();
      });
    }
    rowEl.querySelector(".split-hours-input").addEventListener("input", (e) => {
      allocations[idx].hours = e.target.value === "" ? 0 : Number(e.target.value);
      draw();
    });
    rowEl.querySelector(".remove-split").addEventListener("click", () => {
      allocations.splice(idx, 1);
      draw();
    });
    const markComplete = rowEl.querySelector(".mark-complete-btn");
    if (markComplete) {
      markComplete.addEventListener("click", async () => {
        if (!window.confirm(`Mark ${row.womCode} complete? This closes it for everyone.`)) return;
        await api.post(`/api/woms/${encodeURIComponent(row.womCode)}/complete`);
        const refreshed = await api.get("/api/woms");
        woms.length = 0;
        woms.push(...refreshed);
        Object.assign(womByCode, Object.fromEntries(refreshed.map((w) => [w.code, w])));
        draw();
      });
    }

    return rowEl;
  }

  function renderTimeOffRow(day, timeOff) {
    const wrap = document.createElement("div");
    wrap.className = "time-off-field";
    const options = [`<option value="">None</option>`]
      .concat(TIME_OFF_OPTIONS.map((o) => `<option value="${o.value}" ${timeOff && timeOff.timeOffType === o.value ? "selected" : ""}>${o.label}</option>`))
      .join("");

    wrap.innerHTML = `
      <label class="time-off-label">Time off</label>
      <select class="time-off-select">${options}</select>
      <input class="time-off-hours-input" type="number" min="0" step="0.25" value="${timeOff ? timeOff.hours : ""}" ${timeOff ? "" : "disabled"} />
    `;

    wrap.querySelector(".time-off-select").addEventListener("change", (e) => {
      const existingIdx = allocations.findIndex((a) => a.day === day && a.type === "timeoff");
      if (!e.target.value) {
        if (existingIdx !== -1) allocations.splice(existingIdx, 1);
      } else if (existingIdx !== -1) {
        allocations[existingIdx].timeOffType = e.target.value;
      } else {
        allocations.push({ day, type: "timeoff", timeOffType: e.target.value, hours: 8 });
      }
      draw();
    });
    wrap.querySelector(".time-off-hours-input").addEventListener("input", (e) => {
      const existingIdx = allocations.findIndex((a) => a.day === day && a.type === "timeoff");
      if (existingIdx !== -1) allocations[existingIdx].hours = e.target.value === "" ? 0 : Number(e.target.value);
      draw();
    });

    return wrap;
  }

  async function saveDraft() {
    try {
      await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/allocations`, { allocations });
      saveMessage = "Draft saved.";
    } catch (err) {
      saveMessage = err.message;
    }
    draw();
  }

  async function submit() {
    try {
      await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/allocations`, { allocations });
      await api.post(`/api/technicians/${techId}/weeks/${state.weekMonday}/submit`);
      await renderTechWeek(container);
    } catch (err) {
      saveMessage = err.message;
      draw();
    }
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
