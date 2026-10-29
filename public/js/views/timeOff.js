import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { renderAttachments } from "./attachments.js";

let typesCache = null;
async function loadTypes() {
  if (!typesCache) typesCache = await api.get("/api/time-off/types");
  return typesCache;
}
export { loadTypes as loadTimeOffTypes };

function typeLabel(types, value) {
  return (types.find((t) => t.value === value) || {}).label || value;
}

const STATUS_BADGE_CLASS = { pending: "submitted", approved: "approved", denied: "rejected", cancelled: "draft" };

function dateRangeLabel(r) {
  return r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}`;
}

// ---- Time-off-only month calendar (shared by the self-service and
// per-technician admin views below). The Schedule tab's own calendar
// already blends this same approved-time-off data with WOM work across
// everyone (see server/routes/schedule.js's GET /:month/time-off); this
// narrows that same feed to one person, for the Time Off tab itself.
const CAL_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CAL_DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CAL_TIME_OFF_COLOR_CLASS = {
  vacation: "schedule-timeoff-chip-yellow",
  holiday: "schedule-timeoff-chip-yellow",
  sick: "schedule-timeoff-chip-blue",
  floating_holiday: "schedule-timeoff-chip-ok",
  bereavement: "schedule-timeoff-chip-violet",
};

function calCurrentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function calShiftMonth(monthIso, delta) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function calAddDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function calMondayOfIso(dateIso) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const mondayIndex = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0=Mon..6=Sun
  return calAddDaysIso(dateIso, -mondayIndex);
}

async function renderTimeOffCalendar(host, { techId, types, initialMonth }) {
  let month = initialMonth || calCurrentMonthIso();

  async function draw() {
    let byDate;
    try {
      byDate = await api.get(`/api/schedule/${month}/time-off`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const [y, m] = month.split("-").map(Number);
    const lastOfMonth = calAddDaysIso(`${calShiftMonth(month, 1)}-01`, -1);
    const gridStart = calMondayOfIso(`${month}-01`);
    const gridEndMonday = calMondayOfIso(lastOfMonth);
    const days = [];
    for (let cur = gridStart; cur <= calAddDaysIso(gridEndMonday, 6); cur = calAddDaysIso(cur, 1)) days.push(cur);
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

    host.innerHTML = `
      <div class="week-nav timeoff-cal-nav">
        <button type="button" class="btn btn-ghost timeoff-cal-prev">&larr; Prev</button>
        <div class="week-range">${CAL_MONTH_NAMES[m - 1]} ${y}</div>
        <button type="button" class="btn btn-ghost timeoff-cal-next">Next &rarr;</button>
      </div>
      <div class="schedule-calendar-grid">
        <div class="schedule-calendar-headerrow">${CAL_DAY_HEADERS.map((d) => `<div class="schedule-calendar-headercell">${d}</div>`).join("")}</div>
        ${weeks
          .map(
            (week) => `
          <div class="schedule-week">
            ${week
              .map((dateIso) => {
                const [dy, dm, dd] = dateIso.split("-").map(Number);
                const inMonth = dm === m && dy === y;
                const entries = (byDate[dateIso] || []).filter((e) => e.techId === techId);
                return `<div class="schedule-daycell timeoff-cal-daycell ${inMonth ? "" : "schedule-calendar-outside"}">
                  <div class="schedule-calendar-daynum">${dd}</div>
                  ${entries
                    .map((e) => {
                      const colorClass = CAL_TIME_OFF_COLOR_CLASS[e.type] || "schedule-timeoff-chip-yellow";
                      return `<span class="schedule-timeoff-chip ${colorClass}">${escapeHtml(typeLabel(types, e.type))} &middot; ${e.hours}h</span>`;
                    })
                    .join("")}
                </div>`;
              })
              .join("")}
          </div>
        `
          )
          .join("")}
      </div>
    `;
    host.querySelector(".timeoff-cal-prev").addEventListener("click", () => {
      month = calShiftMonth(month, -1);
      draw();
    });
    host.querySelector(".timeoff-cal-next").addEventListener("click", () => {
      month = calShiftMonth(month, 1);
      draw();
    });
  }

  await draw();
}

function renderBalanceTable(balance, { onAuditTrail } = {}) {
  if (balance.types.length === 0) {
    return `<p class="empty-note">${balance.policyName ? "This policy has no accrual rules configured yet." : "No time-off policy assigned yet -- an admin needs to set one."}</p>`;
  }
  return `
    <table class="detail-table">
      <thead><tr><th>Type</th><th>Accrued</th><th>Cap</th><th>Used</th><th>Pending</th><th>Balance</th><th></th></tr></thead>
      <tbody>
        ${balance.types
          .map(
            (t) => `
          <tr>
            <td>${escapeHtml(t.label)}</td>
            <td>${t.accruedHours}h</td>
            <td>${t.capHours != null ? `${t.capHours}h` : "—"}</td>
            <td>${t.used}h</td>
            <td>${t.pending}h</td>
            <td>${t.balance}h</td>
            <td>${onAuditTrail ? `<button type="button" class="btn btn-link timeoff-audit-trail-btn" data-type="${escapeHtml(t.type)}">Audit Trail</button>` : ""}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function wireBalanceAuditTrailButtons(host, { types, techId, techName, onAuditTrail }) {
  if (!onAuditTrail) return;
  host.querySelectorAll(".timeoff-audit-trail-btn").forEach((btn) => {
    btn.addEventListener("click", () => openAuditTrailModal({ types, techId, techName, initialType: btn.dataset.type }));
  });
}

// Mirrors PurelyHR's own Accrual Balance Audit Trail screen: employee +
// type + calendar year up top, then the discrete Date / Type / Accrued By
// entries underneath -- every posted time_off_accrual_events row, never
// recomputed on the fly.
function openAuditTrailModal({ types, techId, techName, initialType }) {
  const years = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 3; y -= 1) years.push(y);

  const { body, close } = openModal({
    title: "Accrual Balance Audit Trail",
    size: "large",
    bodyHtml: `
      <div class="timeoff-audit-trail">
        <div class="timeoff-audit-trail-header">
          <div class="profile-field">
            <span>Employee</span>
            <div class="timeoff-audit-trail-name">${escapeHtml(techName || techId)}</div>
          </div>
          <label class="profile-field">
            <span>Time-Off Type</span>
            <select class="timeoff-audit-type">
              ${types.map((t) => `<option value="${t.value}" ${t.value === initialType ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field">
            <span>Calendar Year</span>
            <select class="timeoff-audit-year">
              ${years.map((y) => `<option value="${y}">${y}</option>`).join("")}
            </select>
          </label>
        </div>
        <div class="timeoff-audit-trail-table-host"></div>
      </div>
    `,
  });

  const typeSelect = body.querySelector(".timeoff-audit-type");
  const yearSelect = body.querySelector(".timeoff-audit-year");
  const tableHost = body.querySelector(".timeoff-audit-trail-table-host");

  async function refresh() {
    tableHost.innerHTML = `<p class="empty-note">Loading…</p>`;
    try {
      const events = await api.get(
        `/api/time-off/accrual-events/${techId}?type=${encodeURIComponent(typeSelect.value)}&year=${encodeURIComponent(yearSelect.value)}`
      );
      if (events.length === 0) {
        tableHost.innerHTML = `<p class="empty-note">No accrual activity posted for this type/year yet.</p>`;
        return;
      }
      tableHost.innerHTML = `
        <table class="detail-table">
          <thead><tr><th>Date</th><th>Time-Off Type</th><th>Hours</th><th>Accrued By</th><th>By</th><th>Note</th></tr></thead>
          <tbody>
            ${events
              .map(
                (e) => `
              <tr>
                <td>${escapeHtml(e.accrualDate)}</td>
                <td>${escapeHtml(typeLabel(types, e.type))}</td>
                <td class="${e.hours < 0 ? "cost-amount-danger" : ""}">${e.hours > 0 ? "+" : ""}${e.hours}h</td>
                <td>${escapeHtml(e.accruedBy)}</td>
                <td>${escapeHtml(e.enteredBy || "—")}</td>
                <td>${escapeHtml(e.note || "—")}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `;
    } catch (err) {
      tableHost.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    }
  }

  typeSelect.addEventListener("change", refresh);
  yearSelect.addEventListener("change", refresh);
  refresh();

  return close;
}

// techId fixed + no people list = the tech's own self-service form (no
// "who is this for" picker, since there's only one possible answer).
// people passed in = the admin form, with a "Request For" picker up top --
// matches PurelyHR's own "Request For: Select User" entry point -- techId
// becomes that dropdown's initial value (or the first person) rather than
// a fixed subject.
export function openRequestForm({ types, techId, people, onSubmitted }) {
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

// A one-off balance entry, admin-only -- for bringing in an opening
// balance from PurelyHR (or any other real-world correction) instead of
// starting someone at zero. Posts as its own "Manual Adjustment" line in
// the Balance Audit Trail, distinct from system accrual.
function openBalanceAdjustmentForm({ types, techId, onSubmitted }) {
  const { body, close } = openModal({
    title: "Adjust Balance",
    bodyHtml: `
      <form class="modal-form timeoff-adjust-form">
        <label class="profile-field">
          <span>Type</span>
          <select name="type">${types.map((t) => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join("")}</select>
        </label>
        <label class="profile-field">
          <span>Hours (negative to subtract)</span>
          <input type="number" name="hours" step="0.001" required placeholder="e.g. 4.036 or -8" />
        </label>
        <label class="profile-field">
          <span>Effective date</span>
          <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}" />
        </label>
        <label class="profile-field">
          <span>Note (recommended)</span>
          <textarea name="note" placeholder="e.g. Opening balance from PurelyHR audit"></textarea>
        </label>
        <div class="modal-form-actions"><button type="submit" class="btn btn-primary">Save adjustment</button></div>
        <span class="save-message"></span>
      </form>
    `,
  });
  const form = body.querySelector(".timeoff-adjust-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".save-message");
    try {
      await api.post(`/api/time-off/technicians/${techId}/balance-adjustment`, {
        type: form.type.value,
        hours: Number(form.hours.value),
        date: form.date.value,
        note: form.note.value.trim(),
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
    ${renderBalanceTable(balance, { onAuditTrail: true })}
    <h3>My Time Off Calendar</h3>
    <div class="timeoff-calendar-host"></div>
    <h3>My Requests</h3>
    <div class="timeoff-requests-host"></div>
  `;

  container.querySelector(".timeoff-request-btn").addEventListener("click", () => {
    openRequestForm({ types, techId, onSubmitted: () => renderMyTimeOff(container) });
  });
  wireBalanceAuditTrailButtons(container, { types, techId, techName: state.user.name, onAuditTrail: true });
  renderTimeOffCalendar(container.querySelector(".timeoff-calendar-host"), { techId, types });

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
        <button type="button" class="tab ${adminSubTab === "documents" ? "active" : ""}" data-sub="documents">Policy Documents</button>
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
  else if (adminSubTab === "documents") await renderPolicyDocuments(body);
  else await renderApprovalsQueue(body, types, container);
}

// Company-wide reference documents (PTO Policy, Benefit Brochure, Employee
// Handbook, blank onboarding forms) -- one fixed bucket everyone reads the
// same copy of, see server/routes/files.js's "company_documents" related
// type. Admin can upload/replace/delete here; the matching read-only card
// technicians see lives on the My Documents tab (techHome.js).
async function renderPolicyDocuments(host) {
  host.innerHTML = `<div class="timeoff-policy-docs-host"></div>`;
  await renderAttachments(host.querySelector(".timeoff-policy-docs-host"), {
    title: "Policy Documents & Blank Forms",
    relatedType: "company_documents",
    relatedId: "library",
    categories: [
      { value: "policy", label: "Company Policy" },
      { value: "form", label: "Blank Form" },
    ],
    canUpload: true,
    emptyText: "No policy documents or blank forms uploaded yet.",
  });
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
  const ruleSummary = (r) => {
    const freq = r.frequency === "monthly" ? `/mo` : r.frequency === "annually" ? `/yr` : " on hire";
    if (r.tiered) {
      const years = r.tiers.map((t) => t.minYears);
      return `${escapeHtml(typeLabel(types, r.type))}: Tenure-tiered${freq} (${r.tiers.length} tier${r.tiers.length === 1 ? "" : "s"}, ${Math.min(...years)}-${Math.max(...years)}+ yrs)`;
    }
    return `${escapeHtml(typeLabel(types, r.type))}: ${r.rateHours}h${freq}${r.accrueUntil === "cap" ? ` (cap ${r.capHours}h)` : ""}`;
  };
  list.innerHTML = `
    <table class="detail-table">
      <thead><tr><th>Name</th><th>Accrual Rules</th><th></th></tr></thead>
      <tbody>
        ${policies
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${escapeHtml(p.name)}</td>
            <td>${p.rules.map(ruleSummary).join(" &middot; ") || "—"}</td>
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

// One fieldset per time-off type -- matches PurelyHR's own Balance Accrual
// screen (Interval, Accrue On, Rate, Accrue Until, plus a first-year start
// rule) rather than the old single "yearly hours" number. A type's
// checkbox off means it's simply not offered under this policy at all --
// same meaning the old blank-input-means-not-offered convention had.
// Seeded into a fresh tenure-tiered rule the moment it's turned on (for a
// rule with no tiers yet) -- the real PTO policy's own rate card, in hours
// (days x 8). Just a starting point: every field stays fully editable, and
// an existing rule's own saved tiers are used instead of this once any
// exist.
const DEFAULT_TENURE_TIERS = [
  { minYears: 0, rateHours: 6.64, capHours: 80 },
  { minYears: 1, rateHours: 7.36, capHours: 88 },
  { minYears: 2, rateHours: 8.0, capHours: 96 },
  { minYears: 3, rateHours: 8.64, capHours: 104 },
  { minYears: 4, rateHours: 10.0, capHours: 120 },
  { minYears: 5, rateHours: 10.64, capHours: 128 },
  { minYears: 6, rateHours: 11.36, capHours: 136 },
  { minYears: 7, rateHours: 12.0, capHours: 144 },
  { minYears: 8, rateHours: 12.64, capHours: 152 },
  { minYears: 9, rateHours: 13.36, capHours: 160 },
];

function tierRowHtml(tier, showCap) {
  return `
    <div class="timeoff-tier-row">
      <label><span>Years of service</span><input type="number" class="tier-min-years" min="0" step="1" value="${tier.minYears}" /></label>
      <label><span>Rate (hrs/occurrence)</span><input type="number" class="tier-rate" min="0.01" step="0.01" value="${tier.rateHours}" /></label>
      <label class="tier-cap-field" ${showCap ? "" : "hidden"}><span>Annual cap (hrs)</span><input type="number" class="tier-cap" min="0" step="0.01" value="${tier.capHours ?? ""}" /></label>
      <button type="button" class="btn btn-link timeoff-tier-remove-btn" title="Remove this tier">&times;</button>
    </div>
  `;
}

function ruleFieldsetHtml(t, rule) {
  const enabled = Boolean(rule);
  const accrueUntil = rule?.accrueUntil || "cap";
  const tiered = Boolean(rule?.tiered);
  const tiers = tiered && rule.tiers.length ? rule.tiers : DEFAULT_TENURE_TIERS;
  return `
    <div class="timeoff-rule-group" data-type="${t.value}">
      <label class="timeoff-rule-toggle">
        <input type="checkbox" class="rule-enabled" ${enabled ? "checked" : ""} />
        <strong>${escapeHtml(t.label)}</strong>
      </label>
      <div class="timeoff-rule-fields" ${enabled ? "" : "hidden"}>
        <label class="profile-field">
          <span>Frequency</span>
          <select class="rule-frequency">
            <option value="monthly" ${!rule || rule.frequency === "monthly" ? "selected" : ""}>Monthly accrual</option>
            <option value="annually" ${rule?.frequency === "annually" ? "selected" : ""}>Annual accrual</option>
            <option value="on_hire_date" ${rule?.frequency === "on_hire_date" ? "selected" : ""}>On hire date, then Jan 1 each year after</option>
          </select>
        </label>
        <label class="profile-field">
          <span>Accrue on day</span>
          <input type="number" class="rule-accrue-day" min="1" max="28" value="${rule?.accrueOnDay || 1}" />
        </label>
        <label class="profile-field">
          <span>Accrue until</span>
          <select class="rule-accrue-until">
            <option value="cap" ${accrueUntil === "cap" ? "selected" : ""}>Annual cap</option>
            <option value="none" ${accrueUntil === "none" ? "selected" : ""}>Flat grant (no running cap)</option>
          </select>
        </label>
        <label class="profile-field">
          <span>First (partial) year</span>
          <select class="rule-start">
            <option value="hire_date" ${!rule || rule.startRule === "hire_date" ? "selected" : ""}>Pro-rate from hire date</option>
            <option value="calendar_year" ${rule?.startRule === "calendar_year" ? "selected" : ""}>Full amount from assignment</option>
          </select>
        </label>
        <label class="timeoff-tier-toggle">
          <input type="checkbox" class="rule-tiered" ${tiered ? "checked" : ""} />
          Rate depends on years of service (tenure-tiered) -- one policy, rate follows each person's own hire date
        </label>
        <label class="profile-field rule-flat-field" ${tiered ? "hidden" : ""}>
          <span>Rate (hours per occurrence)</span>
          <input type="number" step="0.01" min="0.01" class="rule-rate" value="${rule?.rateHours ?? ""}" placeholder="e.g. 6.64" />
        </label>
        <label class="profile-field rule-flat-field rule-cap-field" ${tiered || accrueUntil === "none" ? "hidden" : ""}>
          <span>Annual cap (hours)</span>
          <input type="number" step="0.01" min="0" class="rule-cap" value="${rule?.capHours ?? ""}" placeholder="e.g. 80" />
        </label>
        <div class="timeoff-tier-table" ${tiered ? "" : "hidden"}>
          <p class="review-checklist-hint">One row per "years of service" breakpoint -- everyone assigned to this policy automatically gets the row matching their own completed years, recomputed every accrual run.</p>
          <div class="timeoff-tier-rows">${tiers.map((tier) => tierRowHtml(tier, accrueUntil !== "none")).join("")}</div>
          <button type="button" class="btn btn-link timeoff-tier-add-btn">+ Add tier</button>
        </div>
      </div>
    </div>
  `;
}

function wireRuleFieldset(group) {
  const checkbox = group.querySelector(".rule-enabled");
  const fields = group.querySelector(".timeoff-rule-fields");
  checkbox.addEventListener("change", () => {
    fields.toggleAttribute("hidden", !checkbox.checked);
  });
  const accrueUntilSelect = group.querySelector(".rule-accrue-until");
  const flatCapField = group.querySelector(".rule-flat-field.rule-cap-field");
  accrueUntilSelect.addEventListener("change", () => {
    const showCap = accrueUntilSelect.value !== "none";
    flatCapField.toggleAttribute("hidden", !showCap || tieredCheckbox.checked);
    group.querySelectorAll(".tier-cap-field").forEach((f) => f.toggleAttribute("hidden", !showCap));
  });

  const tieredCheckbox = group.querySelector(".rule-tiered");
  const flatField = group.querySelector(".rule-flat-field:not(.rule-cap-field)");
  const tierTable = group.querySelector(".timeoff-tier-table");
  tieredCheckbox.addEventListener("change", () => {
    const tiered = tieredCheckbox.checked;
    flatField.toggleAttribute("hidden", tiered);
    flatCapField.toggleAttribute("hidden", tiered || accrueUntilSelect.value === "none");
    tierTable.toggleAttribute("hidden", !tiered);
  });

  function wireTierRow(row) {
    row.querySelector(".timeoff-tier-remove-btn").addEventListener("click", () => {
      if (group.querySelectorAll(".timeoff-tier-row").length > 1) row.remove();
    });
  }
  group.querySelectorAll(".timeoff-tier-row").forEach(wireTierRow);
  group.querySelector(".timeoff-tier-add-btn").addEventListener("click", () => {
    const rowsHost = group.querySelector(".timeoff-tier-rows");
    const nextMinYears = rowsHost.querySelectorAll(".timeoff-tier-row").length;
    const showCap = accrueUntilSelect.value !== "none";
    rowsHost.insertAdjacentHTML("beforeend", tierRowHtml({ minYears: nextMinYears, rateHours: "", capHours: "" }, showCap));
    wireTierRow(rowsHost.lastElementChild);
  });
}

function openPolicyForm(types, existing, onSaved) {
  const isEdit = Boolean(existing);
  const ruleByType = new Map((existing?.rules || []).map((r) => [r.type, r]));
  const { body, close } = openModal({
    title: isEdit ? `Edit "${existing.name}"` : "Add Time-Off Policy",
    size: "large",
    bodyHtml: `
      <form class="modal-form timeoff-policy-form">
        <label class="profile-field">
          <span>Name</span>
          <input name="name" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. 2yr Policy, New Hire" required />
        </label>
        <p class="review-checklist-hint">Check a type to offer it under this policy and set its accrual rule -- matches PurelyHR's own Balance Accrual screen. Turn on "tenure-tiered" to have the rate follow each person's own hire date automatically (one policy for everyone), or leave it off for one flat rate for anyone on this policy.</p>
        ${types.map((t) => ruleFieldsetHtml(t, ruleByType.get(t.value))).join("")}
        <div class="modal-form-actions"><button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add Policy"}</button></div>
        <span class="save-message"></span>
      </form>
    `,
  });
  const form = body.querySelector(".timeoff-policy-form");
  form.querySelectorAll(".timeoff-rule-group").forEach(wireRuleFieldset);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".save-message");
    const rules = [];
    for (const group of form.querySelectorAll(".timeoff-rule-group")) {
      if (!group.querySelector(".rule-enabled").checked) continue;
      const accrueUntil = group.querySelector(".rule-accrue-until").value;
      const tiered = group.querySelector(".rule-tiered").checked;
      const rule = {
        type: group.dataset.type,
        frequency: group.querySelector(".rule-frequency").value,
        accrueOnDay: Number(group.querySelector(".rule-accrue-day").value) || 1,
        accrueUntil,
        startRule: group.querySelector(".rule-start").value,
        tiered,
      };
      if (tiered) {
        rule.tiers = [...group.querySelectorAll(".timeoff-tier-row")].map((row) => ({
          minYears: Number(row.querySelector(".tier-min-years").value),
          rateHours: Number(row.querySelector(".tier-rate").value),
          capHours: accrueUntil === "cap" ? Number(row.querySelector(".tier-cap").value) : null,
        }));
      } else {
        rule.rateHours = Number(group.querySelector(".rule-rate").value);
        rule.capHours = accrueUntil === "cap" ? Number(group.querySelector(".rule-cap").value) : null;
      }
      rules.push(rule);
    }
    try {
      const payload = { name: form.name.value.trim(), rules };
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
  await renderPersonDetail(host.querySelector(".timeoff-person-detail"), byTechSelectedId, { types, policies, admins, people, host });
}

async function renderPersonDetail(detailHost, techId, { types, policies, admins, people, host }) {
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
        <button type="button" class="btn btn-secondary timeoff-adjust-balance-btn">+ Adjust Balance</button>
        <button type="button" class="btn btn-primary timeoff-admin-request-btn">+ Request Time Off</button>
      </div>
    </div>
    <label class="timeoff-approver-option" title="CA/MT/NE allow carrying over unused PTO (up to 1.75x the annual cap) instead of the default use-it-or-lose-it reset every Jan 1.">
      <input type="checkbox" class="timeoff-carryover-exempt-checkbox" ${balance.ptoCarryoverExempt ? "checked" : ""} />
      CA/MT/NE carryover exception applies to this person
    </label>
    ${renderBalanceTable(balance, { onAuditTrail: true })}
    <h3>Time Off Calendar</h3>
    <div class="timeoff-calendar-host"></div>
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

  const refreshDetail = () => renderPersonDetail(detailHost, techId, { types, policies, admins, people, host });
  const techName = (people || []).find((p) => p.id === techId)?.name;
  wireBalanceAuditTrailButtons(detailHost, { types, techId, techName, onAuditTrail: true });
  renderTimeOffCalendar(detailHost.querySelector(".timeoff-calendar-host"), { techId, types });
  detailHost.querySelector(".timeoff-admin-request-btn").addEventListener("click", () => {
    openRequestForm({ types, techId, onSubmitted: refreshDetail });
  });
  detailHost.querySelector(".timeoff-adjust-balance-btn").addEventListener("click", () => {
    openBalanceAdjustmentForm({ types, techId, onSubmitted: refreshDetail });
  });
  detailHost.querySelector(".timeoff-policy-select").addEventListener("change", async (e) => {
    try {
      await api.patch(`/api/time-off/technicians/${techId}/policy`, { policyId: e.target.value ? Number(e.target.value) : null });
      await renderPersonDetail(detailHost, techId, { types, policies, admins, people, host });
    } catch (err) {
      window.alert(err.message);
    }
  });
  detailHost.querySelector(".timeoff-carryover-exempt-checkbox").addEventListener("change", async (e) => {
    try {
      await api.patch(`/api/time-off/technicians/${techId}/carryover-exempt`, { exempt: e.target.checked });
    } catch (err) {
      window.alert(err.message);
      e.target.checked = !e.target.checked;
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
