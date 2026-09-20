import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { shiftWeek, weekRangeLabel, DAY_NAMES } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";
import { renderTechniciansTab } from "./technicianProfile.js";
import { renderTechWeek } from "./techWeek.js";
import { renderWomPhotoPrompt } from "./womPhotoPrompt.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

const TIME_OFF_LABELS = { vacation: "Vacation", sick: "Sick", bereavement: "Bereavement", holiday: "Holiday" };

function round2(n) {
  return Math.round(n * 100) / 100;
}

function currentMonthISO() {
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
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export async function renderAdminReview(container) {
  let activeTab = "review";
  let allocTechId = null;
  const expanded = new Map(); // techId -> detail payload
  const womsExpanded = new Set();
  const justSavedUkg = new Set(); // techId -> UKG hours were just saved, show a confirmation
  const photoPromptFor = new Map(); // techId -> WOM codes worked, shown right after confirming "entered in UKG"
  let laborReportMonth = currentMonthISO();

  draw();

  async function draw() {
    container.innerHTML = `
      <div class="tabs">
        <button class="tab ${activeTab === "techalloc" ? "active" : ""}" data-tab="techalloc">Tech Allocation</button>
        <button class="tab ${activeTab === "overview" ? "active" : ""}" data-tab="overview">Overview</button>
        <button class="tab ${activeTab === "review" ? "active" : ""}" data-tab="review">Weekly Review</button>
        <button class="tab ${activeTab === "woms" ? "active" : ""}" data-tab="woms">WOM Status</button>
        <button class="tab ${activeTab === "technicians" ? "active" : ""}" data-tab="technicians">Technicians</button>
        <button class="tab ${activeTab === "laborreports" ? "active" : ""}" data-tab="laborreports">Labor Reports</button>
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
    else if (activeTab === "overview") await drawOverview(content);
    else if (activeTab === "review") await drawReview(content);
    else if (activeTab === "woms") await drawWoms(content);
    else if (activeTab === "technicians") renderTechniciansTab(content);
    else if (activeTab === "laborreports") await drawLaborReports(content);
    else await drawAudit(content);
  }

  async function drawLaborReports(content) {
    content.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-month">&larr; Prev</button>
        <div class="week-range">${monthLabel(laborReportMonth)}</div>
        <button class="btn btn-ghost" id="next-month">Next &rarr;</button>
      </div>
      <p class="review-checklist-hint">
        Save the monthly labor report you get from finance here, month by month, so it's kept
        alongside the timesheeting for that period -- for comparing side by side against what
        this app tracked.
      </p>
      <div id="labor-report-attachments"></div>
    `;

    content.querySelector("#prev-month").addEventListener("click", () => {
      laborReportMonth = shiftMonth(laborReportMonth, -1);
      draw();
    });
    content.querySelector("#next-month").addEventListener("click", () => {
      laborReportMonth = shiftMonth(laborReportMonth, 1);
      draw();
    });

    await renderAttachments(content.querySelector("#labor-report-attachments"), {
      title: "Labor Report Files",
      relatedType: "labor_report",
      relatedId: laborReportMonth,
      categories: [{ value: "labor_report", label: "Labor Report" }],
      canUpload: true,
      emptyText: "No labor report saved for this month yet.",
    });
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

  async function drawOverview(content) {
    const [rows, locations] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    const sorted = [...rows].sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return b.otNotOnWom - a.otNotOnWom;
    });

    content.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>
      <p class="overview-hint">
        Every technician's week at a glance, for RFM/admin review. A row is flagged when more than
        3 overtime hours in the week aren't charged to any WOM project — i.e. overtime that isn't
        explained by a specific job.
      </p>
      <table class="detail-table overview-table">
        <thead>
          <tr>
            <th>Employee</th><th>Location</th><th>Status</th><th>Total (UKG)</th><th>+/- 40</th>
            <th>Regular</th><th>OT</th><th>OT on WOM</th><th>OT not on WOM</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${
            sorted.length === 0
              ? `<tr><td colspan="10" class="empty-note">No technicians yet.</td></tr>`
              : sorted
                  .map((row) => {
                    const loc = locationByCode[row.technician.homeLocationCode];
                    const delta = round2(row.ukgHours - 40);
                    return `
                      <tr class="${row.flagged ? "overview-row-flagged" : ""}">
                        <td>${escapeHtml(row.technician.name)}</td>
                        <td>${loc ? escapeHtml(loc.name) : "—"}</td>
                        <td><span class="badge badge-${row.status}">${STATUS_LABELS[row.status]}</span></td>
                        <td>${row.ukgHours}h</td>
                        <td class="${delta > 0 ? "warn" : ""}">${delta > 0 ? "+" : ""}${delta}</td>
                        <td>${row.regularHours}</td>
                        <td>${row.otHours}</td>
                        <td>${row.otOnWom}</td>
                        <td class="${row.flagged ? "danger" : ""}">${row.otNotOnWom}</td>
                        <td>
                          ${row.flagged ? `<span class="rfm-flag">Flag for RFM</span>` : ""}
                          <button class="btn btn-link overview-view-btn" type="button" data-tech="${escapeHtml(row.technician.id)}">View</button>
                        </td>
                      </tr>
                    `;
                  })
                  .join("")
          }
        </tbody>
      </table>
    `;

    content.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      draw();
    });
    content.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      draw();
    });
    content.querySelectorAll(".overview-view-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const techId = btn.dataset.tech;
        const detail = await api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`);
        expanded.set(techId, detail);
        activeTab = "review";
        await draw();
      });
    });
  }

  async function drawReview(content) {
    const [rows, locations] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    const needsAttention = rows.filter((r) => !r.ukgConfirmedAt);
    const completed = rows.filter((r) => r.ukgConfirmedAt);

    content.innerHTML = `
      <div class="week-nav">
        <button class="btn btn-ghost" id="prev-week">&larr; Prev</button>
        <div class="week-range">${weekRangeLabel(state.weekMonday)}</div>
        <button class="btn btn-ghost" id="next-week">Next &rarr;</button>
      </div>
      <p class="review-checklist-hint">
        Three steps per technician: <strong>1. UKG hours entered</strong>, <strong>2. Time allocated</strong>
        (matches UKG), <strong>3. Entered in UKG</strong> -- your own confirmation once you've put it into the
        real UKG system. Marking step 3 moves them to Completed below.
      </p>
      <div class="review-section-title">Needs Attention (${needsAttention.length})</div>
      <div class="review-list" id="review-list-open"></div>
      <div class="review-section-title">Completed (${completed.length})</div>
      <div class="review-list" id="review-list-done"></div>
    `;

    content.querySelector("#prev-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, -1);
      justSavedUkg.clear();
      draw();
    });
    content.querySelector("#next-week").addEventListener("click", () => {
      state.weekMonday = shiftWeek(state.weekMonday, 1);
      justSavedUkg.clear();
      draw();
    });

    const openList = content.querySelector("#review-list-open");
    if (needsAttention.length === 0) openList.innerHTML = `<p class="empty-note">Nothing needs attention this week.</p>`;
    for (const row of needsAttention) {
      openList.appendChild(await renderReviewRow(row, content, locationByCode));
    }

    const doneList = content.querySelector("#review-list-done");
    if (completed.length === 0) doneList.innerHTML = `<p class="empty-note">Nobody confirmed yet.</p>`;
    for (const row of completed) {
      doneList.appendChild(await renderReviewRow(row, content, locationByCode));
    }
  }

  async function renderReviewRow(row, content, locationByCode) {
    const el = document.createElement("div");
    const balanced = row.ukgHours > 0 && Math.abs(row.allocatedHours - row.ukgHours) < 0.01;
    const stage1 = row.ukgHours > 0; // UKG hours entered
    const stage2 = balanced; // allocation split matches UKG
    const stage3 = Boolean(row.ukgConfirmedAt); // admin confirmed it's in the real UKG system
    el.className = `review-row ${stage3 ? "review-row-ready" : "review-row-pending"}`;

    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(row.technician.name)}</div>
        <div class="review-steps">
          <span class="review-step ${stage1 ? "done" : ""}">1. UKG hours</span>
          <span class="review-step ${stage2 ? "done" : ""}">2. Allocated</span>
          <span class="review-step ${stage3 ? "done" : ""}">3. Entered in UKG</span>
        </div>
        <div class="review-row-hours ${balanced ? "ok" : "warn"}">${row.allocatedHours}h / ${row.ukgHours}h UKG</div>
        <span class="badge badge-${row.status}">${STATUS_LABELS[row.status]}</span>
        <button
          class="btn ${stage3 ? "btn-secondary" : "btn-primary"} confirm-ukg-btn"
          type="button"
          ${
            !stage3 && !(stage1 && stage2)
              ? `disabled title="Enter UKG hours and match the allocation first"`
              : stage3
              ? `title="Only un-checks your own \\"entered in UKG\\" confirmation -- doesn't change the week's submitted/approved status"`
              : ""
          }
        >${stage3 ? "Undo" : "Mark entered in UKG"}</button>
        <button class="btn btn-link expand-btn" type="button">${expanded.has(row.technician.id) ? "Hide" : "Details"}</button>
      </div>
      <div class="wom-photo-prompt-host" id="photo-prompt-${row.technician.id}"></div>
      <div class="review-row-detail" id="detail-${row.technician.id}"></div>
    `;

    if (photoPromptFor.has(row.technician.id)) {
      el.querySelector(".wom-photo-prompt-host").appendChild(
        renderWomPhotoPrompt(photoPromptFor.get(row.technician.id), () => {
          photoPromptFor.delete(row.technician.id);
          drawReview(content);
        })
      );
    }

    el.querySelector(".confirm-ukg-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const confirming = !stage3;
        await api.patch(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/ukg-confirmed`, { confirmed: confirming });
        // Collapse the detail panel on the way in/out of Completed -- that
        // list should default to just the summary row, not the full form.
        expanded.delete(row.technician.id);

        if (confirming) {
          const detail = await api.get(`/api/technicians/${row.technician.id}/weeks/${state.weekMonday}`);
          const womCodes = [...new Set(detail.allocations.filter((a) => a.type === "wom" && a.hours > 0).map((a) => a.womCode))];
          if (womCodes.length > 0) photoPromptFor.set(row.technician.id, womCodes);
        } else {
          photoPromptFor.delete(row.technician.id);
        }

        await drawReview(content);
      } catch (err) {
        btn.disabled = false;
        window.alert(`Could not update: ${err.message}`);
      }
    });

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
        renderUkgForm(detail, justSavedUkg.has(row.technician.id)) +
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

  function hoursToClock(totalHours) {
    let h = Math.floor(totalHours);
    let m = Math.round((totalHours - h) * 60);
    if (m === 60) {
      h += 1;
      m = 0;
    }
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  function renderUkgForm(detail, justSaved) {
    const inputs = DAY_NAMES.map((day) => {
      const pending = Boolean(detail.pendingPunchByDay && detail.pendingPunchByDay[day]);
      return `
        <label class="ukg-day-field ${pending ? "ukg-day-field-pending" : ""}">
          <span>${day}</span>
          <input type="number" min="0" step="0.25" data-day="${day}" value="${detail.ukgHoursByDay[day] || 0}" />
          <button type="button" class="btn btn-link ukg-pending-punch-btn" data-day="${day}" data-flagged="${pending}" title="Flag or clear a pending punch correction for this day">${pending ? "⚠ Pending" : "Flag punch"}</button>
        </label>`;
    }).join("");
    const total = round2(DAY_NAMES.reduce((s, d) => s + Number(detail.ukgHoursByDay[d] || 0), 0));
    return `
      <form class="ukg-hours-form">
        <div class="ukg-hours-title">UKG hours (from timesheet)</div>
        <div class="ukg-day-fields">
          ${inputs}
          <div class="ukg-day-field ukg-total-field">
            <span>Total</span>
            <div class="ukg-total-value">
              <strong class="ukg-total-decimal">${total}</strong>
              <span class="ukg-total-clock">${hoursToClock(total)}</span>
            </div>
          </div>
        </div>
        <div class="ukg-paste-row">
          <input type="text" class="ukg-paste-input" placeholder="Paste 7 values, Mon→Sun (e.g. 8 8 8 7 9 0 0)" />
          <button type="button" class="btn btn-link ukg-fill-week">Fill week</button>
        </div>
        <button type="submit" class="btn btn-secondary">Save UKG hours</button>
        <span class="save-message ukg-message ${justSaved ? "ukg-saved-confirmation" : ""}">${justSaved ? "✓ Saved" : ""}</span>
      </form>
    `;
  }

  function wireUkgForm(detailEl, row, content) {
    const form = detailEl.querySelector(".ukg-hours-form");
    const msg = form.querySelector(".ukg-message");

    function updateTotal() {
      const total = round2(
        [...form.querySelectorAll("input[data-day]")].reduce((s, input) => s + (Number(input.value) || 0), 0)
      );
      form.querySelector(".ukg-total-decimal").textContent = total;
      form.querySelector(".ukg-total-clock").textContent = hoursToClock(total);
    }

    form.querySelectorAll("input[data-day]").forEach((input) => {
      input.addEventListener("input", () => {
        justSavedUkg.delete(row.technician.id);
        updateTotal();
      });
    });

    form.querySelectorAll(".ukg-pending-punch-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const day = btn.dataset.day;
        const flagged = btn.dataset.flagged !== "true";
        btn.disabled = true;
        try {
          await api.patch(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/pending-punch`, { day, flagged });
          expanded.set(row.technician.id, await api.get(`/api/technicians/${row.technician.id}/weeks/${state.weekMonday}`));
          await drawReview(content);
        } catch (err) {
          btn.disabled = false;
          window.alert(`Could not update: ${err.message}`);
        }
      });
    });

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
      justSavedUkg.delete(row.technician.id);
      msg.textContent = "";
      msg.className = "save-message ukg-message";
      updateTotal();
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
        justSavedUkg.add(row.technician.id);
        await drawReview(content);
      } catch (err) {
        justSavedUkg.delete(row.technician.id);
        msg.textContent = err.message;
        msg.className = "save-message ukg-message";
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
