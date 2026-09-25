import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";

// The one reusable task board both the admin Priorities section and the
// technician My Work tab mount -- role-based and employee-based views come
// from state.user.role and the server's own scoping (see rolesForViewer in
// server/routes/tasks.js), not from separate hard-coded pages per employee.

const VIEW_LABELS = {
  my: "My Work",
  team: "Team Work",
  unassigned: "Unassigned",
  overdue: "Overdue",
  waiting: "Waiting",
  exceptions: "Workflow Exceptions",
  recurring: "Recurring Tasks",
  completed: "Completed",
};
const ADMIN_VIEWS = ["my", "team", "unassigned", "overdue", "waiting", "exceptions", "recurring", "completed"];
const TECH_VIEWS = ["my", "team", "waiting", "overdue", "completed"];

const PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const STATUS_LABELS = { open: "Open", in_progress: "In Progress", waiting: "Waiting", completed: "Completed", cancelled: "Cancelled" };
const CATEGORY_LABELS = { manual: "Manual", wom_workflow: "WOM Workflow", financial: "Financial", recurring: "Recurring" };
// Reuses the same badge color classes the rest of the app already uses for
// status pills, rather than inventing a second palette just for urgency.
const URGENCY_BADGE_CLASS = { urgent: "rejected", high: "submitted", normal: "draft", low: "draft", done: "approved" };

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export async function renderTaskBoard(container) {
  const isAdmin = state.user.role === "admin";
  let view = "my";
  let filters = { assignedTo: "", role: "", location: "", wom: "", vendor: "", category: "", dueDate: "", status: "" };
  let showNewForm = false;
  let staffCache = null;

  await draw();

  async function loadStaff() {
    if (staffCache || !isAdmin) return staffCache;
    const [technicians, admins, locations, vendors] = await Promise.all([
      api.get("/api/admin/technicians"),
      api.get("/api/admin/admins"),
      api.get("/api/locations"),
      api.get("/api/admin/vendors"),
    ]);
    staffCache = { technicians: technicians.filter((t) => t.employmentStatus === "active"), admins, locations, vendors };
    return staffCache;
  }

  function queryString() {
    const params = new URLSearchParams();
    params.set("view", view);
    if (isAdmin) {
      if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
      if (filters.role) params.set("role", filters.role);
      if (filters.location) params.set("location", filters.location);
      if (filters.wom) params.set("wom", filters.wom);
      if (filters.vendor) params.set("vendor", filters.vendor);
      if (filters.category) params.set("category", filters.category);
      if (filters.dueDate) params.set("dueDate", filters.dueDate);
      if (filters.status) params.set("status", filters.status);
    }
    return params.toString();
  }

  async function draw() {
    const views = isAdmin ? ADMIN_VIEWS : TECH_VIEWS;
    if (!views.includes(view)) view = "my";

    const [summary, tasks] = await Promise.all([api.get("/api/tasks/summary"), api.get(`/api/tasks?${queryString()}`)]);

    container.innerHTML = `
      <p class="review-checklist-hint">
        Work generated automatically from WOM status changes and recurring responsibilities, plus anything added by hand.
      </p>
      <div class="task-tiles">
        ${renderTile("Due Today", summary.dueToday, null)}
        ${renderTile("Overdue", summary.overdue, "overdue")}
        ${renderTile("High Priority", summary.highPriority, null)}
        ${renderTile("Waiting", summary.waiting, "waiting")}
        ${renderTile("Recurring", summary.recurring, isAdmin ? "recurring" : null)}
        ${renderTile("Workflow Exceptions", summary.exceptions, isAdmin ? "exceptions" : null)}
      </div>
      <div class="tabs task-view-tabs">
        ${views.map((v) => `<button class="tab ${view === v ? "active" : ""}" data-view="${v}">${VIEW_LABELS[v]}</button>`).join("")}
      </div>
      ${isAdmin ? `<div id="task-filters"></div>` : ""}
      <div class="review-actions">
        <button class="btn btn-secondary task-new-btn" type="button">${showNewForm ? "Cancel" : "+ New Task"}</button>
      </div>
      <div id="task-new-form"></div>
      <div class="review-list" id="task-list"></div>
    `;

    container.querySelectorAll(".task-tile[data-view]").forEach((el) => {
      el.addEventListener("click", () => {
        view = el.dataset.view;
        draw();
      });
    });
    container.querySelectorAll(".task-view-tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        view = btn.dataset.view;
        draw();
      });
    });
    container.querySelector(".task-new-btn").addEventListener("click", async () => {
      showNewForm = !showNewForm;
      await renderNewForm(container.querySelector("#task-new-form"));
    });

    if (isAdmin) await renderFilters(container.querySelector("#task-filters"));
    if (showNewForm) await renderNewForm(container.querySelector("#task-new-form"));
    renderTaskList(container.querySelector("#task-list"), tasks);
  }

  function renderTile(label, count, targetView) {
    return `
      <div class="task-tile ${targetView ? "task-tile-clickable" : ""}" ${targetView ? `data-view="${targetView}"` : ""}>
        <div class="task-tile-count">${count}</div>
        <div class="task-tile-label">${label}</div>
      </div>
    `;
  }

  async function renderFilters(host) {
    const staff = await loadStaff();
    const people = [...staff.technicians, ...staff.admins];
    host.innerHTML = `
      <div class="add-wom-form task-filters-form">
        <select class="task-filter-assignee">
          <option value="">Everyone</option>
          ${people.map((p) => `<option value="${escapeHtml(p.id)}" ${filters.assignedTo === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="task-filter-role">
          <option value="">Any role</option>
          ${["admin", "reviewer", "financial", "tech"].map((r) => `<option value="${r}" ${filters.role === r ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <select class="task-filter-location">
          <option value="">Any location</option>
          ${staff.locations.map((l) => `<option value="${escapeHtml(l.code)}" ${filters.location === l.code ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}
        </select>
        <input class="task-filter-wom" type="text" placeholder="WOM #" value="${escapeHtml(filters.wom)}" />
        <select class="task-filter-vendor">
          <option value="">Any vendor</option>
          ${staff.vendors.map((v) => `<option value="${v.id}" ${String(filters.vendor) === String(v.id) ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}
        </select>
        <select class="task-filter-category">
          <option value="">Any category</option>
          ${Object.entries(CATEGORY_LABELS).map(([k, l]) => `<option value="${k}" ${filters.category === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input class="task-filter-due" type="date" value="${escapeHtml(filters.dueDate)}" />
        <select class="task-filter-status">
          <option value="">Any status</option>
          ${Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${filters.status === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn btn-link task-filter-clear" type="button">Clear filters</button>
      </div>
    `;
    const bind = (selector, key) =>
      host.querySelector(selector).addEventListener("change", (e) => {
        filters[key] = e.target.value.trim ? e.target.value.trim() : e.target.value;
        draw();
      });
    bind(".task-filter-assignee", "assignedTo");
    bind(".task-filter-role", "role");
    bind(".task-filter-location", "location");
    bind(".task-filter-wom", "wom");
    bind(".task-filter-vendor", "vendor");
    bind(".task-filter-category", "category");
    bind(".task-filter-due", "dueDate");
    bind(".task-filter-status", "status");
    host.querySelector(".task-filter-clear").addEventListener("click", () => {
      filters = { assignedTo: "", role: "", location: "", wom: "", vendor: "", category: "", dueDate: "", status: "" };
      draw();
    });
  }

  async function renderNewForm(host) {
    if (!showNewForm) {
      host.innerHTML = "";
      return;
    }
    const staff = isAdmin ? await loadStaff() : null;
    const people = staff ? [...staff.technicians, ...staff.admins] : [];
    host.innerHTML = `
      <div class="add-wom-form task-new-form">
        <input class="task-new-title" type="text" placeholder="Title" />
        <input class="task-new-desc" type="text" placeholder="Description (optional)" />
        <select class="task-new-priority">
          ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === "normal" ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input class="task-new-due" type="date" />
        <input class="task-new-wom" type="text" placeholder="Related WOM # (optional)" />
        ${
          isAdmin
            ? `
          <select class="task-new-assignee">
            <option value="">Unassigned</option>
            ${people.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <select class="task-new-role">
            <option value="">No role queue</option>
            ${["admin", "reviewer", "financial", "tech"].map((r) => `<option value="${r}">${r}</option>`).join("")}
          </select>
        `
            : ""
        }
        <button class="btn btn-primary task-new-save" type="button">Create task</button>
      </div>
      <div class="task-new-error"></div>
    `;
    host.querySelector(".task-new-save").addEventListener("click", async () => {
      const title = host.querySelector(".task-new-title").value.trim();
      if (!title) {
        host.querySelector(".task-new-error").innerHTML = `<p class="attachments-error">Title is required.</p>`;
        return;
      }
      const body = {
        title,
        description: host.querySelector(".task-new-desc").value.trim(),
        priority: host.querySelector(".task-new-priority").value,
        dueAt: host.querySelector(".task-new-due").value || null,
        relatedWomCode: host.querySelector(".task-new-wom").value.trim() || null,
      };
      if (isAdmin) {
        body.assignedTo = host.querySelector(".task-new-assignee").value || null;
        body.assignedRole = host.querySelector(".task-new-role").value || null;
      }
      try {
        await api.post("/api/tasks", body);
        showNewForm = false;
        await draw();
      } catch (err) {
        host.querySelector(".task-new-error").innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  function renderTaskList(host, tasks) {
    if (tasks.length === 0) {
      host.innerHTML = `<p class="empty-note">Nothing here.</p>`;
      return;
    }
    host.innerHTML = "";
    tasks.forEach((t) => host.appendChild(renderTaskCard(t)));
  }

  function renderTaskCard(t) {
    const row = document.createElement("div");
    row.className = "review-row task-card";
    const contextBits = [];
    if (t.relatedWomCode) contextBits.push(`WOM ${escapeHtml(t.relatedWomCode)}${t.relatedWomDescription ? ` — ${escapeHtml(t.relatedWomDescription)}` : ""}`);
    if (t.relatedVendorName) contextBits.push(escapeHtml(t.relatedVendorName));
    if (t.relatedLocationName) contextBits.push(escapeHtml(t.relatedLocationName));
    const assignee = t.assignedToName || (t.assignedRole ? `${t.assignedRole} queue` : "Unassigned");
    const badgeLabel = t.urgency === "done" ? STATUS_LABELS[t.status] : PRIORITY_LABELS[t.priority];

    row.innerHTML = `
      <div class="review-row-summary">
        <span class="review-row-name">
          ${escapeHtml(t.title)}${contextBits.length ? `<span class="wom-desc"> — ${contextBits.join(" · ")}</span>` : ""}
        </span>
        <span class="badge badge-${URGENCY_BADGE_CLASS[t.urgency] || "draft"}">${escapeHtml(badgeLabel)}</span>
        <span class="task-card-meta">${escapeHtml(assignee)} &middot; due ${formatDate(t.dueAt)} &middot; ${t.ageDays}d old</span>
        <button class="btn btn-link task-detail-toggle" type="button">Details</button>
      </div>
      <div class="review-row-detail task-card-detail" hidden></div>
    `;
    const toggleBtn = row.querySelector(".task-detail-toggle");
    const detail = row.querySelector(".task-card-detail");
    toggleBtn.addEventListener("click", async () => {
      detail.hidden = !detail.hidden;
      toggleBtn.textContent = detail.hidden ? "Details" : "Hide";
      if (!detail.hidden) await renderDetail(detail, t.id);
    });
    return row;
  }

  async function renderDetail(host, taskId) {
    host.innerHTML = `<p class="review-checklist-hint">Loading…</p>`;
    const t = await api.get(`/api/tasks/${taskId}`);
    const why = t.workflowRule
      ? `Generated by workflow rule "${escapeHtml(t.workflowRule)}" (${escapeHtml(t.source)}).`
      : `Source: ${escapeHtml(t.source)}.`;
    const timeline = [
      `Created ${formatDateTime(t.createdAt)}`,
      t.startedAt ? `started ${formatDateTime(t.startedAt)}` : null,
      t.completedAt ? `completed ${formatDateTime(t.completedAt)}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    host.innerHTML = `
      ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ""}
      <p class="review-checklist-hint">${why} ${escapeHtml(timeline)}.</p>
      <div class="review-actions task-status-actions"></div>
      <div class="task-comments"></div>
      <div class="task-comment-form"></div>
    `;
    renderStatusActions(host.querySelector(".task-status-actions"), t);
    renderComments(host.querySelector(".task-comments"), t.comments);
    renderCommentForm(host.querySelector(".task-comment-form"), t.id, host);
  }

  function renderStatusActions(host, t) {
    const actions = [];
    if (!["in_progress", "completed", "cancelled"].includes(t.status)) actions.push(["in_progress", "Start"]);
    if (!["waiting", "completed", "cancelled"].includes(t.status)) actions.push(["waiting", "Waiting on someone else"]);
    if (t.status !== "completed") actions.push(["completed", "Mark complete"]);
    if (!["cancelled", "completed"].includes(t.status)) actions.push(["cancelled", "Cancel"]);

    host.innerHTML = actions.map(([s, l]) => `<button class="btn btn-secondary task-status-btn" data-status="${s}" type="button">${l}</button>`).join("");
    host.querySelectorAll(".task-status-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api.patch(`/api/tasks/${t.id}/status`, { status: btn.dataset.status });
        await draw();
      });
    });
  }

  function renderComments(host, comments) {
    if (!comments || comments.length === 0) {
      host.innerHTML = `<p class="empty-note">No comments yet.</p>`;
      return;
    }
    host.innerHTML = comments
      .map(
        (c) =>
          `<p class="task-comment"><strong>${escapeHtml(c.authorName)}:</strong> ${escapeHtml(c.body)} <span class="task-comment-time">${formatDateTime(c.createdAt)}</span></p>`
      )
      .join("");
  }

  function renderCommentForm(host, taskId, detailHost) {
    host.innerHTML = `
      <div class="task-comment-input-row">
        <input class="task-comment-input" type="text" placeholder="Add a note…" />
        <button class="btn btn-link task-comment-send" type="button">Post</button>
      </div>
    `;
    host.querySelector(".task-comment-send").addEventListener("click", async () => {
      const input = host.querySelector(".task-comment-input");
      const body = input.value.trim();
      if (!body) return;
      await api.post(`/api/tasks/${taskId}/comments`, { body });
      const t = await api.get(`/api/tasks/${taskId}`);
      renderComments(detailHost.querySelector(".task-comments"), t.comments);
      input.value = "";
    });
  }
}
