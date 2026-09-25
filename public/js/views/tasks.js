import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";

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

const PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent", emergency: "Emergency" };
const STATUS_LABELS = { open: "Open", in_progress: "In Progress", waiting: "Waiting", completed: "Completed", cancelled: "Cancelled" };
const CATEGORY_LABELS = { manual: "Manual", wom_workflow: "WOM Workflow", financial: "Financial", recurring: "Recurring" };
const ROLE_LABELS = { admin: "Admin", reviewer: "Reviewer", financial: "Financial", tech: "Technician" };
// Reuses the same badge color classes the rest of the app already uses for
// status pills, rather than inventing a second palette just for urgency.
const URGENCY_BADGE_CLASS = { emergency: "rejected", urgent: "rejected", high: "submitted", normal: "draft", low: "draft", done: "approved" };

// Which real PSE actions apply at each pse_stage -- mirrors PSE_STAGE_ACTIONS
// in adminReview.js's own PSE Tasks tab. Duplicated rather than shared
// (same pattern as this app's other per-view lookup tables) so a WOM-
// workflow task's detail panel can actually take the real action, instead
// of a generic "mark complete" that would just close the task card without
// touching the WOM's real pse_stage at all.
const PSE_STAGE_ACTIONS = {
  pse_review: [{ action: "mark_pse_produced", label: "PSE produced -- send to Toyota", role: "reviewer" }],
  awaiting_toyota_approval: [
    { action: "toyota_approved", label: "Toyota approved", role: "reviewer" },
    { action: "snooze_followup", label: "Still waiting -- follow up later", role: "reviewer" },
  ],
  generate_wom_po: [
    { action: "generated_with_po", label: "Generated -- PO in hand", role: "financial" },
    { action: "generated_missing_po", label: "Generated -- still missing Toyota PO", role: "financial" },
  ],
  awaiting_toyota_po: [
    { action: "po_received", label: "PO received", role: "reviewer" },
    { action: "snooze_followup", label: "Still waiting -- follow up later", role: "reviewer" },
  ],
  schedule_blocked: [{ action: "clear_schedule_block", label: "Clear block -- ready to schedule", role: "reviewer" }],
  check_expenses: [{ action: "send_status95", label: "Send for Status 95 approval", role: "financial" }],
  pending_status95_approval: [
    { action: "approve_status95", label: "Approve", role: "reviewer" },
    { action: "reject_status95", label: "Not sufficient -- back to Admin", role: "reviewer" },
  ],
  ready_to_invoice: [{ action: "mark_invoiced", label: "Mark invoiced", role: "financial" }],
};
const PSE_SCHEDULE_BLOCK_STAGES = ["generate_wom_po", "awaiting_toyota_po", "schedule_blocked"];
const PSE_HOLD_LABELS = { vendor_invoice: "vendor invoice", labor_allocations: "labor allocations", other: "other" };

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
  let staffCache = null;

  await draw();

  async function loadStaff() {
    if (staffCache || !isAdmin) return staffCache;
    const [technicians, admins, locations, vendors, pseTasks] = await Promise.all([
      api.get("/api/admin/technicians"),
      api.get("/api/admin/admins"),
      api.get("/api/locations"),
      api.get("/api/admin/vendors"),
      api.get("/api/woms/pse/tasks"),
    ]);
    staffCache = {
      technicians: technicians.filter((t) => t.employmentStatus === "active"),
      admins,
      locations,
      vendors,
      reviewerAdminId: pseTasks.reviewerAdminId,
    };
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
        <button class="btn btn-secondary task-new-btn" type="button">+ New Task</button>
      </div>
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
    container.querySelector(".task-new-btn").addEventListener("click", openNewTaskModal);

    if (isAdmin) await renderFilters(container.querySelector("#task-filters"));
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

  async function openNewTaskModal() {
    const staff = isAdmin ? await loadStaff() : null;
    const people = staff ? [...staff.technicians, ...staff.admins] : [];
    const { body, close } = openModal({
      title: "New Task",
      bodyHtml: `
        <div class="modal-form task-new-form">
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
              ${["admin", "reviewer", "financial", "tech"].map((r) => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join("")}
            </select>
          `
              : ""
          }
          <div class="modal-form-actions">
            <button class="btn btn-primary task-new-save" type="button">Create task</button>
          </div>
          <div class="task-new-error"></div>
        </div>
      `,
    });
    body.querySelector(".task-new-save").addEventListener("click", async () => {
      const title = body.querySelector(".task-new-title").value.trim();
      if (!title) {
        body.querySelector(".task-new-error").innerHTML = `<p class="attachments-error">Title is required.</p>`;
        return;
      }
      const newTaskBody = {
        title,
        description: body.querySelector(".task-new-desc").value.trim(),
        priority: body.querySelector(".task-new-priority").value,
        dueAt: body.querySelector(".task-new-due").value || null,
        relatedWomCode: body.querySelector(".task-new-wom").value.trim() || null,
      };
      if (isAdmin) {
        newTaskBody.assignedTo = body.querySelector(".task-new-assignee").value || null;
        newTaskBody.assignedRole = body.querySelector(".task-new-role").value || null;
      }
      try {
        await api.post("/api/tasks", newTaskBody);
        close();
        await draw();
      } catch (err) {
        body.querySelector(".task-new-error").innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
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
    row.className = `review-row task-card${t.urgency === "emergency" ? " task-card-emergency" : ""}`;
    const contextBits = [];
    if (t.relatedWomCode) contextBits.push(`WOM ${escapeHtml(t.relatedWomCode)}${t.relatedWomDescription ? ` — ${escapeHtml(t.relatedWomDescription)}` : ""}`);
    if (t.relatedVendorName) contextBits.push(escapeHtml(t.relatedVendorName));
    if (t.relatedLocationName) contextBits.push(escapeHtml(t.relatedLocationName));
    const assignee = t.assignedToName || (t.assignedRole ? `Unclaimed — ${ROLE_LABELS[t.assignedRole] || t.assignedRole}` : "Unassigned");
    const badgeLabel = t.urgency === "done" ? STATUS_LABELS[t.status] : PRIORITY_LABELS[t.priority];
    const dueLabel = t.dueAt ? `due ${formatDate(t.dueAt)}` : "no due date";
    const ageLabel = t.ageDays <= 0 ? "opened today" : `opened ${t.ageDays}d ago`;

    row.innerHTML = `
      <div class="review-row-summary">
        <span class="review-row-name">
          ${escapeHtml(t.title)}${contextBits.length ? `<span class="wom-desc"> — ${contextBits.join(" · ")}</span>` : ""}
        </span>
        <span class="badge badge-${URGENCY_BADGE_CLASS[t.urgency] || "draft"}">${escapeHtml(badgeLabel)}</span>
        <span class="task-card-meta">${escapeHtml(assignee)} &middot; ${dueLabel} &middot; ${ageLabel}</span>
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

    // A WOM-workflow task tracks a real step in the PSE pipeline -- if that
    // stage still exists and has real actions, fetch it so the panel can
    // both explain the task in plain terms and offer the actual action
    // (see renderPseActions), instead of a generic "mark complete" that
    // would close the task card without touching the WOM's real pse_stage.
    let wom = null;
    if (t.category === "wom_workflow" && t.relatedWomCode) {
      try {
        wom = await api.get(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/lookup`);
      } catch {
        wom = null;
      }
    }

    const why = wom
      ? `Part of the WOM workflow -- ${escapeHtml(t.relatedWomCode)} is currently at "${escapeHtml(wom.pseStageLabel || wom.pseStage)}."`
      : t.workflowRule
        ? `Generated automatically (${escapeHtml(t.source.replace(/_/g, " "))}).`
        : `Added by hand.`;
    const timeline = [
      `opened ${formatDateTime(t.createdAt)}`,
      t.startedAt ? `started ${formatDateTime(t.startedAt)}` : null,
      t.completedAt ? `completed ${formatDateTime(t.completedAt)}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    host.innerHTML = `
      ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ""}
      <p class="review-checklist-hint">${why} (${escapeHtml(timeline)}.)</p>
      <div class="task-pse-actions"></div>
      <div class="review-actions task-status-actions"></div>
      <div class="task-comments"></div>
      <div class="task-comment-form"></div>
    `;

    const tookOverStatus = wom && (await renderPseActions(host.querySelector(".task-pse-actions"), t, wom));
    if (!tookOverStatus) renderStatusActions(host.querySelector(".task-status-actions"), t);
    renderComments(host.querySelector(".task-comments"), t.comments);
    renderCommentForm(host.querySelector(".task-comment-form"), t.id, host);
  }

  // The real, domain-specific action for whatever PSE step this task
  // represents (e.g. "PSE produced -- send to Toyota"), not a generic
  // status change -- taking it calls the same endpoint the dedicated
  // Financials -> PSE Tasks page uses, so it actually advances the WOM.
  // Returns true when it rendered real controls (the caller then skips the
  // generic Start/Waiting/Complete/Cancel buttons); false to fall back to
  // those, for a stage (like "ready to schedule") with no PSE action of
  // its own.
  async function renderPseActions(host, t, wom) {
    const stage = wom.pseStage;
    const stageActions = PSE_STAGE_ACTIONS[stage] || [];
    const canHold = stage === "check_expenses";
    const canScheduleBlock = PSE_SCHEDULE_BLOCK_STAGES.includes(stage);
    if (stageActions.length === 0 && !canHold && !canScheduleBlock) return false;

    let reviewerAdminId = null;
    if (isAdmin) {
      const staff = await loadStaff();
      reviewerAdminId = staff.reviewerAdminId;
    }
    // No reviewer designated yet -- see Roster -> Manage admin accounts --
    // means any admin can take either role for now, same rule the PSE
    // Tasks page itself uses.
    const isReviewer = !reviewerAdminId || reviewerAdminId === state.user.id;
    const isFinancial = !reviewerAdminId || reviewerAdminId !== state.user.id;

    const buttons = stageActions
      .filter((a) => (a.role === "reviewer" ? isReviewer : isFinancial))
      .map((a) => `<button type="button" class="btn btn-secondary task-pse-action-btn" data-action="${a.action}">${escapeHtml(a.label)}</button>`)
      .join("");

    const holdControls = canHold
      ? wom.pseHoldReason
        ? `<button type="button" class="btn btn-link task-pse-hold-clear-btn">Clear hold</button>`
        : `
          <button type="button" class="btn btn-link task-pse-hold-btn" data-reason="vendor_invoice">Hold: vendor invoice</button>
          <button type="button" class="btn btn-link task-pse-hold-btn" data-reason="labor_allocations">Hold: labor allocations</button>
          <button type="button" class="btn btn-link task-pse-hold-btn" data-reason="other">Hold: other…</button>
        `
      : "";

    const scheduleBlockToggle = canScheduleBlock
      ? `<label class="pse-schedule-block-label">
          <input type="checkbox" class="task-pse-schedule-block-toggle" ${wom.pseScheduleBlock ? "checked" : ""} />
          Don't schedule until Toyota PO
        </label>`
      : "";

    if (!buttons && !holdControls && !scheduleBlockToggle) return false;

    const holdNote = wom.pseHoldReason
      ? `<p class="review-checklist-hint">On hold: ${escapeHtml(wom.pseHoldReason === "other" ? wom.pseHoldNote || "other" : PSE_HOLD_LABELS[wom.pseHoldReason])}.</p>`
      : "";
    const reviewerNote =
      isAdmin && !reviewerAdminId
        ? `<p class="review-checklist-hint">No PSE reviewer is designated yet (Roster &rarr; Manage admin accounts), so any admin can take this step.</p>`
        : "";

    host.innerHTML = `
      ${reviewerNote}
      ${holdNote}
      <div class="review-actions">${buttons}${holdControls}${scheduleBlockToggle}</div>
    `;

    host.querySelectorAll(".task-pse-action-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/pse/actions/${btn.dataset.action}`, {});
          await draw();
        } catch (err) {
          window.alert(err.message);
          btn.disabled = false;
        }
      });
    });
    host.querySelectorAll(".task-pse-hold-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reason = btn.dataset.reason;
        let note;
        if (reason === "other") {
          note = window.prompt("What's this WOM waiting on?");
          if (note == null) return;
        }
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/pse/hold`, { holdReason: reason, holdNote: note });
          await draw();
        } catch (err) {
          window.alert(err.message);
        }
      });
    });
    const clearBtn = host.querySelector(".task-pse-hold-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/pse/hold`, {});
          await draw();
        } catch (err) {
          window.alert(err.message);
        }
      });
    }
    const scheduleToggle = host.querySelector(".task-pse-schedule-block-toggle");
    if (scheduleToggle) {
      scheduleToggle.addEventListener("change", async (e) => {
        const checked = e.target.checked;
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/pse/schedule-block`, { blocked: checked });
          await draw();
        } catch (err) {
          window.alert(err.message);
          e.target.checked = !checked;
        }
      });
    }

    return true;
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
