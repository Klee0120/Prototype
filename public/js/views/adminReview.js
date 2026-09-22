import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { shiftWeek, weekRangeLabel, DAY_NAMES } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";
import { renderTechniciansTab } from "./technicianProfile.js";
import { renderTechWeek } from "./techWeek.js";
import { renderSchedule } from "./schedule.js";
import { COI_MATRIX, COI_MATRIX_BY_LABEL } from "../data/coiMatrix.js";

const STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

const TIME_OFF_LABELS = { vacation: "Vacation", sick: "Sick", bereavement: "Bereavement", holiday: "Holiday" };

function formatMoney(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CW_STATUS_LABELS = { active: "C&W Active", inactive: "C&W Inactive", unknown: "C&W Unknown" };
const TOYOTA_STATUS_LABELS = { approved: "Toyota Approved", not_approved: "Toyota Not Approved", unknown: "Toyota Unknown" };
const FORMS_STATUS_LABELS = { current: "Forms Current", outdated: "Forms Outdated", unknown: "Forms Unknown" };
const WOM_STATUSES = ["pending", "requested", "open", "invoiced", "cancelled", "closed"];
// "pending" = logged on Smartsheet, RFM hasn't asked Toyota for a PO yet.
// "requested" = RFM has asked Toyota (the tracker's own "Date Requested"
// column is filled in), but there's still no real WOM #, so nothing can be
// billed to Toyota yet -- a technician can't charge time to either one, only
// to a real, "open" WOM. Both are set automatically by a Smartsheet sync,
// not by hand. "invoiced" and "closed" are both billed/done -- grouped
// together as one "Invoiced" section below, off the main active list.
// "cancelled" is the other way a job ends, never billed -- its own section,
// also off the main active list. Which of invoiced/cancelled/closed applies
// is always a manual call an admin makes.
const WOM_STATUS_LABELS = {
  pending: "Awaiting RFM request to Toyota",
  requested: "Requested from Toyota (no WOM # yet)",
  open: "Open",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
  closed: "Closed",
};

const VENDOR_STATUS_BADGE_CLASS = {
  active: "approved",
  approved: "approved",
  current: "approved",
  inactive: "rejected",
  not_approved: "rejected",
  outdated: "rejected",
  unknown: "draft",
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function currentMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthIso) {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// A jump-to-any-month picker beats paging Prev/Next one month at a time
// when reports need to be pulled up for a specific past period. The range
// is generous on the past side (reports get filed for a while) and gives
// one year of runway forward; a stored month outside this range (shouldn't
// happen, but cheap to guard) is added in so it's never silently unselectable.
function reportYearOptions(selectedYear) {
  const current = new Date().getFullYear();
  const years = new Set();
  for (let y = current - 6; y <= current + 1; y++) years.add(y);
  years.add(selectedYear);
  return [...years]
    .sort((a, b) => a - b)
    .map((y) => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}</option>`)
    .join("");
}

export async function renderAdminReview(container) {
  let activeTab = "review";
  let allocTechId = null;
  // Which technicians' detail panels are expanded on Weekly Review -- just
  // membership, not a cache of the detail itself, so a stale snapshot can
  // never be shown after something changes it elsewhere (Tech Allocation,
  // another tab, etc.). Detail is always fetched fresh when rendering.
  const expanded = new Set();
  const womsExpanded = new Set();
  const womEditing = new Set();
  const locationEditing = new Set();
  const justSavedUkg = new Set(); // techId -> UKG hours were just saved, show a confirmation
  let laborReportMonth = currentMonthISO();
  let jumpToTech = null; // one-shot deep link into the Technicians tab (e.g. from the expiring-forms banner)

  // Vendors tab: the full list is fetched once per visit and filtered/
  // searched client-side (291+ rows is small enough that refetching on
  // every keystroke would just be wasted network, not a real cache concern).
  let vendorsCache = null;
  const vendorFilters = { search: "", cwStatus: "", toyotaStatus: "", formsStatus: "" };
  const vendorExpanded = new Set();
  let showAddVendorForm = false;
  const vendorRequestEditing = new Set(); // vendor case-log request ids currently showing their edit form

  draw();

  async function draw() {
    const priorityCount = await computePriorityCount();

    container.innerHTML = `
      <div class="tabs">
        <button class="tab ${activeTab === "priorities" ? "active" : ""}" data-tab="priorities">Priorities${priorityCount > 0 ? ` <span class="tab-badge">${priorityCount}</span>` : ""}</button>
        <button class="tab ${activeTab === "techalloc" ? "active" : ""}" data-tab="techalloc">Tech Allocation</button>
        <button class="tab ${activeTab === "schedule" ? "active" : ""}" data-tab="schedule">Schedule</button>
        <button class="tab ${activeTab === "overview" ? "active" : ""}" data-tab="overview">Overview</button>
        <button class="tab ${activeTab === "review" ? "active" : ""}" data-tab="review">Weekly Review</button>
        <button class="tab ${activeTab === "woms" ? "active" : ""}" data-tab="woms">E&amp;F Locations &amp; WOM</button>
        <button class="tab ${activeTab === "technicians" ? "active" : ""}" data-tab="technicians">Technicians</button>
        <button class="tab ${activeTab === "vendors" ? "active" : ""}" data-tab="vendors">Vendors</button>
        <button class="tab ${activeTab === "laborreports" ? "active" : ""}" data-tab="laborreports">Reports</button>
        <button class="tab ${activeTab === "audit" ? "active" : ""}" data-tab="audit">Audit Trail</button>
      </div>
      <div id="tab-content" class="tab-content"></div>
    `;

    container.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        // Coming back to Vendors from somewhere else should start collapsed
        // again -- an "Open" row is a within-visit convenience, not state
        // that should survive switching away and back.
        if (btn.dataset.tab === "vendors" && activeTab !== "vendors") vendorExpanded.clear();
        activeTab = btn.dataset.tab;
        draw();
      });
    });

    const content = container.querySelector("#tab-content");
    if (activeTab === "priorities") await drawPriorities(content);
    else if (activeTab === "techalloc") await drawTechAllocation(content);
    else if (activeTab === "schedule") await renderSchedule(content);
    else if (activeTab === "overview") await drawOverview(content);
    else if (activeTab === "review") await drawReview(content);
    else if (activeTab === "woms") await drawWoms(content);
    else if (activeTab === "technicians") {
      renderTechniciansTab(content, jumpToTech);
      jumpToTech = null;
    }
    else if (activeTab === "vendors") await drawVendors(content);
    else if (activeTab === "laborreports") await drawLaborReports(content);
    else await drawAudit(content);
  }

  // Four report kinds (WOM, Labor, Financial, GL), filed by month/year and
  // each kept in its own section (in this fixed order) so a given kind's
  // history reads top-to-bottom without hunting through the others.
  async function drawLaborReports(content) {
    const [reportYear, reportMonthNum] = laborReportMonth.split("-").map(Number);

    content.innerHTML = `
      <div class="report-month-year-nav">
        <label class="report-month-picker">
          <select id="report-month-select">${MONTH_NAMES.map((name, i) => `<option value="${i + 1}" ${i + 1 === reportMonthNum ? "selected" : ""}>${name}</option>`).join("")}</select>
        </label>
        <label class="report-year-picker">
          <select id="report-year-select">${reportYearOptions(reportYear)}</select>
        </label>
      </div>
      <p class="review-checklist-hint">
        Save your monthly reports here -- WOM, Labor, Financial, and GL -- filed by month/year so
        each one's kept alongside the timesheeting for that period, for comparing side by side
        against what this app tracked.
      </p>
      <div id="labor-report-attachments"></div>
    `;

    content.querySelector("#report-month-select").addEventListener("change", (e) => {
      laborReportMonth = `${reportYear}-${String(Number(e.target.value)).padStart(2, "0")}`;
      draw();
    });
    content.querySelector("#report-year-select").addEventListener("change", (e) => {
      laborReportMonth = `${e.target.value}-${String(reportMonthNum).padStart(2, "0")}`;
      draw();
    });

    await renderAttachments(content.querySelector("#labor-report-attachments"), {
      title: `Monthly Reports -- ${monthLabel(laborReportMonth)}`,
      relatedType: "labor_report",
      relatedId: laborReportMonth,
      categories: [
        { value: "wom_report", label: "WOM Report" },
        { value: "labor_report", label: "Labor Report" },
        { value: "financial_report", label: "Financial Report" },
        { value: "gl_report", label: "GL Report" },
      ],
      canUpload: true,
      groupByCategory: true,
    });
  }

  async function drawVendors(content) {
    if (!vendorsCache) vendorsCache = await api.get("/api/admin/vendors");
    renderVendorsUI(content);
  }

  function filteredVendors() {
    return vendorsCache.filter((v) => {
      if (vendorFilters.cwStatus && v.cwStatus !== vendorFilters.cwStatus) return false;
      if (vendorFilters.toyotaStatus && v.toyotaStatus !== vendorFilters.toyotaStatus) return false;
      if (vendorFilters.formsStatus && v.formsStatus !== vendorFilters.formsStatus) return false;
      if (vendorFilters.search) {
        const q = vendorFilters.search.toLowerCase();
        const haystack = `${v.name} ${v.jdeVendorNumber || ""} ${v.services || ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function cwFilterOptions() {
    return ["active", "inactive", "unknown"]
      .map((s) => `<option value="${s}" ${vendorFilters.cwStatus === s ? "selected" : ""}>${escapeHtml(CW_STATUS_LABELS[s])}</option>`)
      .join("");
  }
  function toyotaFilterOptions() {
    return ["approved", "not_approved", "unknown"]
      .map((s) => `<option value="${s}" ${vendorFilters.toyotaStatus === s ? "selected" : ""}>${escapeHtml(TOYOTA_STATUS_LABELS[s])}</option>`)
      .join("");
  }
  function formsFilterOptions() {
    return ["current", "outdated", "unknown"]
      .map((s) => `<option value="${s}" ${vendorFilters.formsStatus === s ? "selected" : ""}>${escapeHtml(FORMS_STATUS_LABELS[s])}</option>`)
      .join("");
  }

  // Renders the toolbar shell once per visit/mutation; the search input's
  // "input" handler only calls refreshVendorList() below so the input never
  // gets torn down and rebuilt mid-keystroke (which would drop focus/cursor
  // position on every character typed).
  function renderVendorsUI(content) {
    const outdatedCount = vendorsCache.filter((v) => v.formsStatus === "outdated").length;

    content.innerHTML = `
      <h3>Vendors</h3>
      <p class="review-checklist-hint">
        Vendor onboarding/compliance tracker -- C&amp;W approval, Toyota approval, and forms
        currency per vendor. Click a vendor to expand and edit.
      </p>
      ${
        outdatedCount === 0
          ? ""
          : `<div class="expiring-forms-banner">
              <div class="expiring-forms-title">Vendor forms needing attention</div>
              <div class="expiring-forms-row">
                <span class="rfm-flag">Outdated</span>
                <span>${outdatedCount} vendor${outdatedCount === 1 ? "" : "s"} on file ${outdatedCount === 1 ? "has" : "have"} outdated forms -- updated forms are needed to bring ${outdatedCount === 1 ? "it" : "them"} current.</span>
                <button class="btn btn-link vendor-view-outdated-btn" type="button">View</button>
              </div>
            </div>`
      }
      <div class="vendor-toolbar">
        <input class="vendor-search" type="text" placeholder="Vendor name, JDE #, or service" value="${escapeHtml(vendorFilters.search)}" />
        <select class="vendor-cw-filter">
          <option value="">All C&amp;W statuses</option>
          ${cwFilterOptions()}
        </select>
        <select class="vendor-toyota-filter">
          <option value="">All Toyota statuses</option>
          ${toyotaFilterOptions()}
        </select>
        <select class="vendor-forms-filter">
          <option value="">All forms statuses</option>
          ${formsFilterOptions()}
        </select>
        <button class="btn btn-secondary vendor-add-toggle" type="button">${showAddVendorForm ? "Cancel" : "+ Add vendor"}</button>
      </div>
      <p class="vendor-count"></p>
      <div id="vendor-add-host"></div>
      <div class="review-list" id="vendor-list"></div>
    `;

    renderVendorAddHost(content);

    content.querySelector(".vendor-search").addEventListener("input", (e) => {
      vendorFilters.search = e.target.value;
      refreshVendorList(content);
    });
    content.querySelector(".vendor-cw-filter").addEventListener("change", (e) => {
      vendorFilters.cwStatus = e.target.value;
      refreshVendorList(content);
    });
    content.querySelector(".vendor-toyota-filter").addEventListener("change", (e) => {
      vendorFilters.toyotaStatus = e.target.value;
      refreshVendorList(content);
    });
    content.querySelector(".vendor-forms-filter").addEventListener("change", (e) => {
      vendorFilters.formsStatus = e.target.value;
      refreshVendorList(content);
    });
    content.querySelector(".vendor-add-toggle").addEventListener("click", () => {
      showAddVendorForm = !showAddVendorForm;
      content.querySelector(".vendor-add-toggle").textContent = showAddVendorForm ? "Cancel" : "+ Add vendor";
      renderVendorAddHost(content);
    });
    const viewOutdatedBtn = content.querySelector(".vendor-view-outdated-btn");
    if (viewOutdatedBtn) {
      viewOutdatedBtn.addEventListener("click", () => {
        vendorFilters.formsStatus = "outdated";
        renderVendorsUI(content);
      });
    }

    refreshVendorList(content);
  }

  // Toggling the add-vendor form only touches its own host element, not the
  // whole toolbar, so the search input (and whatever the admin was typing
  // into it) is never torn down along the way.
  function renderVendorAddHost(content) {
    const host = content.querySelector("#vendor-add-host");
    if (!showAddVendorForm) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = renderAddVendorForm();
    wireAddVendorForm(content);
  }

  function refreshVendorList(content) {
    const filtered = filteredVendors();
    content.querySelector(".vendor-count").textContent = `${filtered.length} match${filtered.length === 1 ? "" : "es"}.`;
    const list = content.querySelector("#vendor-list");
    list.innerHTML = "";
    if (filtered.length === 0) {
      list.innerHTML = `<p class="empty-note">No vendors match these filters.</p>`;
    } else {
      filtered.forEach((v) => list.appendChild(renderVendorRow(v, content)));
    }
  }

  function wireAddVendorForm(content) {
    const addForm = content.querySelector(".add-vendor-form");
    if (!addForm) return;
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = addForm.querySelector(".save-message");
      try {
        await api.post("/api/admin/vendors", {
          name: addForm.name.value.trim(),
          jdeVendorNumber: addForm.jdeVendorNumber.value.trim(),
          cwStatus: addForm.cwStatus.value,
          toyotaStatus: addForm.toyotaStatus.value,
          services: addForm.services.value.trim(),
        });
        vendorsCache = null;
        showAddVendorForm = false;
        await drawVendors(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function renderAddVendorForm() {
    return `
      <form class="add-vendor-form review-row">
        <div class="add-tech-grid">
          <input name="name" placeholder="Vendor name" required />
          <input name="jdeVendorNumber" placeholder="JDE Vendor #" />
          <select name="cwStatus">
            <option value="unknown">C&amp;W Unknown</option>
            <option value="active">C&amp;W Active</option>
            <option value="inactive">C&amp;W Inactive</option>
          </select>
          <select name="toyotaStatus">
            <option value="unknown">Toyota Unknown</option>
            <option value="approved">Toyota Approved</option>
            <option value="not_approved">Toyota Not Approved</option>
          </select>
          ${renderServicesSelect("")}
        </div>
        <button type="submit" class="btn btn-primary">Add vendor</button>
        <span class="save-message"></span>
      </form>
    `;
  }

  function renderVendorRow(v, content) {
    const el = document.createElement("div");
    el.className = "review-row vendor-row";

    if (vendorExpanded.has(v.id)) {
      el.innerHTML = renderVendorEditForm(v);
      const form = el.querySelector(".vendor-edit-form");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = form.querySelector(".save-message");
        try {
          await api.patch(`/api/admin/vendors/${v.id}`, {
            name: form.name.value.trim(),
            jdeVendorNumber: form.jdeVendorNumber.value.trim(),
            cwStatus: form.cwStatus.value,
            toyotaStatus: form.toyotaStatus.value,
            formsStatus: form.formsStatus.value,
            phone: form.phone.value.trim(),
            email: form.email.value.trim(),
            poEmail: form.poEmail.value.trim(),
            onlineSourceUrl: form.onlineSourceUrl.value.trim(),
            midwestSitesSeen: form.midwestSitesSeen.value.trim(),
            services: form.services.value.trim(),
            invoicedPreviously: form.invoicedPreviously.value.trim(),
            successfulInvoiceRecords: form.successfulInvoiceRecords.value === "" ? null : Number(form.successfulInvoiceRecords.value),
            successfulSinceDate: form.successfulSinceDate.value || null,
            trackerWorkExamples: form.trackerWorkExamples.value.trim(),
            coverageOutsideMidwest: form.coverageOutsideMidwest.value.trim(),
            notes: form.notes.value.trim(),
            coiMeetsRequiredLimits: form.coiMeetsRequiredLimits.checked,
            coiMeetsLanguageRequirements: form.coiMeetsLanguageRequirements.checked,
            coiLimits: Object.fromEntries(
              Object.keys(COI_LIMIT_LABELS).map((key) => [key, form[`coi_${key}`].value.trim()])
            ),
            formChecks: Object.fromEntries(FORM_CHECK_KEYS.map((key) => [key, form[key].checked])),
            w9InvoiceDate: form.w9InvoiceDate.value || null,
          });
          vendorsCache = null;
          await drawVendors(content);
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      form.querySelector('select[name="services"]').addEventListener("change", (e) => {
        const matrixEntry = COI_MATRIX_BY_LABEL[e.target.value];
        if (!matrixEntry) return;
        for (const [coiKey, matrixKey] of Object.entries(COI_LIMIT_TO_MATRIX_KEY)) {
          form[`coi_${coiKey}`].value = matrixEntry.requirements[matrixKey] || "";
        }
      });
      el.querySelector(".cancel-vendor-edit").addEventListener("click", () => {
        vendorExpanded.delete(v.id);
        refreshVendorList(content);
      });
      el.querySelector(".delete-vendor-btn").addEventListener("click", async () => {
        if (!window.confirm(`Remove vendor "${v.name}"? This can't be undone.`)) return;
        try {
          await api.delete(`/api/admin/vendors/${v.id}`);
          vendorsCache = null;
          vendorExpanded.delete(v.id);
          await drawVendors(content);
        } catch (err) {
          window.alert(`Could not remove: ${err.message}`);
        }
      });
      return el;
    }

    el.innerHTML = `
      <div class="review-row-summary vendor-summary">
        <span class="review-row-name">${escapeHtml(v.name)}</span>
        <span class="vendor-jde">${escapeHtml(v.jdeVendorNumber || "No JDE #")}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.cwStatus]}">${escapeHtml(CW_STATUS_LABELS[v.cwStatus])}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.toyotaStatus]}">${escapeHtml(TOYOTA_STATUS_LABELS[v.toyotaStatus])}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.formsStatus]}">${escapeHtml(FORMS_STATUS_LABELS[v.formsStatus])}</span>
        ${!v.formChecksComplete || v.w9InvoiceStale ? `<span class="badge badge-rejected">Doc checks incomplete</span>` : ""}
        <button class="btn btn-secondary vendor-open-btn" type="button">Open</button>
      </div>
    `;
    el.querySelector(".vendor-open-btn").addEventListener("click", () => {
      vendorExpanded.add(v.id);
      refreshVendorList(content);
    });
    return el;
  }

  const COI_LIMIT_LABELS = {
    glLiabilityOcc: "GL Liability (Occ)",
    glLiabilityAgg: "GL Liability (Agg)",
    autoLiability: "Auto Liability",
    workersComp: "Workers Comp",
    umbrellaLiability: "Umbrella Liability",
    eAndO: "E&amp;O",
    pollution: "Pollution",
    crime: "Crime",
    productsComplOpAgg: "Products Compl (OP Agg)",
  };
  // Maps our vendor COI field names to the COI matrix's own key names --
  // same nine coverage types, named slightly differently in each place.
  const COI_LIMIT_TO_MATRIX_KEY = {
    glLiabilityOcc: "glOcc",
    glLiabilityAgg: "glAgg",
    autoLiability: "auto",
    workersComp: "wc",
    umbrellaLiability: "exs",
    eAndO: "eAndO",
    pollution: "pol",
    crime: "crime",
    productsComplOpAgg: "productsComplOpAgg",
  };

  // Matches VENDOR_FORM_CHECK_FIELDS' camelCase keys in server/data/db.js --
  // each is a checkbox <input name="..."> in the vendor edit form below.
  const FORM_CHECK_KEYS = [
    "coiIsAcord25_2016_03",
    "coiMatchesW9",
    "w9SignedDated",
    "w9CorrectVersion",
    "w9HasPhone",
    "w9HasRemitToAddress",
    "w9HasName",
    "achBankLetterhead",
    "achHasW9Name",
    "achHasW9Address",
  ];

  function renderServicesSelect(currentValue) {
    const matches = COI_MATRIX_BY_LABEL[currentValue];
    const groups = new Map();
    for (const entry of COI_MATRIX) {
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    const optgroups = [...groups.entries()]
      .map(
        ([group, entries]) =>
          `<optgroup label="${escapeHtml(group)}">${entries
            .map((e) => `<option value="${escapeHtml(e.label)}" ${e.label === currentValue ? "selected" : ""}>${escapeHtml(e.label)}</option>`)
            .join("")}</optgroup>`
      )
      .join("");
    // A vendor imported before this dropdown existed (or with a service
    // type outside the matrix) keeps its original free-text value as a
    // preserved option, rather than silently losing it the moment the
    // field renders as a select.
    const unmatchedOption =
      currentValue && !matches
        ? `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)} (not in matrix)</option>`
        : "";
    return `<select name="services">
      <option value="">-- Select a service --</option>
      ${unmatchedOption}
      ${optgroups}
    </select>`;
  }

  function renderVendorEditForm(v) {
    const cwSelect = ["unknown", "active", "inactive"]
      .map((s) => `<option value="${s}" ${v.cwStatus === s ? "selected" : ""}>${escapeHtml(CW_STATUS_LABELS[s])}</option>`)
      .join("");
    const toyotaSelect = ["unknown", "approved", "not_approved"]
      .map((s) => `<option value="${s}" ${v.toyotaStatus === s ? "selected" : ""}>${escapeHtml(TOYOTA_STATUS_LABELS[s])}</option>`)
      .join("");
    const formsSelect = ["unknown", "current", "outdated"]
      .map((s) => `<option value="${s}" ${v.formsStatus === s ? "selected" : ""}>${escapeHtml(FORMS_STATUS_LABELS[s])}</option>`)
      .join("");
    const coiLimitInputs = Object.entries(COI_LIMIT_LABELS)
      .map(
        ([key, label]) =>
          `<label class="profile-field"><span>${label}</span><input name="coi_${key}" placeholder="e.g. $1M or -" value="${escapeHtml((v.coiLimits && v.coiLimits[key]) || "")}" /></label>`
      )
      .join("");

    return `
      <form class="vendor-edit-form">
        <div class="vendor-edit-grid">
          <label class="profile-field"><span>Vendor name</span><input name="name" value="${escapeHtml(v.name)}" required /></label>
          <label class="profile-field"><span>JDE Vendor #</span><input name="jdeVendorNumber" value="${escapeHtml(v.jdeVendorNumber || "")}" /></label>
          <label class="profile-field"><span>C&amp;W status</span><select name="cwStatus">${cwSelect}</select></label>
          <label class="profile-field"><span>Toyota status</span><select name="toyotaStatus">${toyotaSelect}</select></label>
          <label class="profile-field"><span>Forms status</span><select name="formsStatus">${formsSelect}</select></label>
          <label class="profile-field"><span>Phone</span><input name="phone" value="${escapeHtml(v.phone || "")}" /></label>
          <label class="profile-field"><span>Email</span><input name="email" value="${escapeHtml(v.email || "")}" /></label>
          <label class="profile-field"><span>PO email</span><input name="poEmail" value="${escapeHtml(v.poEmail || "")}" /></label>
          <label class="profile-field"><span>Online source URL</span><input name="onlineSourceUrl" value="${escapeHtml(v.onlineSourceUrl || "")}" /></label>
          <label class="profile-field"><span>Midwest sites seen</span><input name="midwestSitesSeen" value="${escapeHtml(v.midwestSitesSeen || "")}" /></label>
          <label class="profile-field"><span>Services</span>${renderServicesSelect(v.services || "")}</label>
          <label class="profile-field"><span>Invoiced previously?</span><input name="invoicedPreviously" value="${escapeHtml(v.invoicedPreviously || "")}" /></label>
          <label class="profile-field"><span>Successful invoice records</span><input name="successfulInvoiceRecords" type="number" min="0" value="${v.successfulInvoiceRecords ?? ""}" /></label>
          <label class="profile-field"><span>Successful since date</span><input name="successfulSinceDate" type="date" value="${escapeHtml((v.successfulSinceDate || "").slice(0, 10))}" /></label>
        </div>
        <label class="profile-field"><span>Tracker work examples</span><textarea name="trackerWorkExamples" rows="2">${escapeHtml(v.trackerWorkExamples || "")}</textarea></label>
        <label class="profile-field"><span>Potential coverage outside Midwest (online)</span><textarea name="coverageOutsideMidwest" rows="2">${escapeHtml(v.coverageOutsideMidwest || "")}</textarea></label>
        <label class="profile-field"><span>Notes</span><textarea name="notes" rows="2">${escapeHtml(v.notes || "")}</textarea></label>
        ${
          v.rawStatusText
            ? `<p class="vendor-raw-status">Original tracker status text: <em>${escapeHtml(v.rawStatusText)}</em></p>`
            : ""
        }

        <h4>COI (Certificate of Insurance) requirements</h4>
        <p class="review-checklist-hint">
          Picking a Service above fills these with the limits Toyota requires for that service type
          (from the insurance matrix) -- still editable if this vendor has a negotiated exception.
          Check the boxes once the vendor's actual COI (attached below) has been reviewed against them.
        </p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="coiMeetsRequiredLimits" ${v.coiMeetsRequiredLimits ? "checked" : ""} /> Meets required limits</label>
          <label><input type="checkbox" name="coiMeetsLanguageRequirements" ${v.coiMeetsLanguageRequirements ? "checked" : ""} /> Meets language requirements</label>
        </div>
        <div class="vendor-edit-grid">${coiLimitInputs}</div>

        <h4>COI document checks</h4>
        <p class="review-checklist-hint">Verified against the actual COI document attached below.</p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="coiIsAcord25_2016_03" ${v.formChecks.coiIsAcord25_2016_03 ? "checked" : ""} /> Issued on ACORD 25 form (2016/03 version)</label>
          <label><input type="checkbox" name="coiMatchesW9" ${v.formChecks.coiMatchesW9 ? "checked" : ""} /> Matches W-9 name &amp; address</label>
        </div>

        <h4>W-9 document checks</h4>
        <p class="review-checklist-hint">Verified against the actual W-9 document attached below.</p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="w9SignedDated" ${v.formChecks.w9SignedDated ? "checked" : ""} /> Signed and dated</label>
          <label><input type="checkbox" name="w9CorrectVersion" ${v.formChecks.w9CorrectVersion ? "checked" : ""} /> October 2018 or March 2024 version</label>
          <label><input type="checkbox" name="w9HasPhone" ${v.formChecks.w9HasPhone ? "checked" : ""} /> Has phone number</label>
          <label><input type="checkbox" name="w9HasRemitToAddress" ${v.formChecks.w9HasRemitToAddress ? "checked" : ""} /> Has remit-to address</label>
          <label><input type="checkbox" name="w9HasName" ${v.formChecks.w9HasName ? "checked" : ""} /> Has vendor name</label>
        </div>
        <label class="profile-field vendor-w9-invoice-field">
          <span>Blank invoice date on file${v.w9InvoiceStale ? ` <span class="badge badge-rejected">Over 2 years old</span>` : ""}</span>
          <input type="date" name="w9InvoiceDate" value="${v.w9InvoiceDate || ""}" />
        </label>

        <h4>ACH document checks</h4>
        <p class="review-checklist-hint">Verified against the actual ACH/bank letter attached below.</p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="achBankLetterhead" ${v.formChecks.achBankLetterhead ? "checked" : ""} /> On bank letterhead</label>
          <label><input type="checkbox" name="achHasW9Name" ${v.formChecks.achHasW9Name ? "checked" : ""} /> Has W-9 name</label>
          <label><input type="checkbox" name="achHasW9Address" ${v.formChecks.achHasW9Address ? "checked" : ""} /> Has W-9 address</label>
        </div>
        ${
          !v.formChecksComplete || v.w9InvoiceStale
            ? `<p class="split-row-warning">${!v.formChecksComplete ? "One or more document checks above aren't confirmed yet. " : ""}${v.w9InvoiceStale ? "The blank invoice on file is over 2 years old." : ""}</p>`
            : ""
        }

        <div class="vendor-edit-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-link cancel-vendor-edit">Cancel</button>
          <button type="button" class="btn btn-link danger-link delete-vendor-btn">Remove vendor</button>
          <span class="save-message"></span>
        </div>
      </form>
    `;
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

  const DAILY_GOAL_TARGET = 10;

  // The tab's own badge count -- a small number next to its label, not a
  // banner anywhere else. Never blocks the tab bar itself if one of these
  // calls fails.
  async function computePriorityCount() {
    try {
      const [expiringForms, vendors, weekendAddenda, reportGaps, missingUkg, woms, purelyhrUnverified, punchIssues] = await Promise.all([
        api.get("/api/admin/expiring-forms"),
        api.get("/api/admin/vendors"),
        api.get("/api/admin/weekend-addenda"),
        api.get("/api/admin/report-gaps"),
        api.get("/api/admin/missing-ukg"),
        api.get("/api/woms"),
        api.get("/api/admin/purelyhr-unverified"),
        api.get("/api/admin/punch-issues"),
      ]);
      const outdatedVendorCount = vendors.filter((v) => v.formsStatus === "outdated").length;
      const smartsheetGapCount = woms.filter((w) => w.status === "closed" && !w.smartsheetReflectedAt).length;
      // Vendor document-check completeness and pending WOM requests are both
      // deliberately left out of this badge: against a real Smartsheet
      // sync, "not yet sent to Toyota" (or "not yet checked", for vendors)
      // starts out true for a large ongoing backlog, not a handful of new
      // items -- counting either here would make the badge reflect backlog
      // size instead of "a few things to look at." Both still show up in
      // full in their own section below, to work through at whatever pace
      // makes sense (see Today's focus).
      return (
        expiringForms.length +
        outdatedVendorCount +
        weekendAddenda.length +
        reportGaps.length +
        missingUkg.length +
        smartsheetGapCount +
        purelyhrUnverified.length +
        punchIssues.length
      );
    } catch {
      return 0;
    }
  }

  // Everything that needs a look, gathered into one calm place to check on
  // your own schedule -- deliberately not scattered as banners across every
  // other tab. Each section below is its own quiet list; the only "in your
  // face" surface at all is the small count on the tab itself.
  async function drawPriorities(content) {
    const [expiringForms, vendors, weekendAddenda, reportGaps, missingUkg, woms, purelyhrUnverified, punchIssues] = await Promise.all([
      api.get("/api/admin/expiring-forms"),
      api.get("/api/admin/vendors"),
      api.get("/api/admin/weekend-addenda"),
      api.get("/api/admin/report-gaps"),
      api.get("/api/admin/missing-ukg"),
      api.get("/api/woms"),
      api.get("/api/admin/purelyhr-unverified"),
      api.get("/api/admin/punch-issues"),
    ]);
    const outdatedVendors = vendors.filter((v) => v.formsStatus === "outdated");
    const incompleteDocVendors = vendors.filter((v) => !v.formChecksComplete || v.w9InvoiceStale);
    const womsNeedingSmartsheetUpdate = woms.filter((w) => w.status === "closed" && !w.smartsheetReflectedAt);
    const pendingWoms = woms.filter((w) => w.status === "pending");
    const todayIso = new Date().toISOString().slice(0, 10);
    const isMonday = new Date().getDay() === 1;

    const focusItems = [];
    if (isMonday) {
      focusItems.push("It's Monday -- timecards and vendor case updates on ServiceEdge.");
    }
    if (outdatedVendors.length > 0) {
      focusItems.push(`Try clearing ${Math.min(DAILY_GOAL_TARGET, outdatedVendors.length)} of ${outdatedVendors.length} outdated vendor forms today.`);
    }
    if (expiringForms.length > 0) {
      focusItems.push(`Try clearing ${Math.min(DAILY_GOAL_TARGET, expiringForms.length)} of ${expiringForms.length} employee forms today.`);
    }
    if (focusItems.length === 0) focusItems.push("Nothing urgent queued up right now.");

    content.innerHTML = `
      <p class="review-checklist-hint">
        Everything that needs a look, gathered here so you can check in on your own schedule rather
        than chasing banners across tabs.
      </p>
      <div class="priorities-focus">
        <div class="priorities-focus-title">Today's focus</div>
        ${focusItems.map((t) => `<p class="priorities-focus-item">${escapeHtml(t)}</p>`).join("")}
      </div>
      <div id="priorities-sections"></div>
    `;

    const sections = content.querySelector("#priorities-sections");

    sections.appendChild(
      renderPrioritySection(
        "Vendor forms outdated",
        outdatedVendors.map((v) => ({
          label: v.name,
          detail: "Forms outdated",
          kind: "vendor",
        })),
        "No outdated vendor forms."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Vendor document checks incomplete",
        incompleteDocVendors.map((v) => ({
          label: v.name,
          detail: v.w9InvoiceStale ? "Blank invoice on file is over 2 years old" : "COI/W-9/ACH checks not all confirmed",
          kind: "vendor-doc",
          vendorId: v.id,
        })),
        "All vendor document checks are confirmed."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Employee forms needing attention",
        expiringForms.map((f) => ({
          label: f.techName,
          detail: `${f.formType || f.originalName} — ${f.expiresAt < todayIso ? "expired" : "expires"} ${f.expiresAt}`,
          kind: "tech-forms",
          techId: f.techId,
        })),
        "No employee forms need attention."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Technicians missing UKG hours this week",
        missingUkg.map((m) => ({
          label: m.techName,
          detail: `week of ${m.weekMonday}`,
          kind: "missing-ukg",
          techId: m.techId,
          weekMonday: m.weekMonday,
        })),
        "Everyone has UKG hours entered for this week."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Weekend hours needing review",
        weekendAddenda.map((a) => ({
          label: a.techName,
          detail: `week of ${a.weekMonday}`,
          kind: "weekend",
          techId: a.techId,
          weekMonday: a.weekMonday,
        })),
        "No weekend hours pending review."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Punch issues reported by techs",
        punchIssues.map((p) => ({
          label: p.techName,
          detail: `${p.day}, week of ${p.weekMonday}${p.note ? ` — "${p.note}"` : ""}`,
          kind: "punch-issue",
          techId: p.techId,
          weekMonday: p.weekMonday,
        })),
        "No punch issues reported."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Months missing a report",
        reportGaps.map((m) => ({
          label: monthLabel(m),
          detail: "No WOM/Labor/Financial/GL report saved",
          kind: "report-gap",
          month: m,
        })),
        "Reports are up to date for the last few months."
      )
    );
    sections.appendChild(renderWomSmartsheetSection(content, womsNeedingSmartsheetUpdate));
    sections.appendChild(
      renderPrioritySection(
        "WOM requests not yet sent to Toyota",
        pendingWoms.map((w) => ({
          label: w.description,
          detail: w.estimatedPrice != null ? `Est. $${formatMoney(w.estimatedPrice)}` : "No estimate yet",
          kind: "wom-pending",
          womCode: w.code,
        })),
        "Nothing waiting on an RFM request to Toyota right now."
      )
    );
    sections.appendChild(
      renderPrioritySection(
        "Time off needing PurelyHR verification",
        purelyhrUnverified.map((w) => ({
          label: w.techName,
          detail: `week of ${w.weekMonday} — ${w.timeOff.map((t) => `${TIME_OFF_LABELS[t.timeOffType] || t.timeOffType} ${t.hours}h (${t.day})`).join(", ")}`,
          kind: "purelyhr",
          techId: w.techId,
          weekMonday: w.weekMonday,
        })),
        "No time off is waiting on a PurelyHR check."
      )
    );

    sections.querySelectorAll(".priority-view-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { kind, tech, week, month, vendor, wom } = btn.dataset;
        if (kind === "vendor") {
          vendorFilters.formsStatus = "outdated";
          activeTab = "vendors";
        } else if (kind === "vendor-doc") {
          vendorExpanded.add(Number(vendor));
          activeTab = "vendors";
        } else if (kind === "tech-forms") {
          jumpToTech = { techId: tech, subTab: "forms" };
          activeTab = "technicians";
        } else if (kind === "missing-ukg") {
          allocTechId = tech;
          state.weekMonday = week;
          activeTab = "techalloc";
        } else if (kind === "weekend" || kind === "punch-issue") {
          state.weekMonday = week;
          expanded.add(tech);
          activeTab = "review";
        } else if (kind === "wom-pending") {
          womEditing.add(wom);
          activeTab = "woms";
        } else if (kind === "report-gap") {
          laborReportMonth = month;
          activeTab = "laborreports";
        } else if (kind === "purelyhr") {
          state.weekMonday = week;
          expanded.add(tech);
          activeTab = "review";
        }
        await draw();
      });
    });
  }

  function renderPrioritySection(title, items, emptyText) {
    const section = document.createElement("div");
    section.className = "priority-section";
    section.innerHTML = `
      <div class="priority-section-title">${escapeHtml(title)} (${items.length})</div>
      ${
        items.length === 0
          ? `<p class="empty-note">${escapeHtml(emptyText)}</p>`
          : `<div class="priority-list">
              ${items
                .map(
                  (item) => `
                <div class="priority-row">
                  <div class="priority-row-text">
                    <span class="priority-row-label">${escapeHtml(item.label)}</span>
                    <span class="priority-row-detail">${escapeHtml(item.detail)}</span>
                  </div>
                  <button
                    class="btn btn-link priority-view-btn"
                    type="button"
                    data-kind="${escapeHtml(item.kind)}"
                    ${item.techId ? `data-tech="${escapeHtml(item.techId)}"` : ""}
                    ${item.weekMonday ? `data-week="${escapeHtml(item.weekMonday)}"` : ""}
                    ${item.month ? `data-month="${escapeHtml(item.month)}"` : ""}
                    ${item.vendorId ? `data-vendor="${escapeHtml(String(item.vendorId))}"` : ""}
                    ${item.womCode ? `data-wom="${escapeHtml(item.womCode)}"` : ""}
                  >View</button>
                </div>`
                )
                .join("")}
            </div>`
      }
    `;
    return section;
  }

  // Closing a WOM here never touches the external Smartsheet tracker, so
  // this is an action, not just a link -- "Mark updated" clears the flag
  // right from here rather than sending admin elsewhere just to come back.
  function renderWomSmartsheetSection(content, woms) {
    const section = document.createElement("div");
    section.className = "priority-section";
    section.innerHTML = `
      <div class="priority-section-title">WOM projects closed -- update Smartsheet (${woms.length})</div>
      ${
        woms.length === 0
          ? `<p class="empty-note">Nothing closed here is waiting on a Smartsheet update.</p>`
          : `<div class="priority-list">
              ${woms
                .map(
                  (w) => `
                <div class="priority-row">
                  <div class="priority-row-text">
                    <span class="priority-row-label">${escapeHtml(w.code)}</span>
                    <span class="priority-row-detail">${escapeHtml(w.description)}</span>
                  </div>
                  <button class="btn btn-link wom-smartsheet-reflected-btn" type="button" data-code="${escapeHtml(w.code)}">Mark updated in Smartsheet</button>
                </div>`
                )
                .join("")}
            </div>`
      }
    `;
    section.querySelectorAll(".wom-smartsheet-reflected-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.post(`/api/woms/${encodeURIComponent(btn.dataset.code)}/smartsheet-reflected`);
          await drawPriorities(content);
        } catch (err) {
          btn.disabled = false;
          window.alert(`Could not mark it: ${err.message}`);
        }
      });
    });
    return section;
  }

  const TREND_LABELS = { rising: "Rising", falling: "Falling", steady: "Steady" };

  async function drawOverview(content) {
    const [rows, locations, expiringForms, otTrends, vendors, weekendAddenda] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
      api.get("/api/admin/expiring-forms"),
      api.get(`/api/admin/ot-trends/${state.weekMonday}`),
      api.get("/api/admin/vendors"),
      api.get("/api/admin/weekend-addenda"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const todayIso = new Date().toISOString().slice(0, 10);
    const outdatedVendorCount = vendors.filter((v) => v.formsStatus === "outdated").length;
    vendorsCache = vendors; // reuse this fetch if the admin jumps straight to the Vendors tab below

    const sorted = [...rows].sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return b.otNotOnWom - a.otNotOnWom;
    });

    content.innerHTML = `
      ${
        expiringForms.length === 0
          ? ""
          : `<div class="expiring-forms-banner">
              <div class="expiring-forms-title">Forms &amp; certifications needing attention</div>
              ${expiringForms
                .map((f) => {
                  const expired = f.expiresAt < todayIso;
                  return `<div class="expiring-forms-row">
                    <span class="rfm-flag">${expired ? "Expired" : "Expiring"}</span>
                    <span>${escapeHtml(f.techName)} — ${escapeHtml(f.formType || f.originalName)} (${expired ? "expired" : "expires"} ${escapeHtml(f.expiresAt)})</span>
                    <button class="btn btn-link expiring-form-view-btn" type="button" data-tech="${escapeHtml(f.techId)}">View</button>
                  </div>`;
                })
                .join("")}
            </div>`
      }
      ${
        outdatedVendorCount === 0
          ? ""
          : `<div class="expiring-forms-banner">
              <div class="expiring-forms-title">Vendor forms needing attention</div>
              <div class="expiring-forms-row">
                <span class="rfm-flag">Outdated</span>
                <span>${outdatedVendorCount} vendor${outdatedVendorCount === 1 ? "" : "s"} on file ${outdatedVendorCount === 1 ? "has" : "have"} outdated forms.</span>
                <button class="btn btn-link overview-view-outdated-vendors-btn" type="button">View</button>
              </div>
            </div>`
      }
      ${
        weekendAddenda.length === 0
          ? ""
          : `<div class="expiring-forms-banner">
              <div class="expiring-forms-title">Weekend hours added -- needs review</div>
              ${weekendAddenda
                .map(
                  (a) => `<div class="expiring-forms-row">
                    <span class="rfm-flag">Weekend</span>
                    <span>${escapeHtml(a.techName)} added Sat/Sun hours for the week of ${escapeHtml(a.weekMonday)} -- adjust to match UKG and mark reviewed.</span>
                    <button class="btn btn-link weekend-addendum-view-btn" type="button" data-tech="${escapeHtml(a.techId)}" data-week="${escapeHtml(a.weekMonday)}">View</button>
                  </div>`
                )
                .join("")}
            </div>`
      }
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
                    const flagLabel =
                      row.flagReason === "short_hours" ? "Flag for RFM — short hours" : "Flag for RFM — OT not on WOM";
                    return `
                      <tr class="${row.flagged ? "overview-row-flagged" : ""}">
                        <td>${escapeHtml(row.technician.name)}</td>
                        <td>${loc ? escapeHtml(loc.name) : "—"}</td>
                        <td><span class="badge badge-${row.status}">${STATUS_LABELS[row.status]}</span></td>
                        <td>${row.ukgHours}h</td>
                        <td class="${delta > 0 || row.flagReason === "short_hours" ? "warn" : ""}">${delta > 0 ? "+" : ""}${delta}</td>
                        <td>${row.regularHours}</td>
                        <td>${row.otHours}</td>
                        <td>${row.otOnWom}</td>
                        <td class="${row.flagReason === "ot_not_on_wom" ? "danger" : ""}">${row.otNotOnWom}</td>
                        <td>
                          ${row.flagged ? `<span class="rfm-flag">${flagLabel}</span>` : ""}
                          <button class="btn btn-link overview-view-btn" type="button" data-tech="${escapeHtml(row.technician.id)}">View</button>
                        </td>
                      </tr>
                    `;
                  })
                  .join("")
          }
        </tbody>
      </table>

      <h3>Employee OT Trends</h3>
      <p class="overview-hint">
        OT not charged to a WOM project, week by week, over the last ${otTrends.length > 0 ? otTrends[0].weeks.length : 8}
        weeks (ending this week) — for spotting a pattern, not just a one-off. Only shows technicians flagged at
        least once in that window.
      </p>
      ${
        otTrends.length === 0
          ? `<p class="empty-note">Nobody's been flagged in the last several weeks.</p>`
          : `<table class="detail-table overview-table ot-trends-table">
              <thead>
                <tr><th>Employee</th><th>Weekly OT not on WOM</th><th>Flagged weeks</th><th>Avg</th><th>Trend</th><th></th></tr>
              </thead>
              <tbody>
                ${otTrends
                  .map((t) => {
                    const sparkline = t.weeks
                      .map((w) => `<span class="ot-trend-bar ${w.flagged ? "flagged" : ""}" title="${escapeHtml(w.weekMonday)}: ${w.otNotOnWom}h">${w.otNotOnWom}</span>`)
                      .join("");
                    return `
                      <tr>
                        <td>${escapeHtml(t.technician.name)}</td>
                        <td><div class="ot-trend-sparkline">${sparkline}</div></td>
                        <td>${t.flaggedCount} / ${t.weeks.length}</td>
                        <td>${t.avgOtNotOnWom}h</td>
                        <td class="ot-trend-${t.trendDirection}">${TREND_LABELS[t.trendDirection]}</td>
                        <td><button class="btn btn-link overview-view-btn" type="button" data-tech="${escapeHtml(t.technician.id)}">View</button></td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>`
      }
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
        expanded.add(btn.dataset.tech);
        activeTab = "review";
        await draw();
      });
    });
    content.querySelectorAll(".expiring-form-view-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        jumpToTech = { techId: btn.dataset.tech, subTab: "forms" };
        activeTab = "technicians";
        await draw();
      });
    });
    const viewOutdatedVendorsBtn = content.querySelector(".overview-view-outdated-vendors-btn");
    if (viewOutdatedVendorsBtn) {
      viewOutdatedVendorsBtn.addEventListener("click", async () => {
        vendorFilters.formsStatus = "outdated";
        activeTab = "vendors";
        await draw();
      });
    }
    content.querySelectorAll(".weekend-addendum-view-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // Weekly Review now has its own inline weekend-hours editor right
        // on the row (correct + accept in one step), so route there instead
        // of Tech Allocation.
        state.weekMonday = btn.dataset.week;
        activeTab = "review";
        expanded.add(btn.dataset.tech);
        await draw();
      });
    });
  }

  async function drawReview(content) {
    const [rows, locations, woms] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
      api.get("/api/woms"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const womByCode = Object.fromEntries(woms.map((w) => [w.code, w]));

    // A week with time off isn't really "done" until PurelyHR's been
    // checked too -- PurelyHR doesn't link to UKG, so this can't be
    // inferred from anything else already tracked here. Same for a pending
    // weekend addendum or punch issue -- either means there's still an
    // active correction to make, even if the rest of the week looks fine.
    const isDone = (r) =>
      Boolean(r.ukgConfirmedAt) &&
      (!r.hasTimeOff || Boolean(r.purelyhrVerifiedAt)) &&
      !r.weekendAddendumAt &&
      (r.pendingPunchDays || []).length === 0;
    const needsAttention = rows.filter((r) => !isDone(r));
    const completed = rows.filter((r) => isDone(r));

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
      openList.appendChild(await renderReviewRow(row, content, locationByCode, womByCode));
    }

    const doneList = content.querySelector("#review-list-done");
    if (completed.length === 0) doneList.innerHTML = `<p class="empty-note">Nobody confirmed yet.</p>`;
    for (const row of completed) {
      doneList.appendChild(await renderReviewRow(row, content, locationByCode, womByCode));
    }
  }

  async function renderReviewRow(row, content, locationByCode, womByCode) {
    const el = document.createElement("div");
    const balanced = row.ukgHours > 0 && Math.abs(row.allocatedHours - row.ukgHours) < 0.01;
    const stage1 = row.ukgHours > 0; // UKG hours entered
    const stage2 = balanced; // allocation split matches UKG
    const stage3 = Boolean(row.ukgConfirmedAt); // admin confirmed it's in the real UKG system
    const stage4 = Boolean(row.purelyhrVerifiedAt); // time off checked against PurelyHR (only applies if hasTimeOff)
    const hasWeekendAddendum = Boolean(row.weekendAddendumAt); // tech added Sat/Sun hours after this week was already locked
    const pendingPunchDays = row.pendingPunchDays || [];
    const isDone = stage3 && (!row.hasTimeOff || stage4) && !hasWeekendAddendum && pendingPunchDays.length === 0;
    el.className = `review-row ${isDone ? "review-row-ready" : "review-row-pending"}`;

    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(row.technician.name)}</div>
        <div class="review-steps">
          <span class="review-step ${stage1 ? "done" : ""}">1. UKG hours</span>
          <span class="review-step ${stage2 ? "done" : ""}">2. Allocated</span>
          <span class="review-step ${stage3 ? "done" : ""}">3. Entered in UKG</span>
          ${row.hasTimeOff ? `<span class="review-step ${stage4 ? "done" : ""}">4. PurelyHR verified</span>` : ""}
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
        ${
          row.hasTimeOff
            ? `<button
                class="btn ${stage4 ? "btn-secondary" : "btn-primary"} confirm-purelyhr-btn"
                type="button"
                ${
                  stage4
                    ? `title="PurelyHR tracks time off separately from UKG -- this doesn't touch the week's status"`
                    : `${!["submitted", "approved"].includes(row.status) ? "disabled" : ""} title="Cross-check this week's PTO/Sick/Holiday/Bereavement hours in PurelyHR, then mark it here"`
                }
              >${stage4 ? "Undo PurelyHR check" : "Mark PurelyHR verified"}</button>`
            : ""
        }
        <button class="btn btn-link expand-btn" type="button">${expanded.has(row.technician.id) ? "Hide" : "Details"}</button>
      </div>
      ${
        hasWeekendAddendum
          ? `<div class="weekend-addendum-note">
              <strong>Weekend hours added</strong> since this week was ${row.status} -- correct the hours below if
              they don't match UKG yet, then accept. Accepting doesn't send anything back to ${escapeHtml(row.technician.name.split(" ")[0])} for re-approval.
              <div class="weekend-edit-rows" id="weekend-edit-${row.technician.id}">Loading weekend hours…</div>
            </div>`
          : ""
      }
      ${
        pendingPunchDays.length > 0
          ? `<div class="weekend-addendum-note" id="punch-issue-edit-${row.technician.id}">
              <strong>Punch issue flagged</strong> (${pendingPunchDays.join(", ")}) -- correct the hours below and resolve.
              Resolving fixes just that day, without unlocking the rest of this ${row.status} week.
              <div class="punch-issue-rows">Loading…</div>
            </div>`
          : ""
      }
      <div class="review-row-detail" id="detail-${row.technician.id}"></div>
    `;

    el.querySelector(".confirm-ukg-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const confirming = !stage3;
        await api.patch(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/ukg-confirmed`, { confirmed: confirming });
        // Collapse the detail panel on the way in/out of Completed -- that
        // list should default to just the summary row, not the full form.
        expanded.delete(row.technician.id);
        await drawReview(content);
      } catch (err) {
        btn.disabled = false;
        window.alert(`Could not update: ${err.message}`);
      }
    });

    const purelyhrBtn = el.querySelector(".confirm-purelyhr-btn");
    if (purelyhrBtn) {
      purelyhrBtn.addEventListener("click", async () => {
        purelyhrBtn.disabled = true;
        try {
          await api.patch(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/purelyhr-verified`, { verified: !stage4 });
          expanded.delete(row.technician.id);
          await drawReview(content);
        } catch (err) {
          purelyhrBtn.disabled = false;
          window.alert(`Could not update: ${err.message}`);
        }
      });
    }

    if (hasWeekendAddendum) {
      await renderWeekendEditor(el.querySelector(`#weekend-edit-${row.technician.id}`), row, content, locationByCode, womByCode);
    }

    if (pendingPunchDays.length > 0) {
      await renderPunchIssueEditor(
        el.querySelector(`#punch-issue-edit-${row.technician.id}`).querySelector(".punch-issue-rows"),
        row,
        pendingPunchDays,
        content,
        locationByCode,
        womByCode
      );
    }

    el.querySelector(".expand-btn").addEventListener("click", async () => {
      if (expanded.has(row.technician.id)) expanded.delete(row.technician.id);
      else expanded.add(row.technician.id);
      await drawReview(content);
    });

    if (expanded.has(row.technician.id)) {
      const detail = await api.get(`/api/technicians/${row.technician.id}/weeks/${state.weekMonday}`);
      const detailEl = el.querySelector(`#detail-${row.technician.id}`);
      detailEl.innerHTML =
        renderUkgForm(detail, justSavedUkg.has(row.technician.id)) +
        renderDetailTable(detail, locationByCode, womByCode) +
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

  // Accepts either a UKG-style clock time ("8:25" -- 8 hours 25 minutes) or
  // a plain decimal ("8.25"). Critical that these two formats are never
  // confused: decimal 8.25 is 8h15m, not 8h25m, so typing the clock number
  // straight off a timesheet screenshot into a decimal-only field would
  // silently save the wrong value on any punch that isn't a clean quarter
  // hour. A colon is the only signal needed to tell them apart.
  function parseHoursOrClock(raw) {
    const trimmed = String(raw).trim();
    if (trimmed === "") return 0;
    if (trimmed.includes(":")) {
      const [hPart, mPart] = trimmed.split(":");
      const h = Number(hPart);
      const m = Number(mPart);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
      return round2(h + m / 60);
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }

  function renderUkgForm(detail, justSaved) {
    const inputs = DAY_NAMES.map((day) => {
      const pending = Boolean(detail.pendingPunchByDay && detail.pendingPunchByDay[day]);
      const dayHours = Number(detail.ukgHoursByDay[day] || 0);
      return `
        <label class="ukg-day-field ${pending ? "ukg-day-field-pending" : ""}">
          <span>${day}</span>
          <input type="text" inputmode="decimal" data-day="${day}" value="${detail.ukgHoursByDay[day] || 0}" title="Type either a decimal (8.25) or UKG's clock time (8:15)" />
          <span class="ukg-day-clock" data-day-clock="${day}">${hoursToClock(dayHours)}</span>
          <button type="button" class="btn btn-link ukg-pending-punch-btn" data-day="${day}" data-flagged="${pending}" title="Flag or clear a pending punch correction for this day">${pending ? "⚠ Pending" : "Flag punch"}</button>
        </label>`;
    }).join("");
    const total = round2(DAY_NAMES.reduce((s, d) => s + Number(detail.ukgHoursByDay[d] || 0), 0));
    return `
      <form class="ukg-hours-form">
        <div class="ukg-hours-title">UKG hours (from timesheet)</div>
        <p class="ukg-hours-hint">Type either a decimal (8.25) or UKG's own clock time (8:15) -- it converts automatically.</p>
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
          <input type="text" class="ukg-paste-input" placeholder="Paste 7 values, Mon→Sun (e.g. 8 8 8:15 7 9 0 0)" />
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
        [...form.querySelectorAll("input[data-day]")].reduce((s, input) => s + parseHoursOrClock(input.value), 0)
      );
      form.querySelector(".ukg-total-decimal").textContent = total;
      form.querySelector(".ukg-total-clock").textContent = hoursToClock(total);
    }

    function updateDayClock(input) {
      const day = input.dataset.day;
      const clockEl = form.querySelector(`[data-day-clock="${day}"]`);
      if (clockEl) clockEl.textContent = hoursToClock(parseHoursOrClock(input.value));
    }

    form.querySelectorAll("input[data-day]").forEach((input) => {
      input.addEventListener("input", () => {
        justSavedUkg.delete(row.technician.id);
        updateDayClock(input);
        updateTotal();
      });
      // Settle whatever was typed -- clock format included -- into plain
      // decimal once the field is left, so what's on screen always matches
      // what Save will actually send.
      input.addEventListener("blur", () => {
        input.value = parseHoursOrClock(input.value);
        updateDayClock(input);
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
      const isValidToken = (v) => v.includes(":") ? /^\d{1,2}:\d{1,2}$/.test(v) : !Number.isNaN(Number(v));
      if (values.length !== 7 || !values.every(isValidToken)) {
        msg.textContent = "Paste exactly 7 numbers or clock times (Mon through Sun), e.g. 8 8 8:15 7 9 0 0.";
        return;
      }
      const inputs = form.querySelectorAll("input[data-day]");
      inputs.forEach((input, i) => {
        input.value = parseHoursOrClock(values[i]);
        updateDayClock(input);
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
        hours[input.dataset.day] = parseHoursOrClock(input.value);
      });
      try {
        await api.put(`/api/admin/weeks/${row.technician.id}/${state.weekMonday}/ukg-hours`, { hours });
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

  // The JDE accounting code a day's hours actually post to: a location's E&F
  // Job Number + the standard E&F subsidiary code for E&F time, or a WOM's
  // own location's WOM Job Number + that WOM's own subsidiary code for WOM
  // time -- "?" wherever one of those hasn't been entered yet, so a missing
  // code is obvious rather than silently blank.
  function accountingCode(a, locationByCode, womByCode) {
    if (a.type === "timeoff") return "—";
    if (a.type === "wom") {
      const wom = womByCode[a.womCode];
      const loc = wom ? locationByCode[wom.locationCode] : null;
      return `${(loc && loc.womJobNumber) || "?"}.${(wom && wom.subsidiaryCode) || "?"}`;
    }
    const loc = locationByCode[a.locationCode];
    return `${(loc && loc.efJobNumber) || "?"}.${(loc && loc.efSubsidiaryCode) || "20920000"}`;
  }

  function renderDetailTable(detail, locationByCode, womByCode) {
    if (detail.allocations.length === 0) {
      return `<p class="empty-note">No hours allocated.</p>`;
    }
    const rows = detail.allocations
      .map(
        (a) =>
          `<tr><td>${a.day}</td><td>${escapeHtml(describeAllocation(a, locationByCode))}</td><td>${escapeHtml(accountingCode(a, locationByCode, womByCode))}</td><td>${a.hours}h</td></tr>`
      )
      .join("");
    return `
      <table class="detail-table">
        <thead><tr><th>Day</th><th>Allocation</th><th>Accounting Code</th><th>Hours</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // The Sat/Sun hours a technician logged after this week was already
  // locked -- shown inline (with the same accounting codes as the main
  // detail table, since that's what gets keyed into UKG) so admin can
  // correct the hours to match UKG's actual time and accept in one click,
  // without leaving Weekly Review or bouncing anything back to the tech.
  async function renderWeekendEditor(container, row, content, locationByCode, womByCode) {
    const techId = row.technician.id;
    let detail;
    try {
      detail = await api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const weekendAllocs = detail.allocations.filter((a) => a.day === "Sat" || a.day === "Sun");
    if (weekendAllocs.length === 0) {
      container.innerHTML = `<p class="empty-note">No weekend hours logged.</p>`;
      return;
    }

    container.innerHTML = `
      <table class="detail-table weekend-edit-table">
        <thead><tr><th>Day</th><th>Allocation</th><th>Accounting Code</th><th>Hours</th></tr></thead>
        <tbody>
          ${weekendAllocs
            .map(
              (a, i) => `
            <tr>
              <td>${a.day}</td>
              <td>${escapeHtml(describeAllocation(a, locationByCode))}</td>
              <td>${escapeHtml(accountingCode(a, locationByCode, womByCode))}</td>
              <td><input type="text" inputmode="decimal" class="weekend-edit-hours" data-idx="${i}" value="${a.hours}" /></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <button class="btn btn-primary weekend-accept-btn" type="button">Accept weekend hours</button>
      <span class="save-message weekend-accept-message"></span>
    `;

    container.querySelector(".weekend-accept-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const msg = container.querySelector(".weekend-accept-message");
      btn.disabled = true;
      msg.textContent = "";
      const allocations = weekendAllocs.map((a, i) => {
        const input = container.querySelector(`.weekend-edit-hours[data-idx="${i}"]`);
        return {
          day: a.day,
          type: a.type,
          locationCode: a.locationCode || null,
          womCode: a.type === "wom" ? a.womCode : null,
          timeOffType: a.type === "timeoff" ? a.timeOffType : undefined,
          hours: Number(input.value),
        };
      });
      try {
        await api.post(`/api/technicians/${techId}/weeks/${state.weekMonday}/accept-weekend-hours`, { allocations });
        await drawReview(content);
      } catch (err) {
        btn.disabled = false;
        msg.textContent = err.message;
      }
    });
  }

  // One or more days flagged as a pending punch correction -- possibly
  // reported by the technician themselves, with a note. Shows the existing
  // allocation for each flagged day plus a corrected-UKG-hours field, so
  // admin can fix both together and clear the flag without unlocking (and
  // thereby resetting to draft) the rest of an otherwise-fine week.
  async function renderPunchIssueEditor(container, row, pendingPunchDays, content, locationByCode, womByCode) {
    const techId = row.technician.id;
    let detail;
    try {
      detail = await api.get(`/api/technicians/${techId}/weeks/${state.weekMonday}`);
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    container.innerHTML = pendingPunchDays
      .map((day) => {
        const dayAllocs = detail.allocations.filter((a) => a.day === day);
        const dayDetail = (detail.pendingPunchDetailByDay && detail.pendingPunchDetailByDay[day]) || null;
        const currentUkg = (detail.ukgHoursByDay && detail.ukgHoursByDay[day]) || 0;
        return `
          <div class="punch-issue-day" data-day="${day}">
            ${
              dayDetail && dayDetail.reportedBy === "tech" && dayDetail.note
                ? `<p class="punch-issue-tech-note">${escapeHtml(row.technician.name.split(" ")[0])} said: "${escapeHtml(dayDetail.note)}"</p>`
                : ""
            }
            <label class="punch-issue-ukg-label">
              Corrected UKG hours for ${day}:
              <input type="text" inputmode="decimal" class="punch-issue-ukg-hours" value="${currentUkg}" title="Type either a decimal (8.25) or UKG's clock time (8:15)" />
            </label>
            ${
              dayAllocs.length === 0
                ? `<p class="empty-note">No hours allocated for ${day} yet.</p>`
                : `<table class="detail-table punch-issue-table">
                    <thead><tr><th>Allocation</th><th>Accounting Code</th><th>Hours</th></tr></thead>
                    <tbody>
                      ${dayAllocs
                        .map(
                          (a, i) => `
                        <tr>
                          <td>${escapeHtml(describeAllocation(a, locationByCode))}</td>
                          <td>${escapeHtml(accountingCode(a, locationByCode, womByCode))}</td>
                          <td><input type="text" inputmode="decimal" class="punch-issue-edit-hours" data-idx="${i}" value="${a.hours}" /></td>
                        </tr>`
                        )
                        .join("")}
                    </tbody>
                  </table>`
            }
            <button class="btn btn-primary punch-issue-resolve-btn" type="button">Resolve ${day}</button>
            <span class="save-message punch-issue-message"></span>
          </div>
        `;
      })
      .join("");

    for (const day of pendingPunchDays) {
      const dayEl = container.querySelector(`.punch-issue-day[data-day="${day}"]`);
      const dayAllocs = detail.allocations.filter((a) => a.day === day);
      dayEl.querySelector(".punch-issue-resolve-btn").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const msg = dayEl.querySelector(".punch-issue-message");
        btn.disabled = true;
        msg.textContent = "";
        const hours = parseHoursOrClock(dayEl.querySelector(".punch-issue-ukg-hours").value);
        const allocations = dayAllocs.map((a, i) => {
          const input = dayEl.querySelector(`.punch-issue-edit-hours[data-idx="${i}"]`);
          return {
            day: a.day,
            type: a.type,
            locationCode: a.locationCode || null,
            womCode: a.type === "wom" ? a.womCode : null,
            timeOffType: a.type === "timeoff" ? a.timeOffType : undefined,
            hours: input ? Number(input.value) : a.hours,
          };
        });
        try {
          await api.post(`/api/technicians/${techId}/weeks/${state.weekMonday}/resolve-punch-issue`, { day, hours, allocations });
          await drawReview(content);
        } catch (err) {
          btn.disabled = false;
          msg.textContent = err.message;
        }
      });
    }
  }

  function renderReviewActions(row) {
    if (row.status === "submitted") {
      return `
        <div class="review-actions">
          <button class="btn btn-primary approve-btn" data-id="${row.technician.id}">Approve</button>
          <button class="btn btn-secondary reject-btn" data-id="${row.technician.id}">Reject</button>
          <button class="btn btn-link unlock-btn" data-id="${row.technician.id}">Unlock for correction</button>
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

  // Connection status + a read-only preview of the actual Smartsheet data
  // (column names and a few sample rows) -- lets admin confirm the link
  // works before any column ever gets mapped to a WOM field. This app
  // never writes anything back to Smartsheet.
  async function renderSmartsheetPanel(container, content) {
    let status;
    try {
      status = await api.get("/api/admin/smartsheet/status");
    } catch (err) {
      container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    if (!status.connected) {
      container.innerHTML = `
        <div class="smartsheet-status smartsheet-status-off">
          <strong>Not connected.</strong> Needs SMARTSHEET_API_TOKEN and SMARTSHEET_SHEET_ID set on the server,
          then a restart.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="smartsheet-status smartsheet-status-on">
        <strong>Connected.</strong>
        <button class="btn btn-link smartsheet-preview-btn" type="button">Preview data</button>
        <button class="btn btn-secondary smartsheet-sync-btn" type="button">Sync WOMs from Smartsheet</button>
      </div>
      <div class="smartsheet-sync-result"></div>
      <div class="smartsheet-preview"></div>
    `;

    container.querySelector(".smartsheet-sync-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const resultEl = container.querySelector(".smartsheet-sync-result");
      btn.disabled = true;
      resultEl.innerHTML = `<p class="empty-note">Syncing…</p>`;
      try {
        const result = await api.post("/api/admin/smartsheet/sync-woms");
        const summaryHtml = `
          <p class="smartsheet-sync-summary">
            <strong>${result.created}</strong> new WOM${result.created === 1 ? "" : "s"} added (open or pending),
            <strong>${result.promoted}</strong> pending WOM${result.promoted === 1 ? "" : "s"} promoted now that a real WOM # showed up,
            <strong>${result.updated}</strong> existing WOM${result.updated === 1 ? "" : "s"} refreshed — out of ${result.total} sheet rows.
            Matched by "${escapeHtml(result.womColumn)}", pricing from ${escapeHtml(result.estimateColumn || "no estimate column found")} /
            ${escapeHtml(result.appliedColumn || "no applied column found")}, "requested" status from
            ${escapeHtml(result.dateRequestedColumn || "no Date Requested column found")}.
          </p>
        `;
        // The WOM Projects list below needs to show the freshly-synced
        // prices right away, not just after a manual page reload -- a full
        // redraw rebuilds this whole panel too, so re-find it afterward to
        // keep the summary message visible.
        await drawWoms(content);
        const freshResultEl = content.querySelector(".smartsheet-sync-result");
        if (freshResultEl) freshResultEl.innerHTML = summaryHtml;
      } catch (err) {
        resultEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
        btn.disabled = false;
      }
    });

    container.querySelector(".smartsheet-preview-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const previewEl = container.querySelector(".smartsheet-preview");
      btn.disabled = true;
      previewEl.innerHTML = `<p class="empty-note">Loading…</p>`;
      try {
        const preview = await api.get("/api/admin/smartsheet/preview");
        previewEl.innerHTML = `
          <p class="review-checklist-hint">
            <strong>${escapeHtml(preview.sheetName)}</strong> — ${preview.rowCount} row${preview.rowCount === 1 ? "" : "s"},
            ${preview.columns.length} column${preview.columns.length === 1 ? "" : "s"}. Showing the first
            ${Math.min(5, preview.sampleRows.length)}.
          </p>
          <table class="detail-table smartsheet-preview-table">
            <thead><tr>${preview.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
            <tbody>
              ${preview.sampleRows
                .map((row) => `<tr>${preview.columns.map((c) => `<td>${escapeHtml(row[c] != null ? String(row[c]) : "")}</td>`).join("")}</tr>`)
                .join("")}
            </tbody>
          </table>
        `;
      } catch (err) {
        previewEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function drawWoms(content) {
    const [woms, locations] = await Promise.all([api.get("/api/woms"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    const efSubsidiary = locations[0] ? locations[0].efSubsidiaryCode : "20920000";

    content.innerHTML = `
      <h3>Smartsheet Connection</h3>
      <p class="review-checklist-hint">
        A one-way, read-only link to your WOM tracker in Smartsheet -- this app only ever reads from it, never
        writes back. Preview the connection here before any column gets mapped to a WOM field.
      </p>
      <div id="smartsheet-panel"></div>

      <h3>Locations</h3>
      <p class="review-checklist-hint">
        Each location has its own E&amp;F Contract Job Number and WOM Job Number (from the JDE lookup). E&amp;F time
        always uses the standard subsidiary code <strong>${escapeHtml(efSubsidiary)}</strong> at every location —
        that part never changes location to location; WOM subsidiary codes vary by project and are set on each WOM
        below. Region is used to match this location up against the monthly labor report.
      </p>
      <div class="review-list" id="location-list"></div>
      <form id="add-location-form" class="add-wom-form">
        <input name="code" placeholder="Location code" required />
        <input name="name" placeholder="Location name" required />
        <input name="efJobNumber" placeholder="E&amp;F Contract Job Number" />
        <input name="womJobNumber" placeholder="WOM Job Number" />
        <input name="region" placeholder="Region (e.g. Southeast)" />
        <button type="submit" class="btn btn-primary">Add location</button>
        <span class="save-message" id="location-message"></span>
      </form>

      <h3>WOM Projects</h3>
      <div class="review-section-title">Active</div>
      <div class="review-list" id="wom-list-active"></div>
      <div class="review-section-title">Invoiced</div>
      <div class="review-list" id="wom-list-invoiced"></div>
      <div class="review-section-title">Cancelled</div>
      <div class="review-list" id="wom-list-cancelled"></div>
      <form id="add-wom-form" class="add-wom-form">
        <input name="code" placeholder="WOM code" required />
        <input name="description" placeholder="Description" required />
        <select name="locationCode"><option value="">No location</option>${locationOptions}</select>
        <input name="budgetHours" type="number" min="0" step="0.5" placeholder="Budget hrs (optional)" />
        <input name="subsidiaryCode" placeholder="Subsidiary code" />
        <button type="submit" class="btn btn-primary">Add WOM</button>
        <span class="save-message" id="wom-message"></span>
      </form>
    `;

    await renderSmartsheetPanel(content.querySelector("#smartsheet-panel"), content);

    const locationList = content.querySelector("#location-list");
    for (const l of locations) {
      locationList.appendChild(renderLocationRow(l, content));
    }

    // Active is everything still in play (or not yet real); Invoiced groups
    // "invoiced" and "closed" together since both mean the job was billed,
    // just at different closeout points; Cancelled is its own section so a
    // dropped job never reads as billed revenue. Keeps the day-to-day list
    // from being cluttered with jobs that are already done one way or
    // another.
    const activeList = content.querySelector("#wom-list-active");
    const invoicedList = content.querySelector("#wom-list-invoiced");
    const cancelledList = content.querySelector("#wom-list-cancelled");
    const activeWoms = woms.filter((w) => !["invoiced", "closed", "cancelled"].includes(w.status));
    const invoicedWoms = woms.filter((w) => w.status === "invoiced" || w.status === "closed");
    const cancelledWoms = woms.filter((w) => w.status === "cancelled");
    for (const w of activeWoms) {
      activeList.appendChild(await renderWomRow(w, content, locationByCode, locations));
    }
    if (activeWoms.length === 0) activeList.innerHTML = `<p class="empty-note">No active WOM projects right now.</p>`;
    for (const w of invoicedWoms) {
      invoicedList.appendChild(await renderWomRow(w, content, locationByCode, locations));
    }
    if (invoicedWoms.length === 0) invoicedList.innerHTML = `<p class="empty-note">Nothing invoiced or closed yet.</p>`;
    for (const w of cancelledWoms) {
      cancelledList.appendChild(await renderWomRow(w, content, locationByCode, locations));
    }
    if (cancelledWoms.length === 0) cancelledList.innerHTML = `<p class="empty-note">No cancelled WOM projects.</p>`;

    content.querySelector("#add-location-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = content.querySelector("#location-message");
      try {
        await api.post("/api/locations", {
          code: form.code.value.trim(),
          name: form.name.value.trim(),
          efJobNumber: form.efJobNumber.value.trim() || null,
          womJobNumber: form.womJobNumber.value.trim() || null,
          region: form.region.value.trim() || null,
        });
        await drawWoms(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });

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
          subsidiaryCode: form.subsidiaryCode.value.trim() || null,
        });
        await drawWoms(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function renderLocationRow(l, content) {
    const el = document.createElement("div");
    el.className = "review-row";
    if (locationEditing.has(l.code)) {
      el.innerHTML = `
        <form class="edit-location-form review-row-summary">
          <span class="review-row-name">${escapeHtml(l.code)}</span>
          <input name="name" value="${escapeHtml(l.name)}" required />
          <input name="efJobNumber" placeholder="E&amp;F Contract Job Number" value="${escapeHtml(l.efJobNumber || "")}" />
          <input name="womJobNumber" placeholder="WOM Job Number" value="${escapeHtml(l.womJobNumber || "")}" />
          <input name="region" placeholder="Region" value="${escapeHtml(l.region || "")}" />
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-link cancel-edit">Cancel</button>
          <span class="save-message"></span>
        </form>
      `;
      el.querySelector(".cancel-edit").addEventListener("click", async () => {
        locationEditing.delete(l.code);
        await drawWoms(content);
      });
      el.querySelector(".edit-location-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = el.querySelector(".save-message");
        try {
          await api.patch(`/api/locations/${encodeURIComponent(l.code)}`, {
            name: form.name.value.trim(),
            efJobNumber: form.efJobNumber.value.trim() || null,
            womJobNumber: form.womJobNumber.value.trim() || null,
            region: form.region.value.trim() || null,
          });
          locationEditing.delete(l.code);
          await drawWoms(content);
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      return el;
    }

    const jobLabel = l.efJobNumber ? `E&amp;F Job # ${escapeHtml(l.efJobNumber)}` : "No E&amp;F Job # on file";
    const womJobLabel = l.womJobNumber ? ` &middot; WOM Job # ${escapeHtml(l.womJobNumber)}` : " &middot; No WOM Job # on file";
    const regionLabel = l.region ? ` &middot; ${escapeHtml(l.region)}` : "";
    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(l.name)} <span class="wom-desc">${jobLabel}${womJobLabel}${regionLabel}</span></div>
        <button class="btn btn-link edit-location-btn" type="button">Edit</button>
      </div>
    `;
    el.querySelector(".edit-location-btn").addEventListener("click", async () => {
      locationEditing.add(l.code);
      await drawWoms(content);
    });
    return el;
  }

  async function renderWomRow(w, content, locationByCode, locations) {
    const el = document.createElement("div");
    el.className = "review-row";
    const loc = locationByCode[w.locationCode];
    const metaParts = [];
    if (w.budgetHours != null) metaParts.push(`${w.remainingHours}h left of ${w.budgetHours}h`);
    metaParts.push(w.subsidiaryCode ? `Subsidiary ${escapeHtml(w.subsidiaryCode)}` : "No subsidiary code on file");
    if (w.estimatedPrice != null || w.appliedPrice != null) {
      metaParts.push(
        `Est. $${formatMoney(w.estimatedPrice)} / Applied $${formatMoney(w.appliedPrice)}${w.smartsheetSyncedAt ? " (Smartsheet)" : ""}`
      );
    }
    const metaLine = metaParts.join(" &middot; ");

    if (womEditing.has(w.code)) {
      const locationOptions = locations
        .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === w.locationCode ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
        .join("");
      el.innerHTML = `
        <form class="edit-wom-form review-row-summary">
          <span class="review-row-name">${escapeHtml(w.description)} <span class="wom-code">${escapeHtml(w.code)}</span></span>
          <input name="description" value="${escapeHtml(w.description)}" required />
          <select name="locationCode"><option value="">No location</option>${locationOptions}</select>
          <input name="budgetHours" type="number" min="0" step="0.5" placeholder="Budget hrs" value="${w.budgetHours == null ? "" : w.budgetHours}" />
          <input name="subsidiaryCode" placeholder="Subsidiary code" value="${escapeHtml(w.subsidiaryCode || "")}" />
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-link cancel-edit">Cancel</button>
          <span class="save-message"></span>
        </form>
      `;
      el.querySelector(".cancel-edit").addEventListener("click", async () => {
        womEditing.delete(w.code);
        await drawWoms(content);
      });
      el.querySelector(".edit-wom-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = el.querySelector(".save-message");
        try {
          await api.patch(`/api/woms/${encodeURIComponent(w.code)}/details`, {
            description: form.description.value.trim(),
            locationCode: form.locationCode.value || null,
            budgetHours: form.budgetHours.value === "" ? null : Number(form.budgetHours.value),
            subsidiaryCode: form.subsidiaryCode.value.trim() || null,
          });
          womEditing.delete(w.code);
          await drawWoms(content);
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      return el;
    }

    const statusBadgeClass = { open: "approved", requested: "submitted", invoiced: "submitted", cancelled: "rejected", closed: "rejected" }[
      w.status
    ] || "draft";
    const statusOptions = WOM_STATUSES.map(
      (s) => `<option value="${s}" ${w.status === s ? "selected" : ""}>${escapeHtml(WOM_STATUS_LABELS[s])}</option>`
    ).join("");
    // The project name is the thing people actually recognize; the WOM code
    // is only there for whoever needs to key it into JDE/UKG, so it's a
    // small, secondary tag next to the location rather than the headline.
    const locationTag = loc
      ? `<span class="wom-location">${escapeHtml(loc.name)}</span>`
      : `<span class="wom-location wom-location-missing">No location on file</span>`;

    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">
          ${escapeHtml(w.description)}${locationTag}
          <span class="wom-code">${escapeHtml(w.code)}</span>
        </div>
        <span class="badge badge-${statusBadgeClass}">${escapeHtml(WOM_STATUS_LABELS[w.status] || w.status)}</span>
        <select class="wom-status-select">${statusOptions}</select>
        <button class="btn btn-link edit-wom-btn" type="button">Edit</button>
        <button class="btn btn-link expand-btn" type="button">${womsExpanded.has(w.code) ? "Hide" : "Documents"}</button>
        <button class="btn btn-link delete-wom-btn" type="button">Delete</button>
      </div>
      <div class="wom-desc">${metaLine}</div>
      <div class="review-row-detail"></div>
    `;

    el.querySelector(".edit-wom-btn").addEventListener("click", async () => {
      womEditing.add(w.code);
      await drawWoms(content);
    });

    // A WOM created by mistake (a test entry, a typo) should just go away.
    // Blocked with a 409 if hours are already allocated against it -- ask
    // to confirm that specific, scarier consequence before forcing it.
    el.querySelector(".delete-wom-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete "${w.description}" (${w.code})? This can't be undone.`)) return;
      try {
        await api.delete(`/api/woms/${encodeURIComponent(w.code)}`);
        await drawWoms(content);
      } catch (err) {
        if (err.status === 409 && err.payload && err.payload.allocatedHours != null) {
          const forceConfirmed = window.confirm(
            `${err.payload.allocatedHours}h already allocated against ${w.code} on technician timesheets. Deleting it removes those hours too -- delete anyway?`
          );
          if (!forceConfirmed) return;
          try {
            await api.delete(`/api/woms/${encodeURIComponent(w.code)}`, { force: true });
            await drawWoms(content);
          } catch (err2) {
            window.alert(`Could not delete ${w.code}: ${err2.message}`);
          }
        } else {
          window.alert(`Could not delete ${w.code}: ${err.message}`);
        }
      }
    });

    // Admin can move a WOM to any status at any time -- e.g. straight to
    // Invoiced or Closed the moment the invoice goes out, independent of
    // whether a technician ever marked it complete from their own screen.
    el.querySelector(".wom-status-select").addEventListener("change", async (e) => {
      const nextStatus = e.target.value;
      try {
        await api.patch(`/api/woms/${encodeURIComponent(w.code)}`, { status: nextStatus });
        await drawWoms(content);
      } catch (err) {
        window.alert(`Could not update ${w.code}: ${err.message}`);
        e.target.value = w.status;
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
