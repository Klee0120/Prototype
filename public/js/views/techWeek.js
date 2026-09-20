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

export async function renderTechWeek(container, techIdOverride) {
  const techId = techIdOverride || state.user.id;
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

  // Default every day to a full E&F split at home up front, so the common
  // case (no WOM work that day) needs no clicks -- switch the type to WOM
  // Project on a row, or carve out hours into a new split, for the rest.
  // Only for days with nothing entered yet; never touches a day someone's
  // already started, and never runs outside full edit mode.
  if (week.editMode === "full" && homeLocationCode) {
    for (const day of DAY_NAMES) {
      const hasAnySplit = allocations.some((a) => a.day === day && a.type !== "timeoff");
      if (hasAnySplit) continue;
      const ukgActual = week.ukgHoursByDay[day] || 0;
      const already = allocations.filter((a) => a.day === day).reduce((s, a) => s + Number(a.hours || 0), 0);
      const remaining = round2(ukgActual - already);
      if (remaining > 0) {
        allocations.push({ day, type: "ef", locationCode: homeLocationCode, womCode: null, hours: remaining });
      }
    }
  }

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
    const mode = week.editMode || (week.locked ? "locked" : "full");
    const locked = mode === "locked";
    const timeOffOnly = mode === "timeoff-only";
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
        ${locked && week.status === "draft" ? `<div class="status-note">The window to adjust this week has closed. Contact an admin if it needs correction.</div>` : ""}
        ${timeOffOnly ? `<div class="status-note">This week isn't open for full allocation yet -- you can enter time off in advance (vacation, sick, bereavement, holiday). Everything else opens up closer to the week itself.</div>` : ""}
      </div>

      <div class="day-grid" id="day-grid"></div>

      <div id="receipt-host"></div>

      ${locked ? "" : `
        <div class="action-row">
          <button class="btn btn-secondary" id="save-draft">Save draft</button>
          ${timeOffOnly ? "" : `<button class="btn btn-primary" id="submit-week" ${canSubmitWeek() ? "" : "disabled"}>Submit for review</button>`}
          <span class="save-message">${escapeHtml(saveMessage)}</span>
        </div>
      `}
    `;

    const grid = main.querySelector("#day-grid");
    DAY_NAMES.forEach((day) => grid.appendChild(renderDayCard(day, mode)));
    if (!timeOffOnly) main.querySelector("#receipt-host").appendChild(renderReceipt());

    main.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      renderTechWeek(container, techIdOverride);
    });
    main.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      renderTechWeek(container, techIdOverride);
    });

    if (!locked) {
      main.querySelector("#save-draft").addEventListener("click", () => saveDraft());
      const submitBtn = main.querySelector("#submit-week");
      if (submitBtn) submitBtn.addEventListener("click", submit);
    }
  }

  function renderDayCard(day, mode) {
    const locked = mode === "locked";
    const full = mode === "full";
    const timeOffOnly = mode === "timeoff-only";
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
      ${timeOffOnly ? "" : `<div class="day-rows"></div>`}
      ${full ? `
        <div class="day-actions">
          <button class="btn btn-link add-split" type="button">+ Add split</button>
          <button class="btn btn-link default-home" type="button" ${homeLocationCode ? "" : "disabled"}>
            Default to home — ${homeLocationCode ? remaining : "0.00"} hrs
          </button>
        </div>
      `: ""}
      ${timeOffOnly ? "" : `
        <div class="day-balance">
          <span class="balance-pill ${Math.abs(delta) < 0.01 ? "ok" : "warn"}">
            ${Math.abs(delta) < 0.01 ? "● Balanced" : `● Off by ${Math.abs(delta)}`}
          </span>
        </div>
      `}
      ${locked ? "" : `<div class="time-off-row"></div>`}
    `;

    if (!timeOffOnly) {
      const rowsEl = card.querySelector(".day-rows");
      if (splits.length === 0) {
        const empty = document.createElement("div");
        empty.className = "day-row-empty";
        empty.textContent = locked ? "No hours logged." : "Not yet allocated.";
        rowsEl.appendChild(empty);
      }
      splits.forEach((row) => rowsEl.appendChild(renderSplitRow(row, locked)));

      if (timeOff && locked) {
        const label = TIME_OFF_OPTIONS.find((o) => o.value === timeOff.timeOffType)?.label || timeOff.timeOffType;
        const row = document.createElement("div");
        row.className = "day-row";
        row.innerHTML = `<span class="row-wom">Time off — ${escapeHtml(label)}</span><span class="row-hours">${timeOff.hours}h</span>`;
        rowsEl.appendChild(row);
      }
    }

    if (full) {
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
    }

    if (!locked) {
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
      ${
        row.type === "wom" && row.womCode
          ? row._markComplete
            ? `<span class="mark-complete-pending">Will mark ${escapeHtml(row.womCode)} complete after you submit.</span> <button class="btn btn-link undo-complete-btn" type="button">Undo</button>`
            : `<button class="btn btn-link mark-complete-btn" type="button">Mark this WOM project complete</button>`
          : ""
      }
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
      markComplete.addEventListener("click", () => {
        if (!window.confirm(`Mark ${row.womCode} complete once this week is submitted? It will close for everyone at that point.`)) return;
        allocations[idx]._markComplete = true;
        draw();
      });
    }
    const undoComplete = rowEl.querySelector(".undo-complete-btn");
    if (undoComplete) {
      undoComplete.addEventListener("click", () => {
        allocations[idx]._markComplete = false;
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

  function renderReceipt() {
    const receipt = computeReceipt(allocations);
    const bucketLabel = (b) => {
      if (b.kind === "wom") {
        const wom = womByCode[b.code];
        return `${b.code}${wom ? ` — ${wom.description}` : ""}`;
      }
      if (b.kind === "ef") {
        const loc = locationByCode[b.code];
        return `E&F — ${loc ? loc.name : b.code}`;
      }
      const label = TIME_OFF_OPTIONS.find((o) => o.value === b.code)?.label || b.code;
      return `Time off — ${label}`;
    };

    const wrap = document.createElement("div");
    wrap.className = "receipt-panel";
    wrap.innerHTML = `
      <div class="receipt-title">Weekly Receipt — Reg / OT Breakdown</div>
      <div class="receipt-tiles">
        <div class="receipt-tile"><span class="receipt-tile-label">Week Total (Worked)</span><span class="receipt-tile-value">${receipt.totalWorked}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Regular</span><span class="receipt-tile-value ok">${receipt.regularTotal}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Overtime</span><span class="receipt-tile-value warn">${receipt.otTotal}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">OT on WOM</span><span class="receipt-tile-value warn">${receipt.otFromWom}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">OT not on WOM</span><span class="receipt-tile-value ${receipt.otFromEf > 3 ? "danger" : "warn"}">${receipt.otFromEf}</span></div>
        <div class="receipt-tile"><span class="receipt-tile-label">Time Off</span><span class="receipt-tile-value">${receipt.totalTimeOff}</span></div>
      </div>
      ${
        receipt.buckets.length === 0
          ? ""
          : `<table class="detail-table receipt-table">
              <thead><tr><th>Bucket</th><th>Type</th><th>Reg</th><th>OT</th><th>Total</th></tr></thead>
              <tbody>
                ${receipt.buckets
                  .map(
                    (b) => `<tr><td>${escapeHtml(bucketLabel(b))}</td><td>${b.kind.toUpperCase()}</td><td>${b.reg}</td><td>${b.ot}</td><td>${b.hours}</td></tr>`
                  )
                  .join("")}
                <tr class="receipt-total-row"><td colspan="2">Total</td><td>${receipt.regularTotal}</td><td>${receipt.otTotal}</td><td>${round2(receipt.regularTotal + receipt.otTotal)}</td></tr>
              </tbody>
            </table>`
      }
      <p class="receipt-note">OT rule: hours beyond 40/week are automatic overtime, calculated on the week's total (not day-by-day). WOM-allocated hours are charged to OT before E&amp;F hours. Time off is paid straight time and isn't counted toward the 40-hour threshold. When OT spans more than one WOM, it's split proportionally across them.</p>
    `;
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

      const codesToComplete = [...new Set(allocations.filter((a) => a.type === "wom" && a._markComplete).map((a) => a.womCode))];
      for (const code of codesToComplete) {
        try {
          await api.post(`/api/woms/${encodeURIComponent(code)}/complete`);
        } catch (err) {
          window.alert(`Week was submitted, but could not mark ${code} complete: ${err.message}`);
        }
      }

      await renderTechWeek(container, techIdOverride);
    } catch (err) {
      saveMessage = err.message;
      draw();
    }
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const WEEKLY_OT_THRESHOLD = 40;

// Groups a week's allocation rows into pay buckets (one per WOM, one per
// E&F location, one per time-off type) and splits each bucket's hours into
// regular/OT. Hours beyond 40/week are OT; WOM hours are charged to OT
// before E&F hours; time off is always straight time and excluded from the
// 40-hour threshold entirely. When OT spans multiple WOM (or multiple E&F)
// buckets, it's split proportionally across them — there's no specified
// priority order between individual WOMs.
function computeReceipt(allocations) {
  const buckets = new Map();
  for (const a of allocations) {
    const hours = Number(a.hours || 0);
    if (hours <= 0) continue;
    let key, kind, code;
    if (a.type === "wom") {
      kind = "wom";
      code = a.womCode;
    } else if (a.type === "ef") {
      kind = "ef";
      code = a.locationCode;
    } else {
      kind = "timeoff";
      code = a.timeOffType;
    }
    key = `${kind}:${code}`;
    if (!buckets.has(key)) buckets.set(key, { kind, code, hours: 0 });
    const b = buckets.get(key);
    b.hours = round2(b.hours + hours);
  }

  const bucketList = [...buckets.values()];
  const womBuckets = bucketList.filter((b) => b.kind === "wom");
  const efBuckets = bucketList.filter((b) => b.kind === "ef");
  const timeoffBuckets = bucketList.filter((b) => b.kind === "timeoff");

  const sumWom = round2(womBuckets.reduce((s, b) => s + b.hours, 0));
  const sumEf = round2(efBuckets.reduce((s, b) => s + b.hours, 0));
  const totalWorked = round2(sumWom + sumEf);
  const totalTimeOff = round2(timeoffBuckets.reduce((s, b) => s + b.hours, 0));

  const otTotal = round2(Math.max(0, totalWorked - WEEKLY_OT_THRESHOLD));
  const otFromWom = round2(Math.min(otTotal, sumWom));
  const otFromEf = round2(otTotal - otFromWom);

  function distribute(list, otPool, sumPool) {
    let remaining = otPool;
    list.forEach((b, i) => {
      let ot;
      if (sumPool <= 0) ot = 0;
      else if (i === list.length - 1) ot = remaining; // last bucket absorbs rounding drift
      else ot = round2((otPool * b.hours) / sumPool);
      remaining = round2(remaining - ot);
      b.ot = ot;
      b.reg = round2(b.hours - ot);
    });
  }
  distribute(womBuckets, otFromWom, sumWom);
  distribute(efBuckets, otFromEf, sumEf);
  timeoffBuckets.forEach((b) => {
    b.ot = 0;
    b.reg = b.hours;
  });

  const regularTotal = round2(bucketList.reduce((s, b) => s + b.reg, 0));

  return {
    totalWorked,
    totalTimeOff,
    otTotal,
    otFromWom,
    otFromEf,
    regularTotal,
    buckets: [...womBuckets, ...efBuckets, ...timeoffBuckets],
  };
}
