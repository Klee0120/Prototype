import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

function formatHours(h) {
  if (h == null) return "—";
  return h < 24 ? `${h}h` : `${(h / 24).toFixed(1)}d`;
}

const ROLE_LABELS = { tech: "Technician", admin: "Admin" };

// Average time to generate a requested PO, vendor-compliance cases
// resolved, and reclass request-to-submission turnaround -- all computed
// from timestamps the app already records (see db.getPerformanceKpis), not
// a new tracking UI. Open to anyone who can receive a task to view (same
// spirit as Audit Trail being read-only chrome), reached through the admin
// nav since that's where every other cross-person view already lives.
export async function renderPerformance(container) {
  let rows = [];
  let sortState = { key: "name", dir: "asc" };
  const filters = { from: "", to: "" };

  async function draw() {
    renderLoadingState(container, loadingLabelFor("Performance"));
    try {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      rows = await api.get(`/api/admin/performance-kpis?${params}`);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    drawTable();
  }

  const GETTERS = {
    name: (r) => (r.name || "").toLowerCase(),
    role: (r) => (r.role || ""),
    poRequestsGenerated: (r) => r.poRequestsGenerated,
    poRequestsAvgHours: (r) => (r.poRequestsAvgHours == null ? -Infinity : r.poRequestsAvgHours),
    vendorDocsCompleted: (r) => r.vendorDocsCompleted,
    reclassSubmitted: (r) => r.reclassSubmitted,
    reclassAvgHours: (r) => (r.reclassAvgHours == null ? -Infinity : r.reclassAvgHours),
  };

  function sortRows(list) {
    const getter = GETTERS[sortState.key];
    if (!getter) return list;
    const sorted = [...list];
    sorted.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return sortState.dir === "asc" ? -1 : 1;
      if (av > bv) return sortState.dir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  function sortArrow(key) {
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? " ▲" : " ▼";
  }

  const COLUMNS = [
    { key: "name", label: "Person" },
    { key: "role", label: "Role" },
    { key: "poRequestsGenerated", label: "PO Requests Generated" },
    { key: "poRequestsAvgHours", label: "PO Turnaround (avg)" },
    { key: "vendorDocsCompleted", label: "Vendor Docs Completed" },
    { key: "reclassSubmitted", label: "Reclass Submitted" },
    { key: "reclassAvgHours", label: "Reclass Turnaround (avg)" },
  ];

  function drawTable() {
    const sorted = sortRows(rows);
    container.innerHTML = `
      <h3 style="margin: 0 0 4px;">Performance</h3>
      <p class="review-checklist-hint">
        Average time to generate a requested PO, vendor-compliance documents completed, and reclass
        request-to-submission turnaround -- computed from timestamps already on file, scoped to whoever
        actually did each piece of work. A still-open item isn't counted yet.
      </p>
      <div class="wom-filter-bar">
        <label class="profile-field performance-date-field">
          <span>From</span>
          <input type="date" class="performance-from" value="${escapeHtml(filters.from)}" />
        </label>
        <label class="profile-field performance-date-field">
          <span>To</span>
          <input type="date" class="performance-to" value="${escapeHtml(filters.to)}" />
        </label>
        <button type="button" class="btn btn-secondary performance-clear-dates">All time</button>
      </div>
      ${
        sorted.length === 0
          ? `<p class="empty-note">No one has an active account yet.</p>`
          : `<table class="detail-table performance-table">
              <thead>
                <tr>
                  ${COLUMNS.map((c) => `<th class="performance-sort-th" data-key="${c.key}">${c.label}${sortArrow(c.key)}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${sorted
                  .map(
                    (r) => `
                  <tr>
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(ROLE_LABELS[r.role] || r.role)}</td>
                    <td>${r.poRequestsGenerated}</td>
                    <td>${formatHours(r.poRequestsAvgHours)}</td>
                    <td>${r.vendorDocsCompleted}</td>
                    <td>${r.reclassSubmitted}</td>
                    <td>${formatHours(r.reclassAvgHours)}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    `;

    container.querySelectorAll(".performance-sort-th").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        sortState = { key, dir: sortState.key === key && sortState.dir === "asc" ? "desc" : "asc" };
        drawTable();
      });
    });
    container.querySelector(".performance-from").addEventListener("change", (e) => {
      filters.from = e.target.value;
      draw();
    });
    container.querySelector(".performance-to").addEventListener("change", (e) => {
      filters.to = e.target.value;
      draw();
    });
    container.querySelector(".performance-clear-dates").addEventListener("click", () => {
      filters.from = "";
      filters.to = "";
      draw();
    });
  }

  await draw();
}
