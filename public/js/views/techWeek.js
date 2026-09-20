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

export async function renderTechWeek(container) {
  const techId = state.user.id;
  const [week, woms] = await Promise.all([
    api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`),
    api.get("/api/woms"),
  ]);

  // Working copy of allocations, grouped by day, so rows can be edited locally
  // before a save round-trip.
  const allocations = week.allocations.map((a) => ({ ...a }));
  const openWoms = woms.filter((w) => w.status === "open");
  const womByCode = Object.fromEntries(woms.map((w) => [w.code, w]));

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

  function draw() {
    const locked = week.locked;
    const weekTotal = round2(allocations.reduce((s, a) => s + Number(a.hours || 0), 0));
    const delta = round2(weekTotal - week.ukgHours);
    const canSubmit = !locked && Math.abs(delta) < 0.01 && allocations.length > 0;

    main.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>

      <div class="ukg-banner">
        <div>
          <div class="ukg-label">UKG total hours (source of truth)</div>
          <div class="ukg-value">${week.ukgHours}h</div>
        </div>
        <div>
          <div class="ukg-label">Allocated hours</div>
          <div class="ukg-value ${Math.abs(delta) < 0.01 ? "ok" : "warn"}">${weekTotal}h</div>
        </div>
        <div>
          <div class="ukg-label">${delta === 0 ? "Balanced" : delta > 0 ? "Over by" : "Under by"}</div>
          <div class="ukg-value ${Math.abs(delta) < 0.01 ? "ok" : "warn"}">${Math.abs(delta)}h</div>
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
          <button class="btn btn-primary" id="submit-week" ${canSubmit ? "" : "disabled"}>Submit for review</button>
          <span class="save-message">${saveMessage}</span>
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
      main.querySelector("#save-draft").addEventListener("click", () => saveDraft(false));
      main.querySelector("#submit-week").addEventListener("click", submit);
    }
  }

  function renderDayCard(day, locked) {
    const card = document.createElement("div");
    card.className = "day-card";
    const rows = allocations.filter((a) => a.day === day);
    const dayTotal = round2(rows.reduce((s, a) => s + Number(a.hours || 0), 0));

    card.innerHTML = `
      <div class="day-card-header">
        <span class="day-name">${day}</span>
        <span class="day-total">${dayTotal}h</span>
      </div>
      <div class="day-rows"></div>
      ${locked ? "" : `<button class="btn btn-link add-row" type="button">+ Add WOM</button>`}
    `;

    const rowsEl = card.querySelector(".day-rows");
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "day-row-empty";
      empty.textContent = locked ? "No hours logged." : "No WOM allocated yet.";
      rowsEl.appendChild(empty);
    }

    rows.forEach((row) => {
      const idx = allocations.indexOf(row);
      const rowEl = document.createElement("div");
      rowEl.className = "day-row";

      if (locked) {
        const womLabel = womByCode[row.womCode] ? womByCode[row.womCode].description : row.womCode;
        rowEl.innerHTML = `
          <span class="row-wom">${escapeHtml(row.womCode)} &mdash; ${escapeHtml(womLabel)}</span>
          <span class="row-hours">${row.hours}h</span>
        `;
      } else {
        const options = [row.womCode, ...openWoms.map((w) => w.code)]
          .filter((v, i, arr) => v && arr.indexOf(v) === i)
          .map((code) => {
            const wom = womByCode[code];
            const label = wom ? `${code} — ${wom.description}` : code;
            return `<option value="${escapeHtml(code)}" ${code === row.womCode ? "selected" : ""}>${escapeHtml(label)}</option>`;
          })
          .join("");

        rowEl.innerHTML = `
          <select class="row-wom-select">${options}</select>
          <input class="row-hours-input" type="number" min="0" step="0.25" value="${row.hours}" />
          <button class="btn btn-icon remove-row" type="button" aria-label="Remove row">&times;</button>
        `;

        rowEl.querySelector(".row-wom-select").addEventListener("change", (e) => {
          allocations[idx].womCode = e.target.value;
          draw();
        });
        rowEl.querySelector(".row-hours-input").addEventListener("input", (e) => {
          allocations[idx].hours = e.target.value === "" ? 0 : Number(e.target.value);
          draw();
        });
        rowEl.querySelector(".remove-row").addEventListener("click", () => {
          allocations.splice(idx, 1);
          draw();
        });
      }

      rowsEl.appendChild(rowEl);
    });

    if (!locked) {
      card.querySelector(".add-row").addEventListener("click", () => {
        const defaultCode = openWoms.length ? openWoms[0].code : "";
        allocations.push({ day, womCode: defaultCode, hours: 0 });
        draw();
      });
    }

    return card;
  }

  async function saveDraft(silent) {
    try {
      await api.put(`/api/technicians/${techId}/weeks/${state.weekMonday}/allocations`, { allocations });
      saveMessage = silent ? saveMessage : "Draft saved.";
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
