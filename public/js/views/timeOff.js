import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

let typesCache = null;
async function loadTypes() {
  if (!typesCache) typesCache = await api.get("/api/time-off/types");
  return typesCache;
}

function typeLabel(types, value) {
  return (types.find((t) => t.value === value) || {}).label || value;
}

const STATUS_BADGE_CLASS = { pending: "submitted", approved: "approved", denied: "rejected", cancelled: "draft" };

function dateRangeLabel(r) {
  return r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}`;
}

function renderBalanceTable(balance) {
  if (balance.types.length === 0) {
    return `<p class="empty-note">${balance.policyName ? "This policy has no allowances configured yet." : "No time-off policy assigned yet -- an admin needs to set one."}</p>`;
  }
  return `
    <table class="detail-table">
      <thead><tr><th>Type</th><th>Yearly Allowance</th><th>Used</th><th>Pending</th><th>Balance</th></tr></thead>
      <tbody>
        ${balance.types
          .map(
            (t) => `
          <tr>
            <td>${escapeHtml(t.label)}</td>
            <td>${t.yearlyHours}h</td>
            <td>${t.used}h</td>
            <td>${t.pending}h</td>
            <td>${t.balance}h</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// techId fixed + no people list = the tech's own self-service form (no
// "who is this for" picker, since there's only one possible answer).
// people passed in = the admin form, with a "Request For" picker up top --
// matches PurelyHR's own "Request For: Select User" entry point -- techId
// becomes that dropdown's initial value (or the first person) rather than
// a fixed subject.
function openRequestForm({ types, techId, people, onSubmitted }) {
  const { body, close } = openModal({
    title: "Request Time Off",
    bodyHtml: `
      <form class="modal-form timeoff-request-form">
        ${
          people
            ? `<label class="profile-field">
                <span>Request For</span>
                <select name="techId">
                  ${people.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === techId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
                </select>
              </label>`
            : ""
        }
        <label class="profile-field">
          <span>Type</span>
          <select name="type">${types.map((t) => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join("")}</select>
        </label>
        <label class="profile-field">
          <span>Start date</span>
          <input type="date" name="startDate" required />
        </label>
        <label class="profile-field">
          <span>End date</span>
          <input type="date" name="endDate" required />
        </label>
        <label class="profile-field">
          <span>Hours per day</span>
          <input type="number" name="hoursPerDay" value="8" step="0.5" min="0.5" required />
        </label>
        <label class="profile-field">
          <span>Notes (optional)</span>
          <textarea name="notes"></textarea>
        </label>
        <div class="modal-form-actions"><button type="submit" class="btn btn-primary">Submit Request</button></div>
        <span class="save-message"></span>
      </form>
    `,
  });
  const form = body.querySelector(".timeoff-request-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".save-message");
    if (form.endDate.value < form.startDate.value) {
      msg.textContent = "End date must be on or after the start date.";
      return;
    }
    try {
      await api.post("/api/time-off/requests", {
        techId: people ? form.techId.value : techId,
        type: form.type.value,
        startDate: form.startDate.value,
        endDate: form.endDate.value,
        hoursPerDay: Number(form.hoursPerDay.value),
        notes: form.notes.value.trim(),
      });
      close();
      await onSubmitted();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

function renderRequestsTable(requests, types, { showTech = false, onCancel, onDecide } = {}) {
  if (requests.length === 0) return `<p class="empty-note">Nothing here yet.</p>`;
  return `
    <table class="detail-table">
      <thead>
        <tr>
          ${showTech ? "<th>Technician</th>" : ""}
          <th>Type</th><th>Dates</th><th>Hours</th><th>Status</th><th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${requests
          .map(
            (r) => `
          <tr data-id="${r.id}">
            ${showTech ? `<td>${escapeHtml(r.techName || r.techId)}</td>` : ""}
            <td>${escapeHtml(typeLabel(types, r.type))}</td>
            <td>${dateRangeLabel(r)}</td>
            <td>${r.totalHours}h</td>
            <td><span class="badge badge-${STATUS_BADGE_CLASS[r.status] || "draft"}">${escapeHtml(r.status)}</span></td>
            <td>${escapeHtml(r.notes || "—")}</td>
            <td class="timeoff-row-actions">
              ${r.status === "pending" && onCancel ? `<button type="button" class="btn btn-link danger-link timeoff-cancel-btn" data-id="${r.id}">Cancel</button>` : ""}
              ${r.status === "pending" && onDecide ? `
                <button type="button" class="btn btn-secondary timeoff-approve-btn" data-id="${r.id}">Approve</button>
                <button type="button" class="btn btn-link danger-link timeoff-deny-btn" data-id="${r.id}">Deny</button>
              ` : ""}
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function wireRequestsTable(host, { onCancel, onDecide } = {}) {
  if (onCancel) {
    host.querySelectorAll(".timeoff-cancel-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("Cancel this time-off request?")) return;
        try {
          await api.patch(`/api/time-off/requests/${btn.dataset.id}`, { status: "cancelled" });
          await onCancel();
        } catch (err) {
          window.alert(err.message);
        }
      });
    });
  }
  if (onDecide) {
    host.querySelectorAll(".timeoff-approve-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.patch(`/api/time-off/requests/${btn.dataset.id}`, { status: "approved" });
          await onDecide();
        } catch (err) {
          window.alert(err.message);
        }
      });
    });
    host.querySelectorAll(".timeoff-deny-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const decisionNote = window.prompt("Reason for denying (optional):") || "";
        try {
          await api.patch(`/api/time-off/requests/${btn.dataset.id}`, { status: "denied", decisionNote });
          await onDecide();
        } catch (err) {
          window.alert(err.message);
        }
      });
    });
  }
}

// ---- Technician-facing: My Time Off ----
export async function renderMyTimeOff(container) {
  renderLoadingState(container, loadingLabelFor("Time Off"));
  const techId = state.user.id;
  let types, balance, requests;
  try {
    [types, balance, requests] = await Promise.all([
      loadTypes(),
      api.get(`/api/time-off/balance/${techId}?year=${new Date().getFullYear()}`),
      api.get(`/api/time-off/requests?techId=${techId}`),
    ]);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-header-title">Time Off</h2>
        <p class="page-header-subtitle">${balance.policyName ? `Policy: ${escapeHtml(balance.policyName)}` : "No time-off policy assigned yet."}</p>
      </div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-primary timeoff-request-btn">+ Request Time Off</button>
      </div>
    </div>
    ${renderBalanceTable(balance)}
    <h3>My Requests</h3>
    <div class="timeoff-requests-host"></div>
  `;

  container.querySelector(".timeoff-request-btn").addEventListener("click", () => {
    openRequestForm({ types, techId, onSubmitted: () => renderMyTimeOff(container) });
  });

  const host = container.querySelector(".timeoff-requests-host");
  host.innerHTML = renderRequestsTable(requests, types, { onCancel: () => renderMyTimeOff(container) });
  wireRequestsTable(host, { onCancel: () => renderMyTimeOff(container) });
}

// ---- Admin-facing: Time Off (policies, approvals, per-person lookup) ----
let adminSubTab = "approvals";

export async function renderTimeOffAdmin(container) {
  renderLoadingState(container, loadingLabelFor("Time Off"));
  let types, technicians;
  try {
    [types, technicians] = await Promise.all([loadTypes(), api.get("/api/admin/technicians")]);
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const people = technicians.filter((t) => t.employmentStatus === "active");

  container.innerHTML = `
    <div class="page-header">
      <div class="tabs timeoff-admin-tabs">
        <button type="button" class="tab ${adminSubTab === "approvals" ? "active" : ""}" data-sub="approvals">Approvals Queue</button>
        <button type="button" class="tab ${adminSubTab === "history" ? "active" : ""}" data-sub="history">History</button>
        <button type="button" class="tab ${adminSubTab === "policies" ? "active" : ""}" data-sub="policies">Time-Off Policies</button>
        <button type="button" class="tab ${adminSubTab === "people" ? "active" : ""}" data-sub="people">By Technician</button>
      </div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-primary timeoff-admin-toplevel-request-btn">+ Request Time Off</button>
      </div>
    </div>
    <div class="timeoff-admin-body"></div>
  `;
  container.querySelectorAll(".timeoff-admin-tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      adminSubTab = btn.dataset.sub;
      renderTimeOffAdmin(container);
    });
  });
  container.querySelector(".timeoff-admin-toplevel-request-btn").addEventListener("click", () => {
    openRequestForm({ types, techId: byTechSelectedId || (people[0] && people[0].id), people, onSubmitted: () => renderTimeOffAdmin(container) });
  });

  const body = container.querySelector(".timeoff-admin-body");
  if (adminSubTab === "policies") await renderPolicies(body);
  else if (adminSubTab === "people") await renderByTechnician(body, types);
  else if (adminSubTab === "history") await renderHistory(body, types);
  else await renderApprovalsQueue(body, types, container);
}

async function renderApprovalsQueue(host, types, container) {
  host.innerHTML = `<p class="empty-note">Loading…</p>`;
  let requests;
  try {
    requests = await api.get("/api/time-off/approvals-queue");
  } catch (err) {
    host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  host.innerHTML = `
    <p class="review-checklist-hint">
      Every pending time-off request you're allowed to approve -- you're excluded from your own, even if nobody
      else is specifically configured as your approver yet.
    </p>
    <div class="timeoff-queue-host"></div>
  `;
  const queueHost = host.querySelector(".timeoff-queue-host");
  queueHost.innerHTML = renderRequestsTable(requests, types, { showTech: true, onDecide: () => renderTimeOffAdmin(container) });
  wireRequestsTable(queueHost, { onDecide: () => renderTimeOffAdmin(container) });
}

// Every approved request, company-wide -- separate from the pending-only
// Approvals Queue, and separate from "By Technician" (which requires
// picking a person first). Read-only: these are already decided.
async function renderHistory(host, types) {
  host.innerHTML = `<p class="empty-note">Loading…</p>`;
  let requests;
  try {
    requests = await api.get("/api/time-off/requests?status=approved");
  } catch (err) {
    host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  requests = [...requests].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  host.innerHTML = `<div class="timeoff-history-host"></div>`;
  host.querySelector(".timeoff-history-host").innerHTML = renderRequestsTable(requests, types, { showTech: true });
}

async function renderPolicies(host) {
  host.innerHTML = `<p class="empty-note">Loading…</p>`;
  let policies, types;
  try {
    [policies, types] = await Promise.all([api.get("/api/time-off/policies"), loadTypes()]);
  } catch (err) {
    host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  host.innerHTML = `
    <div class="page-header">
      <div></div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-primary timeoff-add-policy-btn">+ Add Policy</button>
      </div>
    </div>
    <div class="timeoff-policies-host"></div>
  `;
  host.querySelector(".timeoff-add-policy-btn").addEventListener("click", () => openPolicyForm(types, null, () => renderPolicies(host)));

  const list = host.querySelector(".timeoff-policies-host");
  if (policies.length === 0) {
    list.innerHTML = `<p class="empty-note">No time-off policies yet.</p>`;
    return;
  }
  list.innerHTML = `
    <table class="detail-table">
      <thead><tr><th>Name</th><th>Allowances</th><th></th></tr></thead>
      <tbody>
        ${policies
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${escapeHtml(p.name)}</td>
            <td>${p.allowances.map((a) => `${escapeHtml(typeLabel(types, a.type))}: ${a.yearlyHours}h`).join(" &middot; ") || "—"}</td>
            <td class="timeoff-row-actions">
              <button type="button" class="btn btn-secondary timeoff-edit-policy-btn" data-id="${p.id}">Edit</button>
              <button type="button" class="btn btn-link danger-link timeoff-delete-policy-btn" data-id="${p.id}">Delete</button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
  list.querySelectorAll(".timeoff-edit-policy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const policy = policies.find((p) => String(p.id) === btn.dataset.id);
      openPolicyForm(types, policy, () => renderPolicies(host));
    });
  });
  list.querySelectorAll(".timeoff-delete-policy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const policy = policies.find((p) => String(p.id) === btn.dataset.id);
      if (!window.confirm(`Delete the "${policy.name}" policy? Anyone currently assigned to it will show "no policy assigned" instead.`)) return;
      try {
        await api.delete(`/api/time-off/policies/${policy.id}`);
        await renderPolicies(host);
      } catch (err) {
        window.alert(err.message);
      }
    });
  });
}

function openPolicyForm(types, existing, onSaved) {
  const isEdit = Boolean(existing);
  const allowanceByType = new Map((existing?.allowances || []).map((a) => [a.type, a.yearlyHours]));
  const { body, close } = openModal({
    title: isEdit ? `Edit "${existing.name}"` : "Add Time-Off Policy",
    bodyHtml: `
      <form class="modal-form timeoff-policy-form">
        <label class="profile-field">
          <span>Name</span>
          <input name="name" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. 2yr Policy, New Hire" required />
        </label>
        <p class="review-checklist-hint">Yearly hours per time-off type -- leave a type blank to not offer it under this policy.</p>
        ${types
          .map(
            (t) => `
          <label class="profile-field">
            <span>${escapeHtml(t.label)}</span>
            <input type="number" step="0.5" min="0" name="type_${t.value}" value="${allowanceByType.has(t.value) ? allowanceByType.get(t.value) : ""}" placeholder="e.g. 80" />
          </label>
        `
          )
          .join("")}
        <div class="modal-form-actions"><button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add Policy"}</button></div>
        <span class="save-message"></span>
      </form>
    `,
  });
  const form = body.querySelector(".timeoff-policy-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".save-message");
    const allowances = types
      .map((t) => ({ type: t.value, yearlyHours: form[`type_${t.value}`].value }))
      .filter((a) => a.yearlyHours !== "")
      .map((a) => ({ type: a.type, yearlyHours: Number(a.yearlyHours) }));
    try {
      const payload = { name: form.name.value.trim(), allowances };
      if (isEdit) await api.patch(`/api/time-off/policies/${existing.id}`, payload);
      else await api.post("/api/time-off/policies", payload);
      close();
      await onSaved();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

let byTechSelectedId = null;

async function renderByTechnician(host, types) {
  host.innerHTML = `<p class="empty-note">Loading…</p>`;
  let technicians, policies, admins;
  try {
    [technicians, policies, admins] = await Promise.all([
      api.get("/api/admin/technicians"),
      api.get("/api/time-off/policies"),
      api.get("/api/admin/admins"),
    ]);
  } catch (err) {
    host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const people = technicians.filter((t) => t.employmentStatus === "active");
  if (!byTechSelectedId && people.length > 0) byTechSelectedId = people[0].id;

  host.innerHTML = `
    <label class="profile-field timeoff-person-select">
      <span>Technician</span>
      <select class="timeoff-person-picker">
        ${people.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === byTechSelectedId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
      </select>
    </label>
    <div class="timeoff-person-detail"></div>
  `;
  host.querySelector(".timeoff-person-picker").addEventListener("change", (e) => {
    byTechSelectedId = e.target.value;
    renderByTechnician(host, types);
  });

  if (!byTechSelectedId) return;
  await renderPersonDetail(host.querySelector(".timeoff-person-detail"), byTechSelectedId, { types, policies, admins, host });
}

async function renderPersonDetail(detailHost, techId, { types, policies, admins, host }) {
  detailHost.innerHTML = `<p class="empty-note">Loading…</p>`;
  let balance, requests, approvers;
  try {
    [balance, requests, approvers] = await Promise.all([
      api.get(`/api/time-off/balance/${techId}?year=${new Date().getFullYear()}`),
      api.get(`/api/time-off/requests?techId=${techId}`),
      api.get(`/api/time-off/approvers/${techId}`),
    ]);
  } catch (err) {
    detailHost.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const approverIds = new Set(approvers.map((a) => a.id));

  detailHost.innerHTML = `
    <div class="page-header">
      <div class="profile-field timeoff-policy-assign">
        <span>Time-off policy</span>
        <select class="timeoff-policy-select">
          <option value="">No policy</option>
          ${policies.map((p) => `<option value="${p.id}" ${balance.policyId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-primary timeoff-admin-request-btn">+ Request Time Off</button>
      </div>
    </div>
    ${renderBalanceTable(balance)}
    <div class="timeoff-approvers-assign">
      <span>Who can approve this person's requests</span>
      <p class="review-checklist-hint">If nobody's checked below, any active admin may approve -- check specific admins to limit it.</p>
      ${admins
        .filter((a) => a.id !== techId)
        .map(
          (a) => `
        <label class="timeoff-approver-option">
          <input type="checkbox" class="timeoff-approver-checkbox" value="${escapeHtml(a.id)}" ${approverIds.has(a.id) ? "checked" : ""} />
          ${escapeHtml(a.name)}
        </label>
      `
        )
        .join("")}
    </div>
    <h3>Requests</h3>
    <div class="timeoff-person-requests-host"></div>
  `;

  const refreshDetail = () => renderPersonDetail(detailHost, techId, { types, policies, admins, host });
  detailHost.querySelector(".timeoff-admin-request-btn").addEventListener("click", () => {
    openRequestForm({ types, techId, onSubmitted: refreshDetail });
  });
  detailHost.querySelector(".timeoff-policy-select").addEventListener("change", async (e) => {
    try {
      await api.patch(`/api/time-off/technicians/${techId}/policy`, { policyId: e.target.value ? Number(e.target.value) : null });
      await renderPersonDetail(detailHost, techId, { types, policies, admins, host });
    } catch (err) {
      window.alert(err.message);
    }
  });
  detailHost.querySelectorAll(".timeoff-approver-checkbox").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const checked = [...detailHost.querySelectorAll(".timeoff-approver-checkbox:checked")].map((c) => c.value);
      try {
        await api.put(`/api/time-off/approvers/${techId}`, { approverIds: checked });
      } catch (err) {
        window.alert(err.message);
        await renderPersonDetail(detailHost, techId, { types, policies, admins, host });
      }
    });
  });

  const requestsHost = detailHost.querySelector(".timeoff-person-requests-host");
  requestsHost.innerHTML = renderRequestsTable(requests, types, { onDecide: refreshDetail });
  wireRequestsTable(requestsHost, { onDecide: refreshDetail });
}
