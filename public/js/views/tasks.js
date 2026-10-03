import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";
import { renderAttachments } from "./attachments.js";

// A document that's come in but isn't ready to be filed against a specific
// vendor's own record yet (e.g. a COI from Aon for a renewal she hasn't
// worked yet) -- attach it here instead of skipping the vendor lookup step,
// so it's tracked on a task and not lost, without tying either the file or
// the task to any vendor. Same category vocabulary server/routes/files.js
// uses for a vendor's own documents, so filing it for real later is just a
// re-upload under the same category, no re-labeling.
const TASK_DOC_CATEGORIES = [
  { value: "coi", label: "COI (Certificate of Insurance)" },
  { value: "w9", label: "W-9" },
  { value: "ach", label: "ACH / Bank Letter" },
  { value: "vpo_waiver", label: "VPO Waiver" },
  { value: "vendor_other", label: "Other Vendor Document" },
  { value: "document", label: "Document" },
];

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
  // Every workflow exception today is a WOM lifecycle task with a Toyota
  // paperwork gap (see needsChangeOrderOrPo in server/data/db.js) -- named
  // for exactly that rather than the generic "Workflow Exceptions," since
  // "how many of these do I have" is the whole point of this tile/tab.
  // Revisit this label if another kind of task ever sets isException too.
  exceptions: "Needs Change Order/TOY PO",
  recurring: "Recurring Tasks",
  // Tasks snoozed forward via Reschedule -- hidden from every other view
  // until their snooze date arrives, so this is the one place to still
  // find and act on one early if something changes.
  upcoming: "Upcoming",
  completed: "Completed",
};
const ADMIN_VIEWS = ["my", "team", "unassigned", "overdue", "waiting", "exceptions", "recurring", "upcoming", "completed"];
const TECH_VIEWS = ["my", "team", "waiting", "overdue", "completed"];

// Plain-English explanations for the "What do these mean?" legend -- the
// tab/tile labels above are necessarily short, and what each one actually
// includes (especially the less obvious ones like Unassigned vs. My Work,
// or what moves a task into Upcoming) isn't always obvious from the name
// alone.
const VIEW_EXPLANATIONS = {
  my: "Tasks assigned to you by name, plus any unclaimed task for your role.",
  team: "Every open task for your role, whoever it's assigned to -- the whole team's queue, not just yours.",
  unassigned: "Open tasks nobody has claimed yet, across every role.",
  overdue: "Open tasks past their due date.",
  waiting: "Tasks marked “Waiting on someone else” -- not stuck on you, but not done either.",
  exceptions: "WOMs with a Toyota paperwork gap -- see the Colors & flags section below for the orange/red split.",
  recurring: "Scheduled tasks that come back on their own on a daily/weekly/monthly cadence.",
  upcoming: "Tasks rescheduled (snoozed) forward with a status note -- hidden from every other list until the date you picked arrives. Admin only.",
  completed: "Tasks that are done or cancelled.",
};

const PRIORITY_LABELS = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent", emergency: "Emergency" };
const STATUS_LABELS = { open: "Open", in_progress: "In Progress", waiting: "Waiting", completed: "Completed", cancelled: "Cancelled" };
const CATEGORY_LABELS = {
  manual: "General",
  vendor_compliance: "Compliance",
  onboarding: "Onboarding",
  it_request: "IT Request",
  financial: "Financial",
  wom_workflow: "WOM Workflow",
  recurring: "Recurring",
};
// Which of the above a person can actually pick when creating a task by
// hand -- wom_workflow/recurring are reserved for what the PSE pipeline and
// the recurring-task engine generate on their own, so offering them here
// would just create a same-named but disconnected impostor category.
const MANUAL_CATEGORY_OPTIONS = ["manual", "vendor_compliance", "onboarding", "it_request", "financial"];
// Groups the flat category list into the handful of visually distinct,
// color-coded sections asked for -- "visually easy to understand" without
// turning into yet another tab to click through. Order here is the order
// sections render in; a category not listed anywhere falls into "general".
const TASK_SECTIONS = [
  { key: "financial", label: "Financial & PO/WOM", colorClass: "task-section-financial", categories: ["financial", "wom_workflow"] },
  { key: "compliance", label: "Compliance Items", colorClass: "task-section-compliance", categories: ["vendor_compliance"] },
  { key: "onboarding", label: "Onboarding", colorClass: "task-section-onboarding", categories: ["onboarding"] },
  { key: "it", label: "IT Requests", colorClass: "task-section-it", categories: ["it_request"] },
  { key: "recurring", label: "Recurring", colorClass: "task-section-recurring", categories: ["recurring"] },
  { key: "general", label: "General", colorClass: "task-section-general", categories: ["manual"] },
];
const SECTION_BY_CATEGORY = Object.fromEntries(TASK_SECTIONS.flatMap((s) => s.categories.map((c) => [c, s])));
function sectionFor(category) {
  return SECTION_BY_CATEGORY[category] || TASK_SECTIONS[TASK_SECTIONS.length - 1];
}
// The other ways the same list can be grouped -- flat, neutral-colored
// buckets rather than the Type split's semantic colors, since "who's it
// assigned to" or "how urgent" isn't itself a category of work.
const GROUP_BY_LABELS = { type: "Type", assignee: "Assignee", priority: "Priority", dueDate: "Due Date", none: "None (flat list)" };
const PRIORITY_ORDER = ["emergency", "urgent", "high", "normal", "low"];
const DUE_BUCKET_ORDER = ["overdue", "today", "week", "later", "none"];
const DUE_BUCKET_LABELS = { overdue: "Overdue", today: "Due Today", week: "Due This Week", later: "Later", none: "No Due Date" };
function dueBucketFor(t) {
  if (!t.dueAt || ["completed", "cancelled"].includes(t.status)) return t.dueAt ? "later" : "none";
  const { cls } = formatRelativeDue(t.dueAt);
  if (cls === "task-due-overdue") return "overdue";
  if (cls === "task-due-today") return "today";
  if (cls === "task-due-soon") return "week";
  return "later";
}
// Builds the ordered list of {key, label, colorClass, items} groups for
// whichever grouping mode is active -- renderTaskList just renders
// whatever comes back, so it doesn't need to know the grouping logic itself.
function groupTasks(tasks, mode) {
  if (mode === "none") return [{ key: "all", label: null, colorClass: "", items: tasks }];
  if (mode === "assignee") {
    const byName = new Map();
    for (const t of tasks) {
      const name = t.assignedToName || (t.assignedRole ? `Unclaimed — ${ROLE_LABELS[t.assignedRole] || t.assignedRole}` : "Unassigned");
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(t);
    }
    return [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({ key: name, label: name, colorClass: "task-section-general", items }));
  }
  if (mode === "priority") {
    return PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_LABELS[p], colorClass: "task-section-general", items: tasks.filter((t) => t.priority === p) })).filter(
      (g) => g.items.length > 0
    );
  }
  if (mode === "dueDate") {
    return DUE_BUCKET_ORDER.map((b) => ({
      key: b,
      label: DUE_BUCKET_LABELS[b],
      colorClass: b === "overdue" ? "task-section-compliance" : "task-section-general",
      items: tasks.filter((t) => dueBucketFor(t) === b),
    })).filter((g) => g.items.length > 0);
  }
  // "type" -- the original color-coded Compliance/Onboarding/IT/Financial/
  // Recurring/General split.
  return TASK_SECTIONS.map((s) => ({ key: s.key, label: s.label, colorClass: s.colorClass, items: tasks.filter((t) => sectionFor(t.category) === s) })).filter(
    (g) => g.items.length > 0
  );
}
// "reviewer" and "financial" are still the stored role values underneath
// (see pseRoleFor in server/data/db.js -- they gate who can act on which
// PSE step), but showing four labels for what's really three kinds of
// people was more granular than useful day-to-day: "financial" reads as
// plain "Admin" here, same as the generic admin role, and "reviewer" reads
// as "RFM" (Toyota's own term for the role). The underlying values are
// unchanged, so filtering/permissions elsewhere still work exactly as
// before -- this only changes what's displayed.
const ROLE_LABELS = { admin: "Admin", reviewer: "RFM", financial: "Admin", tech: "Tech" };
// The role filter's own three choices -- "Admin" searches both the "admin"
// and "financial" stored values in one go (a comma-separated role= the
// server splits back into an IN-list, see GET /api/tasks), since picking
// "Admin" should mean "anything the office handles," not force choosing
// which of the two underlying buckets to look in.
const ROLE_FILTER_OPTIONS = [
  ["admin,financial", "Admin"],
  ["tech", "Tech"],
  ["reviewer", "RFM"],
];
// Reuses the same badge color classes the rest of the app already uses for
// status pills, rather than inventing a second palette just for urgency.
// High reads as red (the same "rejected" class as Urgent/Emergency) rather
// than the blue "submitted" class it used to -- blue doesn't read as
// urgent, and a board full of High-priority rows needs to look like it,
// not blend in with routine in-progress status pills. "warn" (orange) is
// its own tier, one notch below the red ones -- a WOM missing its Toyota PO
// with no cost overage is a paperwork-catch-up problem, not (yet) the money
// problem a real change order is, and the two shouldn't compete for the
// same "drop everything" red.
const URGENCY_BADGE_CLASS = { emergency: "rejected", urgent: "rejected", warn: "warn", high: "rejected", normal: "draft", low: "draft", done: "approved" };

// What to say under an auto-trigger step that's still open -- mirrors
// WOM_LIFECYCLE_STEPS in server/data/db.js (duplicated rather than shared,
// same pattern as this app's other per-view lookup tables).
const WOM_LIFECYCLE_STEP_HINTS = {
  wom_po_created: "Completes automatically once a Maximo/PO # is on file for this WOM.",
  vendor_scheduled: "Completes automatically once this WOM is put on a technician's calendar.",
  work_complete: "Completes automatically once the WOM is marked complete from Timekeeping.",
  cost_applied: "Completes automatically once an applied cost is on file for this WOM.",
};

