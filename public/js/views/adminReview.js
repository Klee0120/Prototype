import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { shiftWeek, weekRangeLabel } from "../weekUtil.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

export async function renderAdminReview(container) {
  let activeTab = "review";
  const expanded = new Map(); // techId -> detail payload

  draw();

  async function draw() {
    container.innerHTML = `
      <div class="tabs">
        <button class="tab ${activeTab === "review" ? "active" : ""}" data-tab="review">Weekly Review</button>
        <button class="tab ${activeTab === "woms" ? "active" : ""}" data-tab="woms">WOM Status</button>
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
    if (activeTab === "review") await drawReview(content);
    else if (activeTab === "woms") await drawWoms(content);
    else await drawAudit(content);
  }

  async function drawReview(content) {
    const rows = await api.get(`/api/admin/weeks/${state.weekMonday}`);

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
      list.appendChild(await renderReviewRow(row, content));
    }
  }

  async function renderReviewRow(row, content) {
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
      detailEl.innerHTML = renderDetailTable(detail) + renderReviewActions(row);
      wireReviewActions(detailEl, row, content);
    }

    return el;
  }

  function renderDetailTable(detail) {
    if (detail.allocations.length === 0) {
      return `<p class="empty-note">No hours allocated.</p>`;
    }
    const rows = detail.allocations
      .map((a) => `<tr><td>${a.day}</td><td>${escapeHtml(a.womCode)}</td><td>${a.hours}h</td></tr>`)
      .join("");
    return `
      <table class="detail-table">
        <thead><tr><th>Day</th><th>WOM</th><th>Hours</th></tr></thead>
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
        await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/approve`);
        expanded.delete(row.technician.id);
        await drawReview(content);
      });
    }
    const rejectBtn = detailEl.querySelector(".reject-btn");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", async () => {
        const note = window.prompt("Reason for returning this week to the technician:", "") || "";
        await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/reject`, { note });
        expanded.delete(row.technician.id);
        await drawReview(content);
      });
    }
    const unlockBtn = detailEl.querySelector(".unlock-btn");
    if (unlockBtn) {
      unlockBtn.addEventListener("click", async () => {
        if (!window.confirm("Unlock this approved week for correction?")) return;
        await api.post(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/unlock`);
        expanded.delete(row.technician.id);
        await drawReview(content);
      });
    }
  }

  async function drawWoms(content) {
    const woms = await api.get("/api/woms");
    content.innerHTML = `
      <table class="detail-table wom-table">
        <thead><tr><th>Code</th><th>Description</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${woms
            .map(
              (w) => `
            <tr>
              <td>${escapeHtml(w.code)}</td>
              <td>${escapeHtml(w.description)}</td>
              <td><span class="badge badge-${w.status === "open" ? "approved" : "rejected"}">${w.status}</span></td>
              <td><button class="btn btn-link toggle-wom" data-code="${escapeHtml(w.code)}" data-status="${w.status}">${w.status === "open" ? "Close" : "Reopen"}</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <form id="add-wom-form" class="add-wom-form">
        <input name="code" placeholder="WOM code" required />
        <input name="description" placeholder="Description" required />
        <button type="submit" class="btn btn-primary">Add WOM</button>
        <span class="save-message" id="wom-message"></span>
      </form>
    `;

    content.querySelectorAll(".toggle-wom").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextStatus = btn.dataset.status === "open" ? "closed" : "open";
        await api.patch(`/api/woms/${encodeURIComponent(btn.dataset.code)}`, { status: nextStatus });
        await drawWoms(content);
      });
    });

    content.querySelector("#add-wom-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = content.querySelector("#wom-message");
      try {
        await api.post("/api/woms", { code: form.code.value.trim(), description: form.description.value.trim() });
        await drawWoms(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
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
