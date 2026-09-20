import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { shiftWeek, weekRangeLabel, DAY_NAMES } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";
import { renderTechniciansTab } from "./technicianProfile.js";
import { renderTechWeek } from "./techWeek.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

const TIME_OFF_LABELS = { vacation: "Vacation", sick: "Sick", bereavement: "Bereavement", holiday: "Holiday" };

export async function renderAdminReview(container) {
  let activeTab = "review";
  let allocTechId = null;
  const expanded = new Map(); // techId -> detail payload
  const womsExpanded = new Set();

  draw();

  async function draw() {
    container.innerHTML = `
      <div class="tabs">
        <button class="tab ${activeTab === "techalloc" ? "active" : ""}" data-tab="techalloc">Tech Allocation</button>
        <button class="tab ${activeTab === "review" ? "active" : ""}" data-tab="review">Weekly Review</button>
        <button class="tab ${activeTab === "woms" ? "active" : ""}" data-tab="woms">WOM Status</button>
        <button class="tab ${activeTab === "technicians" ? "active" : ""}" data-tab="technicians">Technicians</button>
        <button class="tab ${activeTab === "audit" ? "active" : ""}" data-tab="audit">Audit Trail</button>
      </div>
      <div id="tab-content" class="tab-content"></div>
    `;

    container.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        draw();
      });
    });

    const content = container.querySelector("#tab-content");
    if (activeTab === "techalloc") await drawTechAllocation(content);
    else if (activeTab === "review") await drawReview(content);
    else if (activeTab === "woms") await drawWoms(content);
    else if (activeTab === "technicians") renderTechniciansTab(content);
    else await drawAudit(content);
  }

  async function drawTechAllocation(content) {
    const techs = await api.get("/api/admin/technicians");
    const selectable = techs.filter((t) => t.employmentStatus === "active");
    if (!allocTechId && selectable.length > 0) allocTechId = selectable[0].id;

    const options = selectable.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === allocTechId ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
    const currentIndex = selectable.findIndex((t) => t.id === allocTechId);

    content.innerHTML = `
      <div class="tech-alloc-switcher">
        <button class="btn btn-ghost tech-alloc-prev" type="button" ${currentIndex <= 0 ? "disabled" : ""}>&larr; Prev</button>
        <select class="tech-alloc-select">${options}</select>
        <button class="btn btn-ghost tech-alloc-next" type="button" ${currentIndex === -1 || currentIndex >= selectable.length - 1 ? "disabled" : ""}>Next &rarr;</button>
      </div>
      <p class="tech-alloc-hint">You're allocating this technician's time on their behalf.</p>
      <div class="tech-alloc-body"></div>
    `;

    if (selectable.length === 0) {
      content.querySelector(".tech-alloc-body").innerHTML = `<p class="empty-note">No active technicians.</p>`;
      return;
    }

    content.querySelector(".tech-alloc-select").addEventListener("change", (e) => {
      allocTechId = e.target.value;
      draw();
    });
    content.querySelector(".tech-alloc-prev").addEventListener("click", () => {
      if (currentIndex > 0) allocTechId = selectable[currentIndex - 1].id;
      draw();
    });
    content.querySelector(".tech-alloc-next").addEventListener("click", () => {
      if (currentIndex < selectable.length - 1) allocTechId = selectable[currentIndex + 1].id;
      draw();
    });

    await renderTechWeek(content.querySelector(".tech-alloc-body"), allocTechId);
  }

  async function drawReview(content) {
    const [rows, locations] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    content.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>
      <div class="review-list" id="review-list"></div>
    `;

    content.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      draw();
    });
    content.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      draw();
    });

    const list = content.querySelector("#review-list");
    for (const row of rows) {
      list.appendChild(await renderReviewRow(row, content, locationByCode));
    }
  }

  async function renderReviewRow(row, content, locationByCode) {
    const el = document.createElement("div");
    el.className = "review-row";
    const balanced = Math.abs(row.allocatedHours - row.ukgHours) < 0.01;

    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(row.technician.name)}</div>
        <div class="review-row-hours ${balanced ? "ok" : "warn"}">${row.allocatedHours}h / ${row.ukgHours}h UKG</div>
        <span class="badge badge-${row.status}">${STATUS_LABELS[row.status]}</span>
        <button class="btn btn-link expand-btn" type="button">${expanded.has(row.technician.id) ? "Hide" : "Details"}</button>
      </div>
      <div class="review-row-detail" id="detail-${row.technician.id}"></div>
    `;

    el.querySelector(".expand-btn").addEventListener("click", async () => {
      if (expanded.has(row.technician.id)) {
        expanded.delete(row.technician.id);
      } else {
        const detail = await api.get(`/api/technicians/${row.technician.id}/weeks/${state.weekMonday}`);
        expanded.set(row.technician.id, detail);
      }
      await drawReview(content);
    });

    if (expanded.has(row.technician.id)) {
      const detail = expanded.get(row.technician.id);
      const detailEl = el.querySelector(`#detail-${row.technician.id}`);
      detailEl.innerHTML =
        renderUkgForm(detail) +
        renderDetailTable(detail, locationByCode) +
        renderReviewActions(row) +
        `<div class="review-attachments"></div>`;
      wireUkgForm(detailEl, row, content);
      wireReviewActions(detailEl, row, content);
      await renderAttachments(detailEl.querySelector(".review-attachments"), {
        title: "UKG Screenshots & Receipts",
        relatedType: "week",
        relatedId: `${row.technician.id}|${state.weekMonday}`,
        categories: [
          { value: "ukg_screenshot", label: "UKG Timesheet Screenshot" },
          { value: "receipt", label: "Receipt / Invoice" },
        ],
        canUpload: true,
        emptyText: "No UKG screenshots or receipts attached yet.",
      });
    }

    return el;
  }

  function renderUkgForm(detail) {
    const inputs = DAY_NAMES.map(
      (day) => `
        <label class="ukg-day-field">
          <span>${day}</span>
          <input type="number" min="0" step="0.25" data-day="${day}" value="${detail.ukgHoursByDay[day] || 0}" />
        </label>`
    ).join("");
    return `
      <form class="ukg-hours-form">
        <div class="ukg-hours-title">UKG hours (from timesheet)</div>
        <div class="ukg-day-fields">${inputs}</div>
        <div class="ukg-paste-row">
          <input type="text" class="ukg-paste-input" placeholder="Paste 7 values, Mon→Sun (e.g. 8 8 8 7 9 0 0)" />
          <button type="button" class="btn btn-link ukg-fill-week">Fill week</button>
        </div>
        <button type="submit" class="btn btn-secondary">Save UKG hours</button>
        <span class="save-message ukg-message"></span>
      </form>
    `;
  }

  function wireUkgForm(detailEl, row, content) {
    const form = detailEl.querySelector(".ukg-hours-form");
    const msg = form.querySelector(".ukg-message");

    form.querySelector(".ukg-fill-week").addEventListener("click", () => {
      const raw = form.querySelector(".ukg-paste-input").value.trim();
      const values = raw.split(/[\s,]+/).filter((v) => v !== "");
      if (values.length !== 7 || values.some((v) => Number.isNaN(Number(v)))) {
        msg.textContent = "Paste exactly 7 numbers (Mon through Sun).";
        return;
      }
      const inputs = form.querySelectorAll("input[data-day]");
      inputs.forEach((input, i) => {
        input.value = values[i];
      });
      msg.textContent = "";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const hours = {};
      form.querySelectorAll("input[data-day]").forEach((input) => {
        hours[input.dataset.day] = Number(input.value) || 0;
      });
      try {
        await api.put(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/ukg-hours`, { hours });
        expanded.set(row.technician.id, await api.get(`/api/technicians/${row.technician.id}/weeks/${state.weekMonday}`));
        await drawReview(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function describeAllocation(a, locationByCode) {
    if (a.type === "timeoff") return `Time off — ${TIME_OFF_LABELS[a.timeOffType] || a.timeOffType}`;
    if (a.type === "wom") return `${a.womCode}`;
    const loc = locationByCode[a.locationCode];
    return `E&F — ${loc ? loc.name : a.locationCode}`;
  }

  function renderDetailTable(detail, locationByCode) {
    if (detail.allocations.length === 0) {
      return `<p class="empty-note">No hours allocated.</p>`;
    }
    const rows = detail.allocations
      .map((a) => `<tr><td>${a.day}</td><td>${escapeHtml(describeAllocation(a, locationByCode))}</td><td>${a.hours}h</td></tr>`)
      .join("");
    return `
      <table class="detail-table">
        <thead><tr><th>Day</th><th>Allocation</th><th>Hours</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderReviewActions(row) {
    if (row.status === "submitted") {
      return `
        <div class="review-actions">
          <button class="btn btn-primary approve-btn" data-id="${row.technician.id}">Approve</button>
          <button class="btn btn-secondary reject-btn" data-id="${row.technician.id}">Reject</button>
        </div>
      `;
    }
    if (row.status === "approved") {
      return `
        <div class="review-actions">
          <button class="btn btn-secondary unlock-btn" data-id="${row.technician.id}">Unlock for correction</button>
        </div>
      `;
    }
    return "";
  }

  function wireReviewActions(detailEl, row, content) {
    const approveBtn = detailEl.querySelector(".approve-btn");
    if (approveBtn) {
      approveBtn.addEventListener("click", async () => {
        try {
          await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/approve`);
          expanded.delete(row.technician.id);
          await drawReview(content);
        } catch (err) {
          window.alert(`Could not approve: ${err.message}`);
        }
      });
    }
    const rejectBtn = detailEl.querySelector(".reject-btn");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", async () => {
        const note = window.prompt("Reason for returning this week to the technician:", "") || "";
        try {
          await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/reject`, { note });
          expanded.delete(row.technician.id);
          await drawReview(content);
        } catch (err) {
          window.alert(`Could not reject: ${err.message}`);
        }
      });
    }
    const unlockBtn = detailEl.querySelector(".unlock-btn");
    if (unlockBtn) {
      unlockBtn.addEventListener("click", async () => {
        if (!window.confirm("Unlock this approved week for correction?")) return;
        try {
          await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/unlock`);
          expanded.delete(row.technician.id);
          await drawReview(content);
        } catch (err) {
          window.alert(`Could not unlock: ${err.message}`);
        }
      });
    }
  }

  async function drawWoms(content) {
    const [woms, locations] = await Promise.all([api.get("/api/woms"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");

    content.innerHTML = `
      <div class="review-list" id="wom-list"></div>
      <form id="add-wom-form" class="add-wom-form">
        <input name="code" placeholder="WOM code" required />
        <input name="description" placeholder="Description" required />
        <select name="locationCode"><option value="">No location</option>${locationOptions}</select>
        <input name="budgetHours" type="number" min="0" step="0.5" placeholder="Budget hrs (optional)" />
        <button type="submit" class="btn btn-primary">Add WOM</button>
        <span class="save-message" id="wom-message"></span>
      </form>
    `;

    const list = content.querySelector("#wom-list");
    for (const w of woms) {
      list.appendChild(await renderWomRow(w, content, locationByCode));
    }

    content.querySelector("#add-wom-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = content.querySelector("#wom-message");
      try {
        await api.post("/api/woms", {
          code: form.code.value.trim(),
          description: form.description.value.trim(),
          locationCode: form.locationCode.value || null,
          budgetHours: form.budgetHours.value === "" ? null : Number(form.budgetHours.value),
        });
        await drawWoms(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  async function renderWomRow(w, content, locationByCode) {
    const el = document.createElement("div");
    el.className = "review-row";
    const loc = locationByCode[w.locationCode];
    const budgetLabel = w.budgetHours == null ? "" : ` &middot; ${w.remainingHours}h left of ${w.budgetHours}h`;
    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(w.code)} <span class="wom-desc">${escapeHtml(w.description)}${loc ? ` &middot; ${escapeHtml(loc.name)}` : ""}${budgetLabel}</span></div>
        <span class="badge badge-${w.status === "open" ? "approved" : "rejected"}">${w.status}</span>
        <button class="btn btn-link toggle-wom" type="button">${w.status === "open" ? "Close" : "Reopen"}</button>
        <button class="btn btn-link expand-btn" type="button">${womsExpanded.has(w.code) ? "Hide" : "Documents"}</button>
      </div>
      <div class="review-row-detail"></div>
    `;

    el.querySelector(".toggle-wom").addEventListener("click", async () => {
      const nextStatus = w.status === "open" ? "closed" : "open";
      try {
        await api.patch(`/api/woms/${encodeURIComponent(w.code)}`, { status: nextStatus });
        await drawWoms(content);
      } catch (err) {
        window.alert(`Could not update ${w.code}: ${err.message}`);
      }
    });

    el.querySelector(".expand-btn").addEventListener("click", async () => {
      if (womsExpanded.has(w.code)) womsExpanded.delete(w.code);
      else womsExpanded.add(w.code);
      await drawWoms(content);
    });

    if (womsExpanded.has(w.code)) {
      await renderAttachments(el.querySelector(".review-row-detail"), {
        title: "Documents & Photos",
        relatedType: "wom",
        relatedId: w.code,
        categories: [{ value: "wom_doc", label: "Document / Photo" }],
        canUpload: true,
        emptyText: "No documents attached yet.",
      });
    }

    return el;
  }

  async function drawAudit(content) {
    const entries = await api.get("/api/audit");
    content.innerHTML = `
      <table class="detail-table audit-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          ${entries
            .map(
              (e) => `
            <tr>
              <td>${new Date(e.timestamp).toLocaleString()}</td>
              <td>${escapeHtml(e.actor)}</td>
              <td>${escapeHtml(e.action)}</td>
              <td>${escapeHtml(e.details)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
  }
}