// Mirrors nextLifecycleStep in server/data/db.js -- see the comment there.
// Not simply the first incomplete step: steps can complete out of order
// (e.g. a WOM synced in with a Maximo/PO # already on file has plainly
// already cleared Toyota approval, even though nobody's clicked "Send PSE
// to Toyota" in this app to log it), so this looks for the first open step
// *after* the furthest one that's actually done, falling back to the
// classic first-incomplete-overall only if nothing's open past that point
// (a lingering earlier gap, e.g. sent_to_toyota never logged even though
// everything after it is done). Exported so adminReview.js's PSE Tasks tab
// computes the exact same "next up" step this task-detail view does.
export function nextLifecycleStep(steps) {
  let lastDoneIndex = -1;
  steps.forEach((s, i) => {
    if (s.completedAt) lastDoneIndex = i;
  });
  for (let i = lastDoneIndex + 1; i < steps.length; i++) {
    if (!steps[i].completedAt) return steps[i];
  }
  return steps.find((s) => !s.completedAt) || null;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function formatDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The six cost categories the Smartsheet tracker itemizes (see
// WOM_COST_BREAKDOWN_FIELDS in server/data/db.js), estimate vs. applied
// side by side -- only the categories either side actually has a number
// for, so a vendor-only job with no itemized breakdown just shows its two
// totals instead of six empty rows.
const WOM_COST_CATEGORY_PAIRS = [
  ["Labor", "estimatedLabor", "appliedLabor"],
  ["Materials", "estimatedMaterials", "appliedMaterials"],
  ["Contracted Services", "estimatedContracted", "appliedContracted"],
  ["Other Direct Costs", "estimatedOtherDirect", "appliedOtherDirect"],
  ["Sales Tax", "estimatedTax", "appliedTax"],
  ["Contingency", "estimatedContingency", "appliedContingency"],
];

// Shown on a WOM lifecycle task once it's flagged for a change order or a
// plain missing Toyota PO (needsChangeOrderOrPo in db.js) -- the actual
// dollar gap RFM is being asked to decide about, not just a flag saying
// something's wrong. A change order's whole premise is "applied came in
// over estimate," so that comparison leads; the Toyota PO value (what was
// actually approved) follows underneath since it's the number a change
// order needs sign-off against.
function renderWomCostBreakdown(wom) {
  const rows = WOM_COST_CATEGORY_PAIRS.filter(([, estKey, appKey]) => wom[estKey] != null || wom[appKey] != null)
    .map(([label, estKey, appKey]) => {
      const est = wom[estKey];
      const app = wom[appKey];
      const over = est != null && app != null && app > est;
      return `<tr class="${over ? "wom-cost-row-over" : ""}">
        <td>${escapeHtml(label)}</td>
        <td>${formatMoney(est)}</td>
        <td>${formatMoney(app)}</td>
      </tr>`;
    })
    .join("");
  const totalOver = wom.estimatedPrice != null && wom.appliedPrice != null && wom.appliedPrice > wom.estimatedPrice;
  const toyotaOver = wom.toyotaPoValue != null && wom.appliedPrice != null && wom.appliedPrice > wom.toyotaPoValue;
  return `
    <table class="detail-table wom-cost-breakdown-table">
      <thead><tr><th>Category</th><th>Estimated</th><th>Applied</th></tr></thead>
      <tbody>
        ${rows}
        <tr class="wom-cost-row-total${totalOver ? " wom-cost-row-over" : ""}">
          <td>Project Total</td>
          <td>${formatMoney(wom.estimatedPrice)}</td>
          <td>${formatMoney(wom.appliedPrice)}</td>
        </tr>
        ${
          wom.toyotaPoValue != null
            ? `<tr class="wom-cost-row-total${toyotaOver ? " wom-cost-row-over" : ""}">
                <td>Toyota PO Value</td>
                <td colspan="2">${formatMoney(wom.toyotaPoValue)}${toyotaOver ? ` <span class="wom-cost-over-note">-- applied is ${formatMoney(wom.appliedPrice - wom.toyotaPoValue)} over</span>` : ""}</td>
              </tr>`
            : ""
        }
      </tbody>
    </table>
  `;
}

// "Due 10/2/2026" takes a beat to parse against today; "Due tomorrow"/
// "3 days overdue" doesn't. Compares calendar days (midnight to midnight),
// not raw hours, so a task due at 11pm today still reads "Due today," not
// "overdue" the moment the clock ticks past its due *time*.
function formatRelativeDue(iso) {
  if (!iso) return { text: "no due date", cls: "" };
  const due = new Date(iso);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((dueDay - todayDay) / 86400000);
  if (diffDays < 0) return { text: `${-diffDays} day${-diffDays === 1 ? "" : "s"} overdue`, cls: "task-due-overdue" };
  if (diffDays === 0) return { text: "due today", cls: "task-due-today" };
  if (diffDays === 1) return { text: "due tomorrow", cls: "task-due-soon" };
  if (diffDays <= 6) return { text: `due in ${diffDays} days`, cls: "task-due-soon" };
  return { text: `due ${formatDate(iso)}`, cls: "" };
}

export async function renderTaskBoard(container) {
  const isAdmin = state.user.role === "admin";
  let view = "my";
  let filters = { assignedTo: "", role: "", location: "", territory: "", wom: "", vendor: "", category: "", categoryExclude: false, dueDate: "", status: "" };
  let staffCache = null;
  // Bulk selection (admin only) -- cleared on every full redraw, since a
  // filter/view change means the selected rows may not even be on screen
  // anymore.
  const selectedTaskIds = new Set();
  // How the same task list is grouped into sections -- Type is the
  // color-coded Compliance/Onboarding/IT/Financial/Recurring/General split;
  // the others are flat, neutral-colored groupings of the same underlying
  // list. Changing this just re-renders against the already-fetched list,
  // no re-fetch needed.
  let groupBy = "type";
  let lastTasks = [];
  // Collapsed by default -- the filter row (assignee/role/location/WOM/
  // vendor/category/due date/status) is a lot to show up front when the
  // My Work tab's own default list is usually exactly what's wanted.
  // Opens automatically once any filter is actually set (e.g. from a WOM
  // lookup elsewhere), and stays open across redraws once toggled on.
  let filtersOpen = false;
  let searchQuery = "";

  await draw();

  async function loadStaff() {
    if (staffCache || !isAdmin) return staffCache;
    const [technicians, admins, locations, vendors, pseTasks] = await Promise.all([
      api.get("/api/admin/technicians"),
      api.get("/api/admin/admins"),
      api.get("/api/locations"),
      api.get("/api/admin/vendors"),
      api.get("/api/woms/lifecycle/tasks"),
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

  // WOMs/locations are open to any logged-in user (same as the Schedule
  // tab's own pickers) -- cached once per board render so New Task and the
  // task edit form don't each re-fetch the full list.
  let womLocationCache = null;
  async function loadWomLocationData() {
    if (womLocationCache) return womLocationCache;
    const [woms, locations] = await Promise.all([api.get("/api/woms"), api.get("/api/locations")]);
    womLocationCache = { woms, locations, locationNameByCode: Object.fromEntries(locations.map((l) => [l.code, l.name])) };
    return womLocationCache;
  }

  // Shared by "Related to a Vendor"/"Related to an Employee" in both New
  // Task and the edit form -- same collapsed-behind-a-checkbox,
  // type-to-search, pick-one-result shape. `initial` pre-fills an existing
  // selection (editing a task that already has one) so the checkbox opens
  // already showing what's picked instead of an empty search box.
  function wireRelatedPicker(section, items, prefix, noun, initial) {
    const toggle = section.querySelector(`.task-new-${prefix}-toggle`);
    const field = section.querySelector(`.task-new-${prefix}-field`);
    const search = field.querySelector(`.task-new-${prefix}-search`);
    const results = field.querySelector(`.task-new-${prefix}-results`);
    const picked = field.querySelector(`.task-new-${prefix}-picked`);
    const pickedName = field.querySelector(`.task-new-${prefix}-picked-name`);
    let selectedId = null;
    const clear = () => {
      selectedId = null;
      picked.hidden = true;
      search.hidden = false;
      search.value = "";
      results.innerHTML = "";
    };
    toggle.addEventListener("change", () => {
      field.hidden = !toggle.checked;
      if (!toggle.checked) clear();
    });
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      if (!q) {
        results.innerHTML = "";
        return;
      }
      const matches = items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 8);
      results.innerHTML = matches.length
        ? matches.map((i) => `<button type="button" class="task-new-${prefix}-result" data-id="${escapeHtml(i.id)}">${escapeHtml(i.name)}</button>`).join("")
        : `<p class="empty-note">No ${noun} matches "${escapeHtml(search.value.trim())}".</p>`;
      results.querySelectorAll(`.task-new-${prefix}-result`).forEach((btn) => {
        btn.addEventListener("click", () => {
          selectedId = btn.dataset.id;
          pickedName.textContent = btn.textContent;
          picked.hidden = false;
          search.hidden = true;
          results.innerHTML = "";
        });
      });
    });
    field.querySelector(`.task-new-${prefix}-clear`).addEventListener("click", clear);
    if (initial && initial.id) {
      selectedId = String(initial.id);
      toggle.checked = true;
      field.hidden = false;
      pickedName.textContent = initial.name;
      picked.hidden = false;
      search.hidden = true;
    }
    return {
      checkAndOpen: () => {
        if (!toggle.checked) {
          toggle.checked = true;
          toggle.dispatchEvent(new Event("change"));
        }
      },
      getId: () => selectedId,
    };
  }

  function queryString() {
    const params = new URLSearchParams();
    params.set("view", view);
    if (isAdmin) {
      if (filters.assignedTo) params.set("assignedTo", filters.assignedTo);
      if (filters.role) params.set("role", filters.role);
      if (filters.location) params.set("location", filters.location);
      if (filters.territory) params.set("territory", filters.territory);
      if (filters.wom) params.set("wom", filters.wom);
      if (filters.vendor) params.set("vendor", filters.vendor);
      if (filters.category) params.set(filters.categoryExclude ? "excludeCategory" : "category", filters.category);
      if (filters.dueDate) params.set("dueDate", filters.dueDate);
      if (filters.status) params.set("status", filters.status);
    }
    return params.toString();
  }

  async function draw() {
    const views = isAdmin ? ADMIN_VIEWS : TECH_VIEWS;
    if (!views.includes(view)) view = "my";
    selectedTaskIds.clear();

    const [summary, tasks] = await Promise.all([api.get("/api/tasks/summary"), api.get(`/api/tasks?${queryString()}`)]);
    lastTasks = tasks;

    // Any filter already set (e.g. left on from earlier this session) means
    // the panel should be open so it's obvious the list isn't the plain
    // default -- otherwise a narrowed-down list with no visible reason why
    // is more confusing than the panel being open.
    if (Object.values(filters).some(Boolean)) filtersOpen = true;

    // Secondary counts (Recurring/PSE Not Sent/Needs Change Order-Toyota PO)
    // still jump to their view on click, just as a compact text line rather
    // than full tiles -- the 4 tiles above are the ones worth a glance at
    // all times; these three are more of a "something to know about" count.
    const secondaryStats = [
      { label: "Recurring", count: summary.recurring, view: isAdmin ? "recurring" : null },
      isAdmin ? { label: "PSE not sent", count: summary.pseNotSent, view: null } : null,
      { label: "Change order / Toyota PO", count: summary.exceptions, view: isAdmin ? "exceptions" : null },
    ].filter(Boolean);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-header-title">Task Manager</h1>
          <p class="page-header-subtitle">Tasks from WOM updates, recurring work and manual entries.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-primary task-new-btn" type="button">+ New task</button>
        </div>
      </div>
      <div class="task-tiles task-tiles-main">
        ${renderTile("Due Today", summary.dueToday, null)}
        ${renderTile("Overdue", summary.overdue, "overdue")}
        ${renderTile("High Priority", summary.highPriority, null)}
        ${renderTile("Waiting", summary.waiting, "waiting")}
      </div>
      <p class="task-secondary-stats">
        ${secondaryStats
          .map((s) =>
            s.view
              ? `<button type="button" class="task-secondary-stat-link" data-view="${s.view}">${s.label} <strong>${s.count}</strong></button>`
              : `<span>${s.label} <strong>${s.count}</strong></span>`
          )
          .join(" &middot; ")}
      </p>
      <div class="tabs task-view-tabs">
        ${views.map((v) => `<button class="tab ${view === v ? "active" : ""}" data-view="${v}">${VIEW_LABELS[v]}</button>`).join("")}
      </div>
      <div class="wom-filter-bar">
        <label class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="search" class="task-search-input" placeholder="Search tasks..." value="${escapeHtml(searchQuery)}" />
        </label>
        ${
          isAdmin
            ? `<button class="btn btn-secondary task-filters-toggle" type="button">${filtersOpen ? "Hide filters" : "Filters"}</button>`
            : ""
        }
        <label class="task-group-by-label">Group by
          <select class="task-group-by">
            ${Object.entries(GROUP_BY_LABELS).map(([k, l]) => `<option value="${k}" ${k === groupBy ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <button class="btn btn-link task-legend-btn" type="button">What do these mean?</button>
      </div>
      ${isAdmin ? `<div id="task-filters" class="${filtersOpen ? "" : "task-filters-collapsed"}"></div>` : ""}
      <div class="task-bulk-toolbar" id="task-bulk-toolbar"></div>
      <div class="review-list" id="task-list"></div>
    `;

    if (isAdmin) {
      container.querySelector(".task-filters-toggle").addEventListener("click", (e) => {
        filtersOpen = !filtersOpen;
        container.querySelector("#task-filters").classList.toggle("task-filters-collapsed", !filtersOpen);
        e.currentTarget.textContent = filtersOpen ? "Hide filters" : "Filters";
      });
    }
    container.querySelector(".task-legend-btn").addEventListener("click", openLegendModal);

    container.querySelectorAll(".task-tile[data-view], .task-secondary-stat-link[data-view]").forEach((el) => {
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
    container.querySelector(".task-group-by").addEventListener("change", (e) => {
      groupBy = e.target.value;
      renderTaskList(container.querySelector("#task-list"), visibleTasks());
    });
    container.querySelector(".task-search-input").addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderTaskList(container.querySelector("#task-list"), visibleTasks());
    });

    if (isAdmin) await renderFilters(container.querySelector("#task-filters"));
    renderTaskList(container.querySelector("#task-list"), visibleTasks());
  }

  // Plain-text search against the already-fetched list -- title/description
  // only, client-side, since the view/role/filter panel above already does
  // the real server-side narrowing.
  function visibleTasks() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return lastTasks;
    return lastTasks.filter((t) => t.title.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  }

  function renderTile(label, count, targetView) {
    const isActive = targetView && targetView === view;
    return `
      <div class="task-tile ${targetView ? "task-tile-clickable" : ""} ${isActive ? "task-tile-active" : ""}" ${targetView ? `data-view="${targetView}"` : ""}>
        <div class="task-tile-count">${count}</div>
        <div class="task-tile-label">${label}</div>
      </div>
    `;
  }

  // A one-stop explainer for the two things people kept asking about --
  // what each tab/list actually includes, and what each badge color/the
  // flag means -- rather than that living only in tribal knowledge or a
  // README nobody using the app day to day would think to open.
  function openLegendModal() {
    const views = isAdmin ? ADMIN_VIEWS : TECH_VIEWS;
    openModal({
      title: "What do these mean?",
      bodyHtml: `
        <h4 class="legend-heading">Lists</h4>
        <dl class="legend-list">
          ${views.map((v) => `<dt>${escapeHtml(VIEW_LABELS[v])}</dt><dd>${escapeHtml(VIEW_EXPLANATIONS[v])}</dd>`).join("")}
        </dl>
        <h4 class="legend-heading">Colors &amp; flags</h4>
        <dl class="legend-list">
          <dt><span class="badge badge-draft">Low / Normal</span></dt>
          <dd>Routine -- nothing time-sensitive about it.</dd>
          <dt><span class="badge badge-rejected">High / Urgent / Emergency</span></dt>
          <dd>Needs attention soon. Emergency also tints the whole row red -- a manual, deliberate "drop everything" call, not something auto-computed.</dd>
          <dt><span class="task-legend-swatch task-legend-swatch-warn"></span> Orange row &amp; badge</dt>
          <dd>"Needs Toyota PO" -- a cost has been applied but there's no Maximo/PO # on file yet. A paperwork-catch-up problem, not (yet) a money problem.</dd>
          <dt><span class="task-legend-swatch task-legend-swatch-danger"></span> Red row &amp; badge, plus 🚩</dt>
          <dd>"Needs Toyota PO change order" -- the applied cost actually came in higher than what Toyota approved. Toyota has to sign off on the difference, one notch more urgent than a plain missing PO. The 🚩 flag is reserved for exactly this case, so it means something rather than sitting on every exception.</dd>
          <dt><span class="badge badge-approved">Completed</span></dt>
          <dd>Done (or cancelled) -- shown in the Completed list only.</dd>
        </dl>
        <h4 class="legend-heading">Who it's for</h4>
        <dl class="legend-list">
          <dt>A person's name</dt>
          <dd>Assigned to that specific person -- it's theirs to act on.</dd>
          <dt>Unclaimed -- Admin / RFM / Tech</dt>
          <dd>Not assigned to anyone by name yet, but it belongs to that role's shared queue -- anyone with that role can open it and act on it. Shows up in that role's My Work and in everyone's Team Work.</dd>
          <dt>Unassigned</dt>
          <dd>No person and no role yet -- nobody's queue includes it automatically. Admin-only list for catching one of these before it falls through the cracks.</dd>
        </dl>
      `,
    });
  }

  async function renderFilters(host) {
    const staff = await loadStaff();
    const people = [...staff.technicians, ...staff.admins];
    const territoriesInUse = [...new Set(staff.locations.map((l) => l.territory || "Midwest"))];
    host.innerHTML = `
      <div class="add-wom-form task-filters-form">
        <select class="task-filter-assignee">
          <option value="">Everyone</option>
          ${people.map((p) => `<option value="${escapeHtml(p.id)}" ${filters.assignedTo === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
        </select>
        <select class="task-filter-role">
          <option value="">Any role</option>
          ${ROLE_FILTER_OPTIONS.map(([value, label]) => `<option value="${value}" ${filters.role === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        ${
          territoriesInUse.length > 1
            ? `<select class="task-filter-territory">
                <option value="">Any territory</option>
                ${territoriesInUse.map((t) => `<option value="${escapeHtml(t)}" ${filters.territory === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
              </select>`
            : ""
        }
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
        <label class="task-filter-exclude-toggle" title="Show every category EXCEPT the one picked above">
          <input type="checkbox" class="task-filter-category-exclude" ${filters.categoryExclude ? "checked" : ""} /> Exclude this type
        </label>
        <input class="task-filter-due" type="date" value="${escapeHtml(filters.dueDate)}" />
        <select class="task-filter-status">
          <option value="">Any status</option>
          ${Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}" ${filters.status === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn btn-link task-filter-clear" type="button">Clear filters</button>
      </div>
    `;
    const bind = (selector, key) => {
      const el = host.querySelector(selector);
      if (!el) return;
      el.addEventListener("change", (e) => {
        filters[key] = e.target.value.trim ? e.target.value.trim() : e.target.value;
        draw();
      });
    };
    bind(".task-filter-assignee", "assignedTo");
    bind(".task-filter-role", "role");
    bind(".task-filter-territory", "territory");
    bind(".task-filter-location", "location");
    bind(".task-filter-wom", "wom");
    bind(".task-filter-vendor", "vendor");
    bind(".task-filter-category", "category");
    bind(".task-filter-due", "dueDate");
    bind(".task-filter-status", "status");
    host.querySelector(".task-filter-category-exclude").addEventListener("change", (e) => {
      filters.categoryExclude = e.target.checked;
      draw();
    });
    host.querySelector(".task-filter-clear").addEventListener("click", () => {
      filters = { assignedTo: "", role: "", location: "", territory: "", wom: "", vendor: "", category: "", categoryExclude: false, dueDate: "", status: "" };
      draw();
    });
  }

  async function openNewTaskModal() {
    const staff = isAdmin ? await loadStaff() : null;
    const people = staff ? [...staff.technicians, ...staff.admins] : [];
    // Both open to any logged-in user (same as the Schedule tab's own
    // location/WOM pickers), independent of the heavier admin-only staff
    // data above, so a technician linking their own task to a WOM isn't
    // blocked on admin access.
    const { woms: allWoms, locations: allLocations, locationNameByCode } = await loadWomLocationData();
    const { body, close } = openModal({
      title: "New Task",
      size: "large",
      bodyHtml: `
        <form class="modal-form task-new-form">
          <h4>What</h4>
          <label class="profile-field"><span>Title</span><input class="task-new-title" type="text" required /></label>
          <label class="profile-field"><span>Description</span><textarea class="task-new-desc" rows="2"></textarea></label>
          <div class="task-new-category-field">
            <label class="profile-field"><span>Type</span>
              <select class="task-new-category">
                ${MANUAL_CATEGORY_OPTIONS.map((k) => `<option value="${k}" ${k === "manual" ? "selected" : ""}>${escapeHtml(CATEGORY_LABELS[k])}</option>`).join("")}
              </select>
            </label>
            ${
              isAdmin
                ? `
              <label class="profile-field task-new-onboarding-for-field" hidden>
                <span>Onboarding for</span>
                <select class="task-new-onboarding-for">
                  <option value="">Choose one...</option>
                  <option value="vendor">Vendor</option>
                  <option value="employee">New Employee</option>
                </select>
              </label>
            `
                : ""
            }
          </div>

          <h4>When</h4>
          <label class="task-new-repeats-label">
            <input type="checkbox" class="task-new-repeats" /> Repeats on specific days of the week
          </label>
          <div class="task-new-once-fields">
            <div class="vendor-edit-grid">
              <label class="profile-field"><span>Priority</span>
                <select class="task-new-priority">
                  ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === "normal" ? "selected" : ""}>${l}</option>`).join("")}
                </select>
              </label>
              <label class="profile-field"><span>Due date</span><input class="task-new-due" type="date" /></label>
              <label class="profile-field"><span>Due time (optional)</span><input class="task-new-due-time" type="time" /></label>
            </div>
          </div>
          <div class="task-new-recurring-fields" hidden>
            <p class="review-checklist-hint">
              Creates a task automatically on each day checked, every week, starting today if today is
              one of them -- no separate task to keep re-adding by hand.
            </p>
            <div class="task-new-weekday-picker">
              ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                .map((label, i) => `<label class="task-new-weekday"><input type="checkbox" value="${i}" /> ${label}</label>`)
                .join("")}
            </div>
            <div class="vendor-edit-grid">
              <label class="profile-field"><span>Priority</span>
                <select class="task-new-priority-recurring">
                  ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === "normal" ? "selected" : ""}>${l}</option>`).join("")}
                </select>
              </label>
              <label class="profile-field"><span>Due time each day (optional)</span><input class="task-new-recurring-time" type="time" /></label>
            </div>
          </div>

          ${
            isAdmin
              ? `
            <h4>Who</h4>
            <div class="vendor-edit-grid">
              <label class="profile-field"><span>Assign to</span>
                <select class="task-new-assignee">
                  <option value="">Unassigned</option>
                  ${people.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
                </select>
              </label>
              <label class="profile-field"><span>Role queue</span>
                <select class="task-new-role">
                  <option value="">No role queue</option>
                  ${["admin", "reviewer", "tech"].map((r) => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join("")}
                </select>
              </label>
            </div>
          `
              : ""
          }

          <h4>Related</h4>
          <label class="task-new-relate-toggle">
            <input type="checkbox" class="task-new-wom-toggle" /> Related to a WOM
          </label>
          <div class="task-new-wom-field" hidden>
            <div class="vendor-edit-grid">
              <label class="profile-field"><span>Location</span>
                <select class="task-new-wom-location">
                  <option value="">All locations</option>
                  ${allLocations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("")}
                </select>
              </label>
              <label class="profile-field"><span>WOM</span>
                <select class="task-new-wom-select"></select>
              </label>
            </div>
          </div>
          ${
            isAdmin
              ? `
            <div class="task-new-vendor-section">
              <label class="task-new-relate-toggle">
                <input type="checkbox" class="task-new-vendor-toggle" /> Related to a Vendor
              </label>
              <div class="task-new-vendor-field task-new-related-field" hidden>
                <div class="task-new-vendor-picked task-new-related-picked" hidden>
                  <span class="task-new-vendor-picked-name"></span>
                  <button type="button" class="btn btn-link task-new-vendor-clear">Change</button>
                </div>
                <input class="task-new-vendor-search" type="text" placeholder="Search vendor name to link this task to their profile..." />
                <div class="task-new-vendor-results"></div>
              </div>
            </div>
            <div class="task-new-employee-section">
              <label class="task-new-relate-toggle">
                <input type="checkbox" class="task-new-employee-toggle" /> Related to an Employee
              </label>
              <div class="task-new-employee-field task-new-related-field" hidden>
                <div class="task-new-employee-picked task-new-related-picked" hidden>
                  <span class="task-new-employee-picked-name"></span>
                  <button type="button" class="btn btn-link task-new-employee-clear">Change</button>
                </div>
                <input class="task-new-employee-search" type="text" placeholder="Search employee name to link this task to their profile..." />
                <div class="task-new-employee-results"></div>
              </div>
            </div>
          `
              : ""
          }

          <div class="task-new-attachment-section">
            <h4>Attachment</h4>
            <p class="review-checklist-hint">
              A document that came with this task (a form Kevin sent, a COI that just arrived) --
              once the task is created, its Details panel can move this same file onto an employee's
              or vendor's own record once you know which one it belongs to, without re-uploading it.
            </p>
            <div class="vendor-edit-grid">
              <label class="profile-field"><span>Category</span>
                <select class="task-new-attachment-category">
                  ${TASK_DOC_CATEGORIES.map((c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`).join("")}
                </select>
              </label>
              <label class="profile-field"><span>File (optional)</span><input class="task-new-attachment-file" type="file" /></label>
            </div>
          </div>

          <div class="modal-form-actions">
            <button class="btn btn-primary task-new-save" type="submit">Create task</button>
          </div>
          <div class="task-new-error"></div>
        </form>
      `,
    });

    const repeatsToggle = body.querySelector(".task-new-repeats");
    const onceFields = body.querySelector(".task-new-once-fields");
    const recurringFields = body.querySelector(".task-new-recurring-fields");
    const attachmentSection = body.querySelector(".task-new-attachment-section");
    const categoryField = body.querySelector(".task-new-category-field");
    const vendorSection = body.querySelector(".task-new-vendor-section");
    repeatsToggle.addEventListener("change", () => {
      onceFields.hidden = repeatsToggle.checked;
      recurringFields.hidden = !repeatsToggle.checked;
      // A recurring task is a template, not a single task row, until its
      // first occurrence exists -- keeping attachment out of that gap
      // avoids either silently dropping the file or attaching it to a
      // template that isn't itself a real, addressable task. Same reasoning
      // for type/vendor: a recurring occurrence always lands in its own
      // Recurring section regardless of what's picked here, so hide fields
      // that a recurring task wouldn't actually use. (Related WOM stays
      // visible either way -- a recurring template does carry it through.)
      attachmentSection.hidden = repeatsToggle.checked;
      categoryField.hidden = repeatsToggle.checked;
      if (vendorSection) {
        vendorSection.hidden = repeatsToggle.checked;
        body.querySelector(".task-new-employee-section").hidden = repeatsToggle.checked;
      }
    });

    const womToggle = body.querySelector(".task-new-wom-toggle");
    const womField = body.querySelector(".task-new-wom-field");
    const womLocationSelect = body.querySelector(".task-new-wom-location");
    const womSelect = body.querySelector(".task-new-wom-select");
    function refreshWomOptions() {
      const loc = womLocationSelect.value;
      const options = loc ? allWoms.filter((w) => w.locationCode === loc) : allWoms;
      womSelect.innerHTML =
        `<option value="">Select a WOM...</option>` +
        options
          .map((w) => {
            const locName = w.locationCode ? locationNameByCode[w.locationCode] || w.locationCode : "no location";
            return `<option value="${escapeHtml(w.code)}">${escapeHtml(w.code)} -- ${escapeHtml(w.description || "")} (${escapeHtml(locName)})</option>`;
          })
          .join("");
    }
    refreshWomOptions();
    womLocationSelect.addEventListener("change", refreshWomOptions);
    womToggle.addEventListener("change", () => {
      womField.hidden = !womToggle.checked;
      if (!womToggle.checked) {
        womLocationSelect.value = "";
        womSelect.value = "";
        refreshWomOptions();
      }
    });

    let vendorPicker = null;
    let employeePicker = null;
    if (isAdmin && vendorSection) {
      vendorPicker = wireRelatedPicker(vendorSection, staff.vendors, "vendor", "vendor");
      const employeeSection = body.querySelector(".task-new-employee-section");
      employeePicker = wireRelatedPicker(employeeSection, staff.technicians, "employee", "employee");

      // "Onboarding" covers both a new vendor and a new hire -- this sub-
      // pick just saves the extra click of finding and checking the right
      // Related toggle yourself once you've already said what Type this is.
      const categorySelect = body.querySelector(".task-new-category");
      const onboardingForField = body.querySelector(".task-new-onboarding-for-field");
      const onboardingForSelect = body.querySelector(".task-new-onboarding-for");
      categorySelect.addEventListener("change", () => {
        onboardingForField.hidden = categorySelect.value !== "onboarding";
      });
      onboardingForSelect.addEventListener("change", () => {
        if (onboardingForSelect.value === "vendor") vendorPicker.checkAndOpen();
        else if (onboardingForSelect.value === "employee") employeePicker.checkAndOpen();
      });
    }

    const form = body.querySelector(".task-new-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = body.querySelector(".task-new-error");
      errorEl.innerHTML = "";
      const title = body.querySelector(".task-new-title").value.trim();
      if (!title) {
        errorEl.innerHTML = `<p class="attachments-error">Title is required.</p>`;
        return;
      }

      const base = {
        title,
        description: body.querySelector(".task-new-desc").value.trim(),
        category: body.querySelector(".task-new-category").value,
        relatedWomCode: womToggle.checked ? body.querySelector(".task-new-wom-select").value || null : null,
        relatedVendorId: vendorPicker ? vendorPicker.getId() : null,
        relatedTechId: employeePicker ? employeePicker.getId() : null,
      };
      if (isAdmin) {
        base.assignedTo = body.querySelector(".task-new-assignee").value || null;
        base.assignedRole = body.querySelector(".task-new-role").value || null;
      }

      const file = body.querySelector(".task-new-attachment-file").files[0];
      const category = body.querySelector(".task-new-attachment-category").value;

      try {
        if (repeatsToggle.checked) {
          const recurrenceDays = Array.from(body.querySelectorAll(".task-new-weekday input:checked")).map((el) => Number(el.value));
          if (recurrenceDays.length === 0) {
            errorEl.innerHTML = `<p class="attachments-error">Pick at least one day of the week.</p>`;
            return;
          }
          const res = await api.post("/api/tasks", {
            ...base,
            recurring: true,
            recurrenceDays,
            priority: body.querySelector(".task-new-priority-recurring").value,
            dueTime: body.querySelector(".task-new-recurring-time").value || null,
          });
          if (!res.todayTask) {
            window.alert(
              "Recurring task saved. Today isn't one of the selected days, so the first occurrence will appear on its own on the next matching day."
            );
          }
        } else {
          const newTask = await api.post("/api/tasks", {
            ...base,
            priority: body.querySelector(".task-new-priority").value,
            dueAt: body.querySelector(".task-new-due").value || null,
            dueTime: body.querySelector(".task-new-due-time").value || null,
          });
          if (file) await api.uploadFile("task", newTask.id, category, file);
        }
        close();
        await draw();
      } catch (err) {
        errorEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  function renderTaskList(host, tasks) {
    if (tasks.length === 0) {
      host.innerHTML = `<p class="empty-note">Nothing here.</p>`;
      return;
    }
    host.innerHTML = "";
    // Grouped into the same order/colors every time a given mode is active
    // (not just whichever groups happen to appear in this particular view),
    // so a group's position stays predictable to scan for -- an empty group
    // is simply skipped rather than reordering the rest. See groupTasks for
    // what each mode (Type/Assignee/Priority/Due Date/None) actually does.
    for (const group of groupTasks(tasks, groupBy)) {
      if (group.label) {
        const heading = document.createElement("div");
        heading.className = `task-section-heading ${group.colorClass}`;
        heading.innerHTML = `<span>${escapeHtml(group.label)}</span><span class="task-section-count">${group.items.length}</span>`;
        host.appendChild(heading);
      }
      group.items.forEach((t) => host.appendChild(renderTaskCard(t, group.colorClass)));
    }
    renderBulkToolbar(container.querySelector("#task-bulk-toolbar"));
  }

  // The bulk-action bar above the list -- only ever shown once at least one
  // row is checked. Every action loops the same per-task endpoints the
  // single-task UI already uses (no new bulk backend route), then redraws.
  function renderBulkToolbar(toolbarEl) {
    if (!toolbarEl) return;
    if (selectedTaskIds.size === 0) {
      toolbarEl.innerHTML = "";
      return;
    }
    toolbarEl.innerHTML = `
      <span class="task-bulk-count">${selectedTaskIds.size} selected</span>
      <button class="btn btn-secondary task-bulk-complete" type="button">Mark complete</button>
      <button class="btn btn-secondary task-bulk-cancel" type="button">Cancel</button>
      <select class="task-bulk-priority">
        <option value="">Set priority...</option>
        ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <button class="btn btn-secondary task-bulk-priority-apply" type="button">Apply</button>
      <select class="task-bulk-assignee"><option value="">Reassign to...</option></select>
      <button class="btn btn-secondary task-bulk-assignee-apply" type="button">Apply</button>
      <button class="btn btn-link task-bulk-clear" type="button">Clear selection</button>
    `;
    loadStaff().then((staff) => {
      if (!staff) return;
      const people = [...staff.technicians, ...staff.admins];
      const sel = toolbarEl.querySelector(".task-bulk-assignee");
      if (sel) sel.innerHTML = `<option value="">Reassign to...</option>` + people.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    });

    async function runBulk(fn, ids = [...selectedTaskIds]) {
      await Promise.all(ids.map(fn));
      await draw();
    }
    // A WOM lifecycle task's status is derived from its own checklist, not
    // settable by hand (see the server-side guard on PATCH /:id/status) --
    // force-completing or cancelling one here would freeze it with real
    // steps (Review charges, Invoice) still unchecked and no way back.
    // Skip any selected before running, so the rest of the batch still goes
    // through instead of the whole click failing on the first rejected one.
    function splitOutLifecycleTasks() {
      const ids = [...selectedTaskIds];
      const lifecycleIds = ids.filter((id) => (lastTasks.find((t) => t.id === id) || {}).category === "wom_workflow");
      const rest = ids.filter((id) => !lifecycleIds.includes(id));
      if (lifecycleIds.length) {
        window.alert(
          `${lifecycleIds.length} WOM lifecycle task(s) were skipped -- these only complete by finishing their own checklist. Use Reschedule on the task itself to defer one instead.`
        );
      }
      return rest;
    }
    toolbarEl.querySelector(".task-bulk-complete").addEventListener("click", () => {
      const ids = splitOutLifecycleTasks();
      if (ids.length) runBulk((id) => api.patch(`/api/tasks/${id}/status`, { status: "completed" }), ids);
    });
    toolbarEl.querySelector(".task-bulk-cancel").addEventListener("click", () => {
      const ids = splitOutLifecycleTasks();
      if (ids.length) runBulk((id) => api.patch(`/api/tasks/${id}/status`, { status: "cancelled" }), ids);
    });
    toolbarEl.querySelector(".task-bulk-priority-apply").addEventListener("click", () => {
      const priority = toolbarEl.querySelector(".task-bulk-priority").value;
      if (!priority) return;
      runBulk((id) => api.patch(`/api/tasks/${id}`, { priority }));
    });
    toolbarEl.querySelector(".task-bulk-assignee-apply").addEventListener("click", () => {
      const assignedTo = toolbarEl.querySelector(".task-bulk-assignee").value;
      if (!assignedTo) return;
      runBulk((id) => api.patch(`/api/tasks/${id}/assign`, { assignedTo }));
    });
    toolbarEl.querySelector(".task-bulk-clear").addEventListener("click", () => {
      selectedTaskIds.clear();
      container.querySelectorAll(".task-select-checkbox").forEach((cb) => (cb.checked = false));
      renderBulkToolbar(toolbarEl);
    });
  }

  function renderTaskCard(t, sectionColorClass) {
    const row = document.createElement("div");
    const rowGapClass = t.isChangeOrder ? " task-card-change-order" : t.isException ? " task-card-po-gap" : "";
    row.className = `review-row task-card ${sectionColorClass || ""}${rowGapClass}${t.urgency === "emergency" ? " task-card-emergency" : ""}`;
    const contextBits = [];
    if (t.relatedWomCode) contextBits.push(`WOM ${escapeHtml(t.relatedWomCode)}${t.relatedWomDescription ? ` — ${escapeHtml(t.relatedWomDescription)}` : ""}`);
    if (t.relatedVendorName) contextBits.push(escapeHtml(t.relatedVendorName));
    if (t.relatedTechName) contextBits.push(escapeHtml(t.relatedTechName));
    if (t.relatedLocationName) contextBits.push(escapeHtml(t.relatedLocationName));
    const assignee = t.assignedToName || (t.assignedRole ? `Unclaimed — ${ROLE_LABELS[t.assignedRole] || t.assignedRole}` : "Unassigned");
    // "Unclaimed" used to be a dead end -- it explained the state but gave
    // no way to change it short of the bulk-select toolbar (check a box,
    // open the toolbar, pick a name, Apply), which nobody's going to do for
    // a single task. Any admin can claim any admin-bucket task (admin can
    // already act on all of them regardless of role -- see canSeeTask), a
    // tech can only claim their own tech-bucket one.
    const canClaim = !t.assignedToName && t.assignedRole && (isAdmin ? t.assignedRole !== "tech" : t.assignedRole === "tech");
    const badgeLabel = t.urgency === "done" ? STATUS_LABELS[t.status] : PRIORITY_LABELS[t.priority];
    // A closed task's due date is just history, not a live countdown -- no
    // "3 days overdue" red text on something already done.
    const dueInfo = ["completed", "cancelled"].includes(t.status)
      ? { text: t.dueAt ? `was due ${formatDate(t.dueAt)}` : "no due date", cls: "" }
      : formatRelativeDue(t.dueAt);
    const ageLabel = t.ageDays <= 0 ? "opened today" : `opened ${t.ageDays}d ago`;

    row.innerHTML = `
      <div class="review-row-summary">
        ${isAdmin ? `<input type="checkbox" class="task-select-checkbox" data-id="${t.id}" />` : ""}
        <span class="review-row-name">
          ${t.isChangeOrder ? `<span class="task-exception-flag" title="A real cost overage -- Toyota needs to sign off on a change order">🚩</span>` : ""}${escapeHtml(t.title)}
        </span>
        <span class="badge badge-${URGENCY_BADGE_CLASS[t.urgency] || "draft"}">${escapeHtml(badgeLabel)}</span>
        <button class="btn btn-link task-detail-toggle" type="button">Details</button>
        ${contextBits.length ? `<div class="chip-row task-card-chips">${contextBits.map((c) => `<span class="chip">${c}</span>`).join("")}</div>` : ""}
        <span class="task-card-meta">${escapeHtml(assignee)}${canClaim ? ` <button class="btn btn-link task-claim-btn" type="button" data-id="${t.id}">Claim</button>` : ""} &middot; <span class="${dueInfo.cls}">${escapeHtml(dueInfo.text)}</span> &middot; ${ageLabel}${t.snoozedUntil ? ` &middot; <span class="task-due-soon">snoozed until ${escapeHtml(formatDate(t.snoozedUntil))}</span>` : ""}</span>
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
    const checkbox = row.querySelector(".task-select-checkbox");
    if (checkbox) {
      checkbox.checked = selectedTaskIds.has(t.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedTaskIds.add(t.id);
        else selectedTaskIds.delete(t.id);
        renderBulkToolbar(container.querySelector("#task-bulk-toolbar"));
      });
    }
    const claimBtn = row.querySelector(".task-claim-btn");
    if (claimBtn) {
      claimBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        claimBtn.disabled = true;
        try {
          await api.patch(`/api/tasks/${t.id}/assign`, { assignedTo: state.user.id });
          await draw();
        } catch (err) {
          claimBtn.disabled = false;
          window.alert(err.message);
        }
      });
    }
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

    // A live-state explanation for a WOM-workflow task (which pipeline
    // stage it's currently at) -- not itself a timestamped event, so it
    // stays a separate hint above the activity feed rather than an entry
    // in it. A manual/other-generated task has nothing extra to explain
    // here; the feed's own first entry ("X added this task") covers it.
    const nextStepForDisplay = wom && wom.lifecycleSteps ? nextLifecycleStep(wom.lifecycleSteps) : null;
    const why = nextStepForDisplay
      ? `Part of the WOM lifecycle checklist for ${escapeHtml(t.relatedWomCode)} -- next up: "${escapeHtml(nextStepForDisplay.label)}."`
      : null;
    // Editing is for a task someone actually typed in by hand -- an
    // automated WOM-workflow task's fields are that workflow's own source
    // of truth and would just get overwritten by the next sync/action, so
    // only its real action (below) and status apply to it, never a title
    // edit. An admin can edit anyone's hand-added task; a non-admin only
    // their own.
    const canEdit = t.source === "manual" && (isAdmin || t.createdBy === state.user.id);
    const snoozedActive = t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now();

    host.innerHTML = `
      ${t.description ? `<p>${escapeHtml(t.description)}</p>` : ""}
      <p class="review-checklist-hint">
        ${why ? `${why} ` : ""}${wom && wom.smartsheetData ? `<button class="btn btn-link task-smartsheet-detail-btn" type="button">Smartsheet detail</button> ` : ""}${canEdit ? `<button class="btn btn-link task-edit-toggle" type="button">Edit</button>` : ""}
      </p>
      ${canEdit ? `<div class="task-edit-host" hidden></div>` : ""}
      ${
        isAdmin
          ? snoozedActive
            ? `<p class="task-snooze-banner">Snoozed until ${escapeHtml(formatDate(t.snoozedUntil))} -- hidden from your other lists until then.
                <button class="btn btn-link task-unsnooze-btn" type="button">Bring back now</button></p>`
            : `<p class="review-checklist-hint"><button class="btn btn-link task-reschedule-toggle" type="button">Reschedule</button></p>`
          : ""
      }
      ${isAdmin ? `<div class="task-reschedule-host" hidden></div>` : ""}
      ${isAdmin ? `<p class="review-checklist-hint"><button class="btn btn-link task-assign-toggle" type="button">Assign</button></p>` : ""}
      ${isAdmin ? `<div class="task-assign-host" hidden></div>` : ""}
      <div class="task-pse-actions"></div>
      <div class="review-actions task-status-actions"></div>
      ${isAdmin ? `<div class="task-attachments"></div>` : ""}
      ${
        isAdmin && t.rescheduleNotes.length > 0
          ? `<h5 class="task-activity-heading">Status Notes</h5>
             <div class="task-reschedule-notes">
               ${t.rescheduleNotes
                 .map(
                   (r) =>
                     `<div class="task-reschedule-note"><strong>${escapeHtml(r.createdByName)}</strong> -- snoozed to ${escapeHtml(
                       formatDate(r.snoozedUntil)
                     )} <span class="task-card-meta">(${escapeHtml(formatDateTime(r.createdAt))})</span><div>${escapeHtml(r.note)}</div></div>`
                 )
                 .join("")}
             </div>`
          : ""
      }
      <h5 class="task-activity-heading">Activity</h5>
      <div class="task-activity"></div>
      <div class="task-comment-form"></div>
    `;

    const smartsheetDetailBtn = host.querySelector(".task-smartsheet-detail-btn");
    if (smartsheetDetailBtn) {
      smartsheetDetailBtn.addEventListener("click", () => {
        const rows = Object.entries(wom.smartsheetData)
          .filter(([key]) => key !== "__smartsheetRowId")
          .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value == null || value === "" ? "—" : String(value))}</td></tr>`)
          .join("");
        openModal({
          title: `Smartsheet Detail — ${wom.code}`,
          size: "large",
          bodyHtml: `
            <table class="detail-table wom-smartsheet-table">
              <thead><tr><th>Column</th><th>Value</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          `,
        });
      });
    }

    if (canEdit) {
      const editToggle = host.querySelector(".task-edit-toggle");
      const editHost = host.querySelector(".task-edit-host");
      let editLoaded = false;
      editToggle.addEventListener("click", async () => {
        const opening = editHost.hidden;
        editHost.hidden = !opening;
        editToggle.textContent = opening ? "Cancel" : "Edit";
        if (opening && !editLoaded) {
          editLoaded = true;
          await renderTaskEditForm(editHost, t, () => {
            editHost.hidden = true;
            editToggle.textContent = "Edit";
          });
        }
      });
    }

    if (isAdmin) {
      const rescheduleToggle = host.querySelector(".task-reschedule-toggle");
      const rescheduleHost = host.querySelector(".task-reschedule-host");
      if (rescheduleToggle && rescheduleHost) {
        let rescheduleLoaded = false;
        rescheduleToggle.addEventListener("click", () => {
          const opening = rescheduleHost.hidden;
          rescheduleHost.hidden = !opening;
          rescheduleToggle.textContent = opening ? "Cancel" : "Reschedule";
          if (opening && !rescheduleLoaded) {
            rescheduleLoaded = true;
            renderRescheduleForm(rescheduleHost, t, () => draw());
          }
        });
      }
      const unsnoozeBtn = host.querySelector(".task-unsnooze-btn");
      if (unsnoozeBtn) {
        unsnoozeBtn.addEventListener("click", async () => {
          unsnoozeBtn.disabled = true;
          try {
            await api.post(`/api/tasks/${t.id}/unsnooze`, {});
            await draw();
          } catch (err) {
            unsnoozeBtn.disabled = false;
            window.alert(err.message);
          }
        });
      }
      const assignToggle = host.querySelector(".task-assign-toggle");
      const assignHost = host.querySelector(".task-assign-host");
      if (assignToggle && assignHost) {
        let assignLoaded = false;
        assignToggle.addEventListener("click", async () => {
          const opening = assignHost.hidden;
          assignHost.hidden = !opening;
          assignToggle.textContent = opening ? "Cancel" : "Assign";
          if (opening && !assignLoaded) {
            assignLoaded = true;
            await renderAssignForm(assignHost, t, () => draw());
          }
        });
      }
    }

    const tookOverStatus = wom && (await renderPseActions(host.querySelector(".task-pse-actions"), t, wom));
    if (!tookOverStatus) renderStatusActions(host.querySelector(".task-status-actions"), t);
    if (isAdmin) {
      await renderAttachments(host.querySelector(".task-attachments"), {
        title: "Documents (not filed to a vendor)",
        relatedType: "task",
        relatedId: t.id,
        categories: TASK_DOC_CATEGORIES,
        canUpload: true,
        emptyText: "No documents attached to this task yet.",
      });
    }
    renderActivityFeed(host.querySelector(".task-activity"), t);
    renderCommentForm(host.querySelector(".task-comment-form"), t.id, host);
  }

  // The edit form for a hand-added task -- same What/Related shape as New
  // Task (Type, priority, due date, WOM, and for an admin, Vendor/Employee),
  // minus recurring and attachment (a task already has both, once created).
  // PATCHes /api/tasks/:id and re-draws the whole board on save, since a
  // title change needs to show up on the outer card too, not just here.
  async function renderTaskEditForm(host, t, onCancel) {
    const { woms: allWoms, locations: allLocations, locationNameByCode } = await loadWomLocationData();
    const dueDateVal = t.dueAt ? t.dueAt.slice(0, 10) : "";
    const dueTimeVal = t.dueAt && t.dueAt.length > 10 ? t.dueAt.slice(11, 16) : "";
    const initialWomLocation = t.relatedWomCode ? (allWoms.find((w) => w.code === t.relatedWomCode) || {}).locationCode || "" : "";

    host.innerHTML = `
      <form class="modal-form task-edit-form">
        <label class="profile-field"><span>Title</span><input class="task-edit-title" type="text" value="${escapeHtml(t.title)}" required /></label>
        <label class="profile-field"><span>Description</span><textarea class="task-edit-desc" rows="2">${escapeHtml(t.description || "")}</textarea></label>
        <div class="vendor-edit-grid">
          <label class="profile-field"><span>Type</span>
            <select class="task-edit-category">
              ${MANUAL_CATEGORY_OPTIONS.map((k) => `<option value="${k}" ${k === t.category ? "selected" : ""}>${escapeHtml(CATEGORY_LABELS[k])}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field"><span>Priority</span>
            <select class="task-edit-priority">
              ${Object.entries(PRIORITY_LABELS).map(([k, l]) => `<option value="${k}" ${k === t.priority ? "selected" : ""}>${l}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field"><span>Due date</span><input class="task-edit-due" type="date" value="${dueDateVal}" /></label>
          <label class="profile-field"><span>Due time</span><input class="task-edit-due-time" type="time" value="${dueTimeVal}" /></label>
        </div>

        <label class="task-new-relate-toggle">
          <input type="checkbox" class="task-new-wom-toggle" ${t.relatedWomCode ? "checked" : ""} /> Related to a WOM
        </label>
        <div class="task-new-wom-field" ${t.relatedWomCode ? "" : "hidden"}>
          <div class="vendor-edit-grid">
            <label class="profile-field"><span>Location</span>
              <select class="task-new-wom-location">
                <option value="">All locations</option>
                ${allLocations.map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === initialWomLocation ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}
              </select>
            </label>
            <label class="profile-field"><span>WOM</span><select class="task-new-wom-select"></select></label>
          </div>
        </div>
        ${
          isAdmin
            ? `
          <div class="task-new-vendor-section">
            <label class="task-new-relate-toggle"><input type="checkbox" class="task-new-vendor-toggle" /> Related to a Vendor</label>
            <div class="task-new-vendor-field task-new-related-field" hidden>
              <div class="task-new-vendor-picked task-new-related-picked" hidden>
                <span class="task-new-vendor-picked-name"></span>
                <button type="button" class="btn btn-link task-new-vendor-clear">Change</button>
              </div>
              <input class="task-new-vendor-search" type="text" placeholder="Search vendor name..." />
              <div class="task-new-vendor-results"></div>
            </div>
          </div>
          <div class="task-new-employee-section">
            <label class="task-new-relate-toggle"><input type="checkbox" class="task-new-employee-toggle" /> Related to an Employee</label>
            <div class="task-new-employee-field task-new-related-field" hidden>
              <div class="task-new-employee-picked task-new-related-picked" hidden>
                <span class="task-new-employee-picked-name"></span>
                <button type="button" class="btn btn-link task-new-employee-clear">Change</button>
              </div>
              <input class="task-new-employee-search" type="text" placeholder="Search employee name..." />
              <div class="task-new-employee-results"></div>
            </div>
          </div>
        `
            : ""
        }

        <div class="modal-form-actions">
          <button class="btn btn-primary" type="submit">Save changes</button>
          <button class="btn btn-link task-edit-cancel" type="button">Cancel</button>
        </div>
        <div class="task-edit-error"></div>
      </form>
    `;

    const womToggle = host.querySelector(".task-new-wom-toggle");
    const womField = host.querySelector(".task-new-wom-field");
    const womLocationSelect = host.querySelector(".task-new-wom-location");
    const womSelect = host.querySelector(".task-new-wom-select");
    function refreshWomOptions() {
      const loc = womLocationSelect.value;
      const options = loc ? allWoms.filter((w) => w.locationCode === loc) : allWoms;
      womSelect.innerHTML =
        `<option value="">Select a WOM...</option>` +
        options
          .map((w) => {
            const locName = w.locationCode ? locationNameByCode[w.locationCode] || w.locationCode : "no location";
            return `<option value="${escapeHtml(w.code)}" ${w.code === t.relatedWomCode ? "selected" : ""}>${escapeHtml(w.code)} -- ${escapeHtml(w.description || "")} (${escapeHtml(locName)})</option>`;
          })
          .join("");
    }
    refreshWomOptions();
    womLocationSelect.addEventListener("change", refreshWomOptions);
    womToggle.addEventListener("change", () => {
      womField.hidden = !womToggle.checked;
      if (!womToggle.checked) {
        womLocationSelect.value = "";
        refreshWomOptions();
      }
    });

    let vendorPicker = null;
    let employeePicker = null;
    if (isAdmin) {
      const staff = await loadStaff();
      vendorPicker = wireRelatedPicker(
        host.querySelector(".task-new-vendor-section"),
        staff.vendors,
        "vendor",
        "vendor",
        t.relatedVendorId ? { id: t.relatedVendorId, name: t.relatedVendorName } : null
      );
      employeePicker = wireRelatedPicker(
        host.querySelector(".task-new-employee-section"),
        staff.technicians,
        "employee",
        "employee",
        t.relatedTechId ? { id: t.relatedTechId, name: t.relatedTechName } : null
      );
    }

    host.querySelector(".task-edit-cancel").addEventListener("click", onCancel);
    host.querySelector(".task-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = host.querySelector(".task-edit-error");
      errorEl.innerHTML = "";
      const title = host.querySelector(".task-edit-title").value.trim();
      if (!title) {
        errorEl.innerHTML = `<p class="attachments-error">Title is required.</p>`;
        return;
      }
      try {
        await api.patch(`/api/tasks/${t.id}`, {
          title,
          description: host.querySelector(".task-edit-desc").value.trim(),
          category: host.querySelector(".task-edit-category").value,
          priority: host.querySelector(".task-edit-priority").value,
          dueAt: host.querySelector(".task-edit-due").value || null,
          dueTime: host.querySelector(".task-edit-due-time").value || null,
          relatedWomCode: womToggle.checked ? womSelect.value || null : null,
          relatedVendorId: vendorPicker ? vendorPicker.getId() : null,
          relatedTechId: employeePicker ? employeePicker.getId() : null,
        });
        await draw();
      } catch (err) {
        errorEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  // "Reschedule" on a WOM-lifecycle task pending Toyota paperwork: RFM logs
  // what's actually been confirmed so far (a dedicated note, not mixed into
  // the Activity feed -- it's a standing status, not a one-off comment) and
  // picks a follow-up date. The task is fully hidden from every other view
  // until that date, and resurfaces automatically in the admin-only Upcoming
  // tab -- or immediately, via "Bring back now" on the task itself.
  // Assigning used to mean checking a box and going through the bulk-select
  // toolbar even for a single task -- this is that same PATCH
  // (/api/tasks/:id/assign), reachable directly from the task someone's
  // actually looking at. Assigning to a person always wins over whatever
  // role queue it was sitting in; "Back to role queue" clears the person
  // without guessing which role to put it back in, since the server already
  // knows (assignedRole is untouched -- only assignedTo is cleared).
  async function renderAssignForm(host, t, onDone) {
    const staff = await loadStaff();
    const people = [...staff.technicians, ...staff.admins];
    host.innerHTML = `
      <form class="modal-form task-assign-form">
        <label class="profile-field">
          <span>Assign to</span>
          <select class="task-assign-select">
            <option value="">-- Select a person --</option>
            ${people.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === t.assignedTo ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
          </select>
        </label>
        <div class="modal-form-actions">
          <button class="btn btn-primary" type="submit">Assign</button>
          ${t.assignedTo ? `<button class="btn btn-link task-assign-clear" type="button">Back to role queue</button>` : ""}
          <button class="btn btn-link task-assign-cancel" type="button">Cancel</button>
        </div>
        <div class="task-assign-error"></div>
      </form>
    `;
    host.querySelector(".task-assign-cancel").addEventListener("click", () => {
      host.hidden = true;
      const toggle = host.parentElement.querySelector(".task-assign-toggle");
      if (toggle) toggle.textContent = "Assign";
    });
    const clearBtn = host.querySelector(".task-assign-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        try {
          await api.patch(`/api/tasks/${t.id}/assign`, { assignedTo: null });
          await onDone();
        } catch (err) {
          host.querySelector(".task-assign-error").innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
        }
      });
    }
    host.querySelector(".task-assign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = host.querySelector(".task-assign-error");
      errorEl.innerHTML = "";
      const assignedTo = host.querySelector(".task-assign-select").value;
      if (!assignedTo) {
        errorEl.innerHTML = `<p class="attachments-error">Pick a person to assign to.</p>`;
        return;
      }
      try {
        await api.patch(`/api/tasks/${t.id}/assign`, { assignedTo });
        await onDone();
      } catch (err) {
        errorEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  function renderRescheduleForm(host, t, onDone) {
    const defaultDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    host.innerHTML = `
      <form class="modal-form task-reschedule-form">
        <label class="profile-field"><span>Follow up on</span><input class="task-reschedule-date" type="date" value="${defaultDate}" required /></label>
        <label class="profile-field"><span>Status note</span><textarea class="task-reschedule-note" rows="3" placeholder="e.g. Labor and vendor $ posted, still waiting on expenses." required></textarea></label>
        <div class="modal-form-actions">
          <button class="btn btn-primary" type="submit">Reschedule</button>
          <button class="btn btn-link task-reschedule-cancel" type="button">Cancel</button>
        </div>
        <div class="task-reschedule-error"></div>
      </form>
    `;
    host.querySelector(".task-reschedule-cancel").addEventListener("click", () => {
      host.hidden = true;
      const toggle = host.parentElement.querySelector(".task-reschedule-toggle");
      if (toggle) toggle.textContent = "Reschedule";
    });
    host.querySelector(".task-reschedule-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = host.querySelector(".task-reschedule-error");
      errorEl.innerHTML = "";
      const note = host.querySelector(".task-reschedule-note").value.trim();
      const dateVal = host.querySelector(".task-reschedule-date").value;
      if (!note) {
        errorEl.innerHTML = `<p class="attachments-error">A status note is required.</p>`;
        return;
      }
      if (!dateVal) {
        errorEl.innerHTML = `<p class="attachments-error">A follow-up date is required.</p>`;
        return;
      }
      try {
        await api.post(`/api/tasks/${t.id}/reschedule`, {
          note,
          snoozedUntil: new Date(dateVal).toISOString(),
        });
        await onDone();
      } catch (err) {
        errorEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  // Mirrors adminReview.js's own PSE Tasks tab -- "PSE produced -- send to
  // Toyota" is worth a real record of who received it and when, not just
  // a bare button click. Email defaults to whatever was used last time
  // (this browser only, not synced across admins).
  function openPseSentToToyotaModal(womCode, onDone) {
    const lastEmail = localStorage.getItem("laborapp:lastToyotaEmail") || "";
    const today = new Date().toISOString().slice(0, 10);
    const { body, close } = openModal({
      title: `Sent to Toyota -- ${womCode}`,
      bodyHtml: `
        <form class="modal-form pse-sent-form">
          <label class="profile-field"><span>Email it was sent to</span><input type="email" name="toyotaEmail" value="${escapeHtml(lastEmail)}" required /></label>
          <label class="profile-field"><span>Date sent</span><input type="date" name="sentAt" value="${today}" required /></label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Mark sent</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".pse-sent-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        await api.post(`/api/woms/${encodeURIComponent(womCode)}/lifecycle/sent_to_toyota`, {
          toyotaEmail: form.toyotaEmail.value.trim(),
          sentAt: new Date(form.sentAt.value).toISOString(),
        });
        localStorage.setItem("laborapp:lastToyotaEmail", form.toyotaEmail.value.trim());
        close();
        await onDone();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // RFM's (or finance's, once a change order's been referred to them --
  // see openReferChangeOrderToAdminModal) first option on a flagged WOM:
  // proceed with Toyota's own paperwork. Same email+date record as the
  // initial PSE send, just logged against a different lifecycle moment.
  function openRequestToyotaPoModal(womCode, isChangeOrder, onDone) {
    const lastEmail = localStorage.getItem("laborapp:lastToyotaEmail") || "";
    const today = new Date().toISOString().slice(0, 10);
    const { body, close } = openModal({
      title: `Request Toyota PO${isChangeOrder ? " change order" : ""} -- ${womCode}`,
      bodyHtml: `
        <form class="modal-form pse-sent-form">
          <label class="profile-field"><span>Email it was sent to</span><input type="email" name="toyotaEmail" value="${escapeHtml(lastEmail)}" required /></label>
          <label class="profile-field"><span>Date sent</span><input type="date" name="sentAt" value="${today}" required /></label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Mark requested</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".pse-sent-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        await api.post(`/api/woms/${encodeURIComponent(womCode)}/change-order/request-po`, {
          toyotaEmail: form.toyotaEmail.value.trim(),
          sentAt: new Date(form.sentAt.value).toISOString(),
        });
        localStorage.setItem("laborapp:lastToyotaEmail", form.toyotaEmail.value.trim());
        close();
        await onDone();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // RFM's other option on a change order: skip the Toyota paperwork and
  // see if admin can trim labor back under the approved estimate instead.
  // Hands the task to finance's queue (see referWomChangeOrderToAdmin in
  // db.js) rather than closing anything -- it comes back to RFM on its own
  // once the overage actually clears, or sooner if finance decides to
  // request the Toyota PO after all.
  function openReferChangeOrderToAdminModal(womCode, onDone) {
    const { body, close } = openModal({
      title: `Ask admin to reduce labor -- ${womCode}`,
      bodyHtml: `
        <form class="modal-form wom-refer-admin-form">
          <label class="profile-field"><span>Note to admin</span><textarea name="note" rows="3" required placeholder="e.g. Can we trim labor hours to bring this back under the estimate and skip the Toyota change order?"></textarea></label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Send to admin</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".wom-refer-admin-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        await api.post(`/api/woms/${encodeURIComponent(womCode)}/change-order/refer-to-admin`, {
          note: form.note.value.trim(),
        });
        close();
        await onDone();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // The WOM lifecycle checklist, in place of a generic "mark complete" --
  // every step, in order, with a checkmark and when/how it completed for
  // the ones already done, and for whichever step is next: either a plain
  // explanation (an auto-trigger step completes itself once its data
  // changes -- nothing to click) or the real action button/form (a manual
  // step, when the viewer's role matches it). Returns true when it rendered
  // (the caller then skips the generic Start/Waiting/Complete/Cancel
  // buttons, since progress here already tracks real state); false for a
  // WOM lookup that came back with no checklist at all.
  async function renderPseActions(host, t, wom) {
    const steps = wom.lifecycleSteps;
    if (!steps || steps.length === 0) return false;

    let reviewerAdminId = null;
    if (isAdmin) {
      const staff = await loadStaff();
      reviewerAdminId = staff.reviewerAdminId;
    }
    // No reviewer designated yet -- see Roster -> Manage admin accounts --
    // means any admin can take either role for now, same rule the
    // Financials -> PSE Tasks page itself uses.
    const isReviewer = !reviewerAdminId || reviewerAdminId === state.user.id;
    const isFinancial = !reviewerAdminId || reviewerAdminId !== state.user.id;
    const roleAllowed = (role) => role === null || (role === "reviewer" ? isReviewer : isFinancial);

    const rows = steps
      .map((s) => {
        const done = Boolean(s.completedAt);
        const meta = done ? `${s.completedBy === "sync" ? "auto-completed" : "completed"} ${formatDateTime(s.completedAt)}` : "";
        return `
        <div class="wom-lifecycle-step${done ? " wom-lifecycle-step-done" : ""}">
          <span class="wom-lifecycle-step-icon">${done ? "✓" : "○"}</span>
          <span class="wom-lifecycle-step-label">${escapeHtml(s.label)}</span>
          <span class="wom-lifecycle-step-meta">${escapeHtml(meta)}</span>
        </div>`;
      })
      .join("");

    const reviewerNote =
      isAdmin && !reviewerAdminId
        ? `<p class="review-checklist-hint">No RFM is designated yet (Roster &rarr; Manage admin accounts), so any admin can take a step.</p>`
        : "";

    // A real cost overage or a missing Toyota PO is its own decision point
    // for RFM, separate from (and often unrelated to) whichever checklist
    // step the rest of the job happens to be sitting at -- see
    // needsChangeOrderOrPo in db.js. Shows the actual dollar gap plus both
    // ways forward: request the Toyota paperwork now, or (change orders
    // only) hand it to finance to see if labor can be trimmed instead.
    const needsChangeOrderOrPo = t.isChangeOrder || t.isException;
    const gapSection = needsChangeOrderOrPo
      ? `
        <div class="wom-cost-gap">
          <h5 class="task-activity-heading">${t.isChangeOrder ? "Change order -- cost breakdown" : "Missing Toyota PO -- cost breakdown"}</h5>
          ${renderWomCostBreakdown(wom)}
          ${
            t.referredToAdminAt
              ? `<p class="review-checklist-hint">Referred to admin ${escapeHtml(formatDateTime(t.referredToAdminAt))} to see if labor can be trimmed instead -- see Activity below.</p>`
              : ""
          }
          ${
            isAdmin
              ? `<div class="review-actions wom-cost-gap-actions">
                  <button type="button" class="btn btn-secondary wom-request-po-btn">${t.isChangeOrder ? "Request Toyota PO change order" : "Request Toyota PO"}</button>
                  ${
                    t.isChangeOrder && !t.referredToAdminAt
                      ? `<button type="button" class="btn btn-link wom-refer-admin-btn">Ask admin to reduce labor instead</button>`
                      : ""
                  }
                </div>`
              : ""
          }
        </div>
      `
      : "";

    host.innerHTML = `
      ${gapSection}
      ${reviewerNote}
      <div class="wom-lifecycle-checklist">${rows}</div>
      <div class="wom-lifecycle-action"></div>
    `;

    const requestPoBtn = host.querySelector(".wom-request-po-btn");
    if (requestPoBtn) requestPoBtn.addEventListener("click", () => openRequestToyotaPoModal(t.relatedWomCode, t.isChangeOrder, draw));
    const referAdminBtn = host.querySelector(".wom-refer-admin-btn");
    if (referAdminBtn) referAdminBtn.addEventListener("click", () => openReferChangeOrderToAdminModal(t.relatedWomCode, draw));

    const nextStep = nextLifecycleStep(steps);
    const actionHost = host.querySelector(".wom-lifecycle-action");
    if (!nextStep) return true;

    if (nextStep.trigger === "auto") {
      if (WOM_LIFECYCLE_STEP_HINTS[nextStep.key]) {
        actionHost.innerHTML = `<p class="review-checklist-hint">${escapeHtml(WOM_LIFECYCLE_STEP_HINTS[nextStep.key])}</p>`;
      }
      return true;
    }
    if (!isAdmin || !roleAllowed(nextStep.role)) return true;

    if (nextStep.key === "sent_to_toyota") {
      actionHost.innerHTML = `<div class="review-actions"><button type="button" class="btn btn-secondary wom-lifecycle-toyota-btn">PSE produced -- send to Toyota</button></div>`;
      actionHost.querySelector(".wom-lifecycle-toyota-btn").addEventListener("click", () => openPseSentToToyotaModal(t.relatedWomCode, draw));
    } else if (nextStep.key === "charges_reviewed") {
      actionHost.innerHTML = `<div class="review-actions"><button type="button" class="btn btn-secondary wom-lifecycle-reviewed-btn">Mark reviewed</button></div>`;
      actionHost.querySelector(".wom-lifecycle-reviewed-btn").addEventListener("click", async () => {
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/lifecycle/charges_reviewed`, {});
          await draw();
        } catch (err) {
          window.alert(err.message);
        }
      });
    } else if (nextStep.key === "invoiced") {
      actionHost.innerHTML = `
        <form class="modal-form wom-lifecycle-invoice-form">
          <div class="vendor-edit-grid">
            <label class="profile-field"><span>Batch #</span><input class="wom-lifecycle-batch" type="text" required /></label>
            <label class="profile-field"><span>Invoice #</span><input class="wom-lifecycle-invoice" type="text" required /></label>
          </div>
          <button type="submit" class="btn btn-secondary">Invoice</button>
          <span class="save-message"></span>
        </form>
      `;
      actionHost.querySelector(".wom-lifecycle-invoice-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = actionHost.querySelector(".save-message");
        try {
          await api.post(`/api/woms/${encodeURIComponent(t.relatedWomCode)}/lifecycle/invoiced`, {
            batchNumber: actionHost.querySelector(".wom-lifecycle-batch").value.trim(),
            invoiceNumber: actionHost.querySelector(".wom-lifecycle-invoice").value.trim(),
          });
          await draw();
        } catch (err) {
          msg.textContent = err.message;
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

  // One chronological feed instead of a separate "opened/started/completed"
  // sentence plus a disconnected comments list below it -- comments and the
  // real state changes they're about now read in the order they actually
  // happened. Built from timestamps the task already carries (no new
  // backend query); a comment carries authorName/body, an event just text.
  function buildActivityEvents(t) {
    const events = [
      { at: t.createdAt, text: `${escapeHtml(t.createdByName || "Someone")} added this task${t.workflowRule ? " (generated automatically)" : ""}.` },
    ];
    if (t.assignedAt) events.push({ at: t.assignedAt, text: `Assigned to ${escapeHtml(t.assignedToName || ROLE_LABELS[t.assignedRole] || t.assignedRole || "someone")}.` });
    if (t.startedAt) events.push({ at: t.startedAt, text: "Started." });
    if (t.completedAt) events.push({ at: t.completedAt, text: "Marked complete." });
    else if (t.status === "waiting") events.push({ at: t.lastStatusChangeAt, text: "Marked waiting on someone else." });
    else if (t.status === "cancelled") events.push({ at: t.lastStatusChangeAt, text: "Cancelled." });
    for (const c of t.comments || []) events.push({ at: c.createdAt, isComment: true, authorName: c.authorName, body: c.body });
    return events.sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  function renderActivityFeed(host, t) {
    const events = buildActivityEvents(t);
    host.innerHTML = events
      .map((e) =>
        e.isComment
          ? `<p class="task-comment"><strong>${escapeHtml(e.authorName)}:</strong> ${escapeHtml(e.body)} <span class="task-comment-time">${formatDateTime(e.at)}</span></p>`
          : `<p class="task-activity-item">${e.text} <span class="task-comment-time">${formatDateTime(e.at)}</span></p>`
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
      renderActivityFeed(detailHost.querySelector(".task-activity"), t);
      input.value = "";
    });
  }
}
