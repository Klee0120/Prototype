import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { shiftWeek, weekRangeLabel, DAY_NAMES } from "../weekUtil.js";
import { renderAttachments } from "./attachments.js";
import { renderTechniciansTab } from "./technicianProfile.js";
import { renderTechWeek } from "./techWeek.js";
import { renderSchedule } from "./schedule.js";
import { COI_MATRIX, COI_MATRIX_BY_LABEL } from "../data/coiMatrix.js";
import { renderTaskBoard, nextLifecycleStep } from "./tasks.js";
import { renderPos } from "./pos.js";
import { renderReclasses } from "./reclasses.js";
import { openModal } from "../modal.js";
import { WOM_REQUEST_FORM_URL, TERRITORIES } from "../constants.js";

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

// Grouping the flat list of tabs under a handful of top-level sections --
// most with just one tab, so nothing about them visibly changes -- so the
// whole nav fits without the horizontal scrollbar a single 10-wide row
// needed. A section with more than one tab gets its own second row of
// sub-tabs underneath once it's the active section.
const NAV_SECTIONS = [
  { key: "priorities", label: "Priorities", tabs: ["mywork", "checklist"] },
  { key: "timekeeping", label: "Timekeeping", tabs: ["techalloc", "overview", "review"] },
  { key: "roster", label: "Roster", tabs: ["technicians"] },
  { key: "vendors", label: "Vendors", tabs: ["vendors", "onboarding"] },
  { key: "locations", label: "Locations", tabs: ["locations"] },
  { key: "wom", label: "WOM", tabs: ["woms", "womlookup", "schedule"] },
  { key: "pos", label: "POs", tabs: ["pos"] },
  { key: "financials", label: "Financials", tabs: ["costanalysis", "reclasses", "laborreports"] },
  { key: "audit", label: "Audit Trail", tabs: ["audit"] },
];

const TAB_LABELS = {
  mywork: "My Work",
  checklist: "Checklist",
  techalloc: "Tech Allocation",
  schedule: "Schedule",
  overview: "Overview",
  review: "Weekly Review",
  costanalysis: "Cost Analysis",
  reclasses: "Reclasses",
  laborreports: "Reports",
  technicians: "Technicians",
  vendors: "Vendor Directory",
  onboarding: "Onboarding",
  locations: "Locations",
  woms: "WOM Projects",
  womlookup: "WOM Lookup",
  pos: "Budget PO Tracker",
  audit: "Audit Trail",
};

function sectionForTab(tab) {
  return NAV_SECTIONS.find((s) => s.tabs.includes(tab)) || NAV_SECTIONS[0];
}

const WOM_STATUS_BADGE_CLASS = { open: "approved", requested: "submitted", invoiced: "submitted", cancelled: "rejected", closed: "rejected" };

// What to say under an auto-trigger lifecycle step that's still open --
// mirrors WOM_LIFECYCLE_STEPS in server/data/db.js (duplicated rather than
// shared, same pattern as this app's other per-view lookup tables).
const WOM_LIFECYCLE_STEP_HINTS = {
  wom_po_created: "Completes automatically once a Maximo/PO # is on file for this WOM.",
  vendor_scheduled: "Completes automatically once this WOM is put on a technician's calendar.",
  work_complete: "Completes automatically once the WOM is marked complete from Timekeeping.",
  cost_applied: "Completes automatically once an applied cost is on file for this WOM.",
};
function womStatusBadgeClass(status) {
  return WOM_STATUS_BADGE_CLASS[status] || "draft";
}

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

export async function renderAdminReview(container, navHost, topbarHost, subtabHost) {
  let activeTab = "review";
  let allocTechId = null;
  // Which technicians' detail panels are expanded on Weekly Review -- just
  // membership, not a cache of the detail itself, so a stale snapshot can
  // never be shown after something changes it elsewhere (Tech Allocation,
  // another tab, etc.). Detail is always fetched fresh when rendering.
  const expanded = new Set();
  const womEditing = new Set(); // one-shot: code to jump straight to in the Open Project modal
  const locationEditing = new Set();
  let womTerritoryFilter = ""; // "" = all territories, so a single-territory shop sees no filter UI noise by default
  let locationTerritoryFilter = ""; // "" = all territories
  let womGroupFilter = "active"; // "active" | "closed" -- the pill toggle above the WOM list
  let womLocationFilter = ""; // "" = all locations
  let womStatusFilter = ""; // "" = all statuses
  let womSearchQuery = "";
  const justSavedUkg = new Set(); // techId -> UKG hours were just saved, show a confirmation
  let laborReportMonth = currentMonthISO();
  let jumpToTech = null; // one-shot deep link into the Technicians tab (e.g. from the expiring-forms banner)

  // Vendors tab: the full list is fetched once per visit and filtered/
  // searched client-side (291+ rows is small enough that refetching on
  // every keystroke would just be wasted network, not a real cache concern).
  let vendorsCache = null;
  // Vendors that show up on a Budget PO (name + JDE #) but have no profile
  // here at all -- the Vendor Directory's own "needs attention" banner, same
  // idea as the outdated-forms one below it. Cleared alongside vendorsCache
  // any time a vendor's created/edited, same staleness reasoning.
  let unregisteredPoVendorsCache = null;
  let showUnregisteredPoVendors = false;
  function invalidateVendorsCache() {
    vendorsCache = null;
    unregisteredPoVendorsCache = null;
  }
  const vendorFilters = { search: "", cwStatus: "", toyotaStatus: "", formsStatus: "" };
  const vendorRequestEditing = new Set(); // vendor case-log request ids currently showing their edit form
  // Which vendor's full profile page is open (null = showing the directory
  // list instead), and which of its tabs -- a one-shot deep link (from the
  // Onboarding board, or a Priorities follow-up) just sets both and jumps to
  // the Vendors tab, same pattern jumpToTech already uses for Technicians.
  let vendorProfileId = null;
  let vendorProfileTab = "overview";
  const auditFilters = { search: "", action: "", range: "" };
  function openVendorProfile(vendorId, tab) {
    vendorProfileId = vendorId;
    vendorProfileTab = tab || "overview";
    goTo("vendors");
  }

  // Remembers which sub-tab was last open within each multi-tab section, so
  // clicking back into e.g. Timekeeping returns to where you left off
  // instead of always resetting to its first sub-tab.
  const sectionLastTab = {};
  // The Priorities nav pill's count -- last known value, shown immediately
  // on every redraw rather than blocking the whole page on 9 parallel admin
  // summary calls just to maybe paint a number on one pill (see
  // refreshPriorityBadge). Starts at 0 (no badge) until the first fetch
  // lands, then keeps whatever it last found.
  let priorityCount = 0;
  let drawGeneration = 0;

  function goTo(tab) {
    // Coming back to Vendors from somewhere else should start at the
    // directory list again -- an open profile is a within-visit
    // convenience, not state that should survive switching away and back.
    if (activeTab === "vendors" && tab !== "vendors") vendorProfileId = null;
    activeTab = tab;
    sectionLastTab[sectionForTab(tab).key] = tab;
    draw();
  }

  draw();

  async function draw() {
    const myGeneration = ++drawGeneration;
    const currentSection = sectionForTab(activeTab);

    navHost.innerHTML = NAV_SECTIONS.map(
      (s) => `
        <button class="sidebar-nav-item ${currentSection.key === s.key ? "active" : ""}" data-section="${s.key}">
          <span>${s.label}</span>${s.key === "priorities" && priorityCount > 0 ? ` <span class="tab-badge">${priorityCount}</span>` : ""}
        </button>
      `
    ).join("");

    // The sub-tab pill row lives in the gray band above the content (see
    // #subtab-band in app.js), not inline in the content itself -- it's
    // part of the page's chrome, same reasoning as the sidebar nav and the
    // top bar's context picker. Empty (and collapses via CSS :empty) for a
    // single-tab section.
    subtabHost.innerHTML =
      currentSection.tabs.length > 1
        ? currentSection.tabs.map((t) => `<button class="tab ${activeTab === t ? "active" : ""}" data-tab="${t}">${TAB_LABELS[t]}</button>`).join("")
        : "";

    container.innerHTML = `<div id="tab-content" class="tab-content"></div>`;

    navHost.querySelectorAll(".sidebar-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = NAV_SECTIONS.find((s) => s.key === btn.dataset.section);
        goTo(sectionLastTab[section.key] || section.tabs[0]);
      });
    });
    subtabHost.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => goTo(btn.dataset.tab));
    });

    const content = container.querySelector("#tab-content");
    // No admin tab currently fills this back in (Tech Allocation's own
    // technician/week picker moved into the sub-tab band instead -- see
    // drawTechAllocation); still cleared up front in case a future tab
    // wants it, same as the technician-facing view still does.
    topbarHost.innerHTML = "";
    if (activeTab === "mywork") await renderTaskBoard(content);
    else if (activeTab === "checklist") await drawPriorities(content);
    else if (activeTab === "techalloc") await drawTechAllocation(content);
    else if (activeTab === "schedule") await renderSchedule(content);
    else if (activeTab === "overview") await drawOverview(content);
    else if (activeTab === "review") await drawReview(content);
    else if (activeTab === "locations") await drawLocations(content);
    else if (activeTab === "woms") await drawWoms(content);
    else if (activeTab === "womlookup") await drawWomLookup(content);
    else if (activeTab === "technicians") {
      renderTechniciansTab(content, jumpToTech);
      jumpToTech = null;
    }
    else if (activeTab === "vendors") await drawVendors(content);
    else if (activeTab === "onboarding") await drawVendorOnboarding(content);
    else if (activeTab === "pos") await renderPos(content);
    else if (activeTab === "costanalysis") await drawCostAnalysis(content);
    else if (activeTab === "reclasses") await renderReclasses(content);
    else if (activeTab === "laborreports") await drawLaborReports(content);
    else await drawAudit(content);

    refreshPriorityBadge(myGeneration);
  }

  // Runs after the actual tab content is already on screen, not before --
  // the count is informational (a pill on the Priorities nav button), not
  // something worth making every single tab switch wait on. Guards against
  // a slow fetch clobbering the badge after the user's already navigated
  // elsewhere by checking drawGeneration hasn't moved on since this call
  // started.
  async function refreshPriorityBadge(myGeneration) {
    const count = await computePriorityCount();
    if (myGeneration !== drawGeneration) return;
    priorityCount = count;
    const nav = navHost.querySelector('.sidebar-nav-item[data-section="priorities"]');
    if (!nav) return;
    const existingBadge = nav.querySelector(".tab-badge");
    if (count > 0) {
      if (existingBadge) existingBadge.textContent = count;
      else nav.insertAdjacentHTML("beforeend", ` <span class="tab-badge">${count}</span>`);
    } else if (existingBadge) {
      existingBadge.remove();
    }
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
    if (!unregisteredPoVendorsCache) unregisteredPoVendorsCache = await api.get("/api/admin/vendors/unregistered-po-vendors");
    if (vendorProfileId) {
      const v = vendorsCache.find((x) => x.id === vendorProfileId);
      if (v) {
        await renderVendorProfile(content, v);
        return;
      }
      vendorProfileId = null;
    }
    renderVendorsUI(content);
  }

  const ONBOARDING_STALE_DAYS = 7;
  // Mirrors db.js's 3 *real* case types -- the welcome email isn't a case
  // (no New/In Review/Approved/Denied vocabulary makes sense for "did I
  // send an email"), so it's deliberately left out of this list and shown
  // as its own plain line instead (see renderWelcomeEmailLine below). Kept
  // as a small client-side constant rather than fetched from the bulk
  // case-summary endpoint so the vendor edit modal's Cases section can
  // render immediately from a single per-vendor `/requests` call instead
  // of pulling every vendor's case summary just to get this static list.
  const ONBOARDING_CASE_TYPES = [
    { type: "Onboarding - COI", key: "coi", label: "COI" },
    { type: "Onboarding - W8/W9", key: "w9", label: "W-9" },
    { type: "Onboarding - Payment Details", key: "payment", label: "Payment / ACH" },
  ];
  const WELCOME_EMAIL_REQUEST_TYPE = "Onboarding - Request";
  function latestCaseOfType(entries, type) {
    const matches = entries.filter((e) => e.requestType === type);
    if (matches.length === 0) return null;
    return matches.reduce((latest, e) =>
      new Date(e.updatedAt || e.requestedAt) >= new Date(latest.updatedAt || latest.requestedAt) ? e : latest
    );
  }
  // Not a case -- just "has the welcome email gone out, and when." A
  // plain line with a one-click "Mark sent" rather than a status pill,
  // since there's nothing to approve or deny here.
  function renderWelcomeEmailLine(latest) {
    if (latest) {
      return `<div class="onboarding-welcome-line">Welcome email sent ${new Date(latest.updatedAt || latest.requestedAt).toLocaleDateString()}</div>`;
    }
    return `
      <div class="onboarding-welcome-line">
        <span>Welcome email not yet sent</span>
        <button type="button" class="btn btn-link onboarding-welcome-send-btn">Mark sent</button>
      </div>
    `;
  }
  function wireWelcomeEmailLine(host, v, onLogged) {
    const btn = host.querySelector(".onboarding-welcome-send-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      try {
        await api.post(`/api/admin/vendors/${v.id}/requests`, { requestType: WELCOME_EMAIL_REQUEST_TYPE, status: "Sent" });
        invalidateVendorsCache();
        await onLogged();
      } catch (err) {
        window.alert(err.message);
      }
    });
  }
  const CASE_STATUS_OPTIONS = ["New", "In Review", "Needs Adjustment", "Approved", "Denied"];
  function caseStatusBadgeClass(status) {
    const s = String(status || "").trim().toLowerCase();
    if (s === "approved") return "approved";
    if (s === "denied") return "rejected";
    return "draft";
  }
  // A vendor's services are stored as a single "|"-joined string (never a
  // character any real COI matrix label contains) rather than a second
  // table, since it's just a list of matrix labels picked off one fixed
  // vocabulary -- splitting/joining here is all a multi-value field needs.
  // A legacy single value (no "|" at all, predating multi-select) still
  // splits into its own one-item list unchanged.
  function splitServices(raw) {
    return (raw || "").split("|").map((s) => s.trim()).filter(Boolean);
  }
  function formatServicesList(raw) {
    return splitServices(raw).join(", ");
  }

  // The four coverage figures Krista actually reads off the welcome email
  // she sends vendors (GL, Auto, WC, Umbrella) -- shown next to the COI
  // case as a reference while she checks a submitted certificate, pulled
  // from the same COI matrix that already drives the Vendors tab's
  // Services dropdown, not re-entered here. A vendor with more than one
  // service gets one line per service rather than a merged "strictest
  // wins" figure -- the dollar strings here ("$1M", "$0.25M / $1M") aren't
  // reliably comparable as plain text, and showing each service's own real
  // requirement is more trustworthy than a guess at which is bigger.
  function coiRequirementLine(v) {
    const lines = splitServices(v.services)
      .map((service) => {
        const entry = COI_MATRIX_BY_LABEL[service];
        if (!entry) return null;
        const r = entry.requirements;
        const parts = [];
        if (r.glOcc && r.glOcc !== "-") parts.push(`GL ${r.glOcc}${r.glAgg && r.glAgg !== "-" ? ` / ${r.glAgg}` : ""}`);
        if (r.auto && r.auto !== "-") parts.push(`Auto ${r.auto}`);
        if (r.wc && r.wc !== "-") parts.push(`WC ${r.wc}`);
        if (r.exs && r.exs !== "-") parts.push(`Umbrella ${r.exs}`);
        return parts.length ? `Required (${service}): ${parts.join(" · ")}` : null;
      })
      .filter(Boolean);
    return lines.join("; ");
  }

  // updateVendor rewrites the whole record, not just the fields being
  // changed here -- carry every other field through unchanged (same
  // "don't accidentally blank the rest of the record" lesson as the
  // roster's own Terminate action) so flipping a stage or logging a case
  // update from this tab never touches anything else about the vendor.
  function vendorFullPayload(v, overrides) {
    return {
      name: v.name,
      jdeVendorNumber: v.jdeVendorNumber,
      cwStatus: v.cwStatus,
      toyotaStatus: v.toyotaStatus,
      formsStatus: v.formsStatus,
      rawStatusText: v.rawStatusText,
      poEmail: v.poEmail,
      invoicedPreviously: v.invoicedPreviously,
      successfulInvoiceRecords: v.successfulInvoiceRecords,
      successfulSinceDate: v.successfulSinceDate,
      midwestSitesSeen: v.midwestSitesSeen,
      services: v.services,
      trackerWorkExamples: v.trackerWorkExamples,
      coverageOutsideMidwest: v.coverageOutsideMidwest,
      phone: v.phone,
      email: v.email,
      onlineSourceUrl: v.onlineSourceUrl,
      notes: v.notes,
      coiMeetsRequiredLimits: v.coiMeetsRequiredLimits,
      coiMeetsLanguageRequirements: v.coiMeetsLanguageRequirements,
      coiLimits: v.coiLimits,
      formChecks: v.formChecks,
      w9InvoiceDate: v.w9InvoiceDate,
      onboardingStage: v.onboardingStage,
      deniedReason: v.deniedReason,
      ...overrides,
    };
  }

  function daysSince(iso) {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  // Mirrors ServiceEdge's own onboarding model: a vendor being onboarded
  // has (up to) three independent cases -- COI, W-9, Payment Details --
  // each carrying its own status, plus a Request case that just marks the
  // welcome email as sent. Re-submitting after a denial opens a brand new
  // case of the same type rather than editing the old one (that's how
  // ServiceEdge itself works), so "current status" for each case type is
  // always its latest entry -- computed server-side in
  // deriveOnboardingStage (db.js), never set by hand here. All three
  // approved moves a vendor to Onboarded; any one denied moves it to
  // Denied; adding a vendor (Vendors tab) starts it here automatically as
  // In Progress. This board shows status only, never a vendor's actual
  // documents -- those stay on the vendor's own Documents tab -- so anyone
  // with admin access can see exactly where a vendor stands without
  // touching anything private.
  async function drawVendorOnboarding(content) {
    if (!vendorsCache) vendorsCache = await api.get("/api/admin/vendors");
    const vendors = vendorsCache;
    const caseTypes = ONBOARDING_CASE_TYPES;
    const { summaries } = await api.get("/api/admin/vendors/onboarding/case-summary");

    const notStarted = vendors.filter((v) => v.onboardingStage === "not_started");
    const inProgress = vendors
      .filter((v) => v.onboardingStage === "in_progress")
      .sort((a, b) => daysSince(b.updatedAt) - daysSince(a.updatedAt));
    const denied = vendors.filter((v) => v.onboardingStage === "denied").sort((a, b) => a.name.localeCompare(b.name));
    const complianceNeeded = vendors
      .filter((v) => v.onboardingStage === "onboarded" && (v.formsStatus === "outdated" || !v.formChecksComplete || v.w9InvoiceStale))
      .sort((a, b) => a.name.localeCompare(b.name));

    content.innerHTML = `
      <p class="review-checklist-hint">
        Onboarding is tracked as ServiceEdge tracks it -- a COI case, a W-9 case, and a Payment
        Details case per vendor, all three under the one parent Toyota Onboarding case, each
        independently approved or denied. All three approved moves a vendor to Onboarded; any one
        denied moves it to Denied. A vendor with no case update in ${ONBOARDING_STALE_DAYS}+ days is
        flagged so nothing quietly sits untouched. This board shows case status only, never a
        vendor's actual documents.
      </p>
      <h3>Start Onboarding</h3>
      <p class="review-checklist-hint">
        ${notStarted.length} vendor${notStarted.length === 1 ? "" : "s"} on file ${notStarted.length === 1 ? "hasn't" : "haven't"}
        had onboarding started yet -- every vendor already on file before this tracker existed
        defaults here rather than to In Progress. Search by name and click Start to record the
        welcome email and move one onto the board below. A brand new vendor (Vendors tab -- Add
        vendor) starts as In Progress automatically instead.
      </p>
      <div class="onboarding-start-search">
        <input type="text" id="onboarding-start-search-input" placeholder="Search vendor name to start onboarding..." />
      </div>
      <div class="review-list" id="onboarding-start-results"></div>
      <h3>In Progress (${inProgress.length})</h3>
      <div class="review-list" id="onboarding-in-progress-list"></div>
      <h3>Denied (${denied.length})</h3>
      <div class="review-list" id="onboarding-denied-list"></div>
      <h3>Compliance Needed (${complianceNeeded.length})</h3>
      <p class="review-checklist-hint">
        Already-onboarded vendors whose forms have gone out of date -- vendor document compliance
        only, separate from technician/employee compliance (see Roster).
      </p>
      <div class="review-list" id="onboarding-compliance-list"></div>
    `;

    const searchInput = content.querySelector("#onboarding-start-search-input");
    const startResults = content.querySelector("#onboarding-start-results");
    function renderStartResults(query) {
      const q = query.trim().toLowerCase();
      if (!q) {
        startResults.innerHTML = `<p class="empty-note">Type a vendor name to find one to start.</p>`;
        return;
      }
      const matches = notStarted.filter((v) => v.name.toLowerCase().includes(q));
      if (matches.length === 0) {
        startResults.innerHTML = `<p class="empty-note">No not-started vendor matches "${escapeHtml(query)}".</p>`;
        return;
      }
      startResults.innerHTML = "";
      matches.slice(0, 20).forEach((v) => {
        const row = document.createElement("div");
        row.className = "review-row onboarding-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(v.name)}</span>
            <span class="vendor-jde">${escapeHtml(v.jdeVendorNumber || "No JDE #")}</span>
            <button class="btn btn-primary onboarding-start-btn" type="button">Start Onboarding</button>
          </div>
        `;
        row.querySelector(".onboarding-start-btn").addEventListener("click", async () => {
          try {
            await api.post(`/api/admin/vendors/${v.id}/requests`, { requestType: WELCOME_EMAIL_REQUEST_TYPE, status: "Sent" });
            invalidateVendorsCache();
            await drawVendorOnboarding(content);
          } catch (err) {
            window.alert(err.message);
          }
        });
        startResults.appendChild(row);
      });
    }
    renderStartResults("");
    searchInput.addEventListener("input", () => renderStartResults(searchInput.value));

    const inProgressList = content.querySelector("#onboarding-in-progress-list");
    if (inProgress.length === 0) {
      inProgressList.innerHTML = `<p class="empty-note">Nothing currently being onboarded.</p>`;
    } else {
      inProgress.forEach((v) => inProgressList.appendChild(renderOnboardingRow(v, content, caseTypes, summaries[v.id] || {})));
    }

    const deniedList = content.querySelector("#onboarding-denied-list");
    if (denied.length === 0) {
      deniedList.innerHTML = `<p class="empty-note">No denied vendors.</p>`;
    } else {
      denied.forEach((v) => deniedList.appendChild(renderOnboardingRow(v, content, caseTypes, summaries[v.id] || {})));
    }

    const complianceList = content.querySelector("#onboarding-compliance-list");
    if (complianceNeeded.length === 0) {
      complianceList.innerHTML = `<p class="empty-note">No onboarded vendors are out of compliance.</p>`;
    } else {
      complianceNeeded.forEach((v) => complianceList.appendChild(renderComplianceRow(v, content)));
    }
  }

  function renderComplianceRow(v, content) {
    const el = document.createElement("div");
    el.className = "review-row onboarding-row";
    el.innerHTML = `
      <div class="review-row-summary">
        <span class="review-row-name">${escapeHtml(v.name)}</span>
        ${v.formsStatus === "outdated" ? `<span class="badge badge-rejected">Forms Outdated</span>` : ""}
        ${!v.formChecksComplete ? `<span class="badge badge-rejected">Doc checks incomplete</span>` : ""}
        ${v.w9InvoiceStale ? `<span class="badge badge-rejected">W-9 invoice stale</span>` : ""}
        <button class="btn btn-secondary onboarding-review-compliance-btn" type="button">Review Compliance</button>
      </div>
    `;
    el.querySelector(".onboarding-review-compliance-btn").addEventListener("click", () => {
      openVendorProfile(v.id, "onboarding");
    });
    return el;
  }

  function renderOnboardingRow(v, content, caseTypes, caseSummary) {
    const el = document.createElement("div");
    const age = daysSince(v.updatedAt);
    const stale = v.onboardingStage === "in_progress" && age >= ONBOARDING_STALE_DAYS;
    el.className = `review-row onboarding-row${stale ? " review-row-pending" : ""}`;

    el.innerHTML = `
      <div class="review-row-summary">
        <span class="review-row-name">${escapeHtml(v.name)}</span>
        <span class="wom-desc">${age === 0 ? "updated today" : `${age}d since last update`}</span>
        ${stale ? `<span class="badge badge-rejected">Stale</span>` : ""}
        <button class="btn btn-secondary onboarding-open-vendor-btn" type="button">Open vendor</button>
        <button class="btn btn-link onboarding-log-toggle" type="button">Full case history</button>
      </div>
      ${renderWelcomeEmailLine(caseSummary.request)}
      <div class="onboarding-cases-heading">Toyota Onboarding</div>
      <div class="onboarding-cases">
        ${caseTypes.map((ct) => renderCasePillHtml(v, ct, caseSummary[ct.key])).join("")}
      </div>
      ${
        v.onboardingStage === "denied"
          ? `<div class="onboarding-denied-reason">
               <input type="text" class="onboarding-denied-reason-input" placeholder="Note (optional, e.g. which case and why)" value="${escapeHtml(v.deniedReason)}" />
               <button type="button" class="btn btn-link onboarding-denied-reason-save">Save note</button>
             </div>`
          : ""
      }
      <div class="review-row-detail onboarding-case-log" hidden></div>
    `;

    el.querySelector(".onboarding-open-vendor-btn").addEventListener("click", () => {
      openVendorProfile(v.id, "onboarding");
    });
    wireWelcomeEmailLine(el, v, () => drawVendorOnboarding(content));

    const deniedReasonSave = el.querySelector(".onboarding-denied-reason-save");
    if (deniedReasonSave) {
      deniedReasonSave.addEventListener("click", async () => {
        const reasonInput = el.querySelector(".onboarding-denied-reason-input");
        try {
          await api.patch(`/api/admin/vendors/${v.id}`, vendorFullPayload(v, { deniedReason: reasonInput.value.trim() }));
          invalidateVendorsCache();
        } catch (err) {
          window.alert(err.message);
        }
      });
    }

    caseTypes.forEach((ct) => {
      const caseEl = el.querySelector(`.onboarding-case[data-case-key="${ct.key}"]`);
      wireCasePill(caseEl, v, ct, () => drawVendorOnboarding(content), caseSummary[ct.key]);
    });

    const logToggle = el.querySelector(".onboarding-log-toggle");
    const logHost = el.querySelector(".onboarding-case-log");
    let logLoaded = false;
    logToggle.addEventListener("click", async () => {
      logHost.hidden = !logHost.hidden;
      logToggle.textContent = logHost.hidden ? "Full case history" : "Hide case history";
      if (!logHost.hidden && !logLoaded) {
        logLoaded = true;
        await renderCaseLog(logHost, v);
      }
    });

    return el;
  }

  // "As of" is a plain YYYY-MM-DD (an <input type="date">'s own value, and
  // what's stored in as_of) -- reformatted directly as text, never through
  // `new Date(...)`, which would parse it as UTC midnight and can print the
  // wrong calendar day in a timezone behind UTC.
  function formatCaseDate(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return `${m}/${d}/${y}`;
  }
  function todayDateInputValue() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function renderCasePillHtml(v, ct, latest) {
    const coiRef = ct.key === "coi" ? coiRequirementLine(v) : "";
    const asOfLabel = latest ? formatCaseDate(latest.asOf) : null;
    return `
      <div class="onboarding-case" data-case-key="${ct.key}">
        <div class="onboarding-case-summary">
          <span class="onboarding-case-label">${escapeHtml(ct.label)}</span>
          <span class="badge badge-${caseStatusBadgeClass(latest && latest.status)}">${latest ? escapeHtml(latest.status || "No status") : "Not started"}</span>
          ${latest && latest.referenceNumber ? `<span class="onboarding-case-ref">#${escapeHtml(latest.referenceNumber)}</span>` : ""}
          <button type="button" class="btn btn-link onboarding-case-log-new">Log update</button>
          ${latest ? `<button type="button" class="btn btn-link onboarding-case-edit">Edit</button>` : ""}
        </div>
        ${coiRef ? `<div class="onboarding-case-coi-ref">${escapeHtml(coiRef)}</div>` : ""}
        ${
          latest && (latest.note || asOfLabel)
            ? `<div class="onboarding-case-note">${latest.note ? escapeHtml(latest.note) : ""}${asOfLabel ? ` <span class="onboarding-case-asof">(as of ${asOfLabel})</span>` : ""}</div>`
            : ""
        }
        <div class="onboarding-case-form" hidden>
          <select class="onboarding-case-status-select">
            ${CASE_STATUS_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("")}
          </select>
          <input type="text" class="onboarding-case-ref-input" placeholder="Case # (optional)" />
          <input type="text" class="onboarding-case-note-input" placeholder="Note (optional, e.g. what's missing)" />
          <label class="onboarding-case-asof-label">As of <input type="date" class="onboarding-case-asof-input" /></label>
          <button type="button" class="btn btn-primary onboarding-case-save">Save</button>
          <button type="button" class="btn btn-link onboarding-case-cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  // Shared between the Onboarding board's rows and the vendor edit modal's
  // own Cases section -- both render the same case-pill markup
  // (renderCasePillHtml) and need the same "toggle a small log-update
  // form, save it, then re-render" behavior. The note is stored in its own
  // column, never appended to `status` itself, since deriveOnboardingStage
  // (db.js) matches `status` against "approved"/"denied" exactly.
  //
  // "Log update" always starts a blank form and POSTs a brand new case
  // entry (ServiceEdge's own convention -- re-submitting after a denial
  // opens a new case rather than editing the old one). "Edit" instead
  // pre-fills the form from the latest entry and PATCHes it in place --
  // for correcting a typo'd note or an as-of date logged wrong, not a real
  // new case, so it shouldn't leave a confusing near-duplicate behind in
  // the history.
  function wireCasePill(caseEl, v, ct, onLogged, latest) {
    const toggleBtn = caseEl.querySelector(".onboarding-case-log-new");
    const editBtn = caseEl.querySelector(".onboarding-case-edit");
    const form = caseEl.querySelector(".onboarding-case-form");
    const statusSelect = caseEl.querySelector(".onboarding-case-status-select");
    const refInput = caseEl.querySelector(".onboarding-case-ref-input");
    const noteInput = caseEl.querySelector(".onboarding-case-note-input");
    const asOfInput = caseEl.querySelector(".onboarding-case-asof-input");
    let editingId = null;

    function openForm(prefillFrom) {
      editingId = prefillFrom ? prefillFrom.id : null;
      statusSelect.value = prefillFrom ? prefillFrom.status || CASE_STATUS_OPTIONS[0] : CASE_STATUS_OPTIONS[0];
      refInput.value = prefillFrom ? prefillFrom.referenceNumber || "" : "";
      noteInput.value = prefillFrom ? prefillFrom.note || "" : "";
      asOfInput.value = (prefillFrom && prefillFrom.asOf && prefillFrom.asOf.slice(0, 10)) || todayDateInputValue();
      form.hidden = false;
    }
    toggleBtn.addEventListener("click", () => (form.hidden ? openForm(null) : (form.hidden = true)));
    if (editBtn) editBtn.addEventListener("click", () => (form.hidden ? openForm(latest) : (form.hidden = true)));
    caseEl.querySelector(".onboarding-case-cancel").addEventListener("click", () => {
      form.hidden = true;
    });
    caseEl.querySelector(".onboarding-case-save").addEventListener("click", async () => {
      const status = statusSelect.value;
      const referenceNumber = refInput.value.trim();
      const note = noteInput.value.trim();
      const asOf = asOfInput.value || null;
      try {
        if (editingId) {
          await api.patch(`/api/admin/vendors/${v.id}/requests/${editingId}`, { requestType: ct.type, status, referenceNumber, note, asOf });
        } else {
          await api.post(`/api/admin/vendors/${v.id}/requests`, { requestType: ct.type, status, referenceNumber, note, asOf });
        }
        invalidateVendorsCache();
        await onLogged();
      } catch (err) {
        window.alert(err.message);
      }
    });
  }

  // The vendor edit modal's own view of the same 4 cases the Onboarding
  // board tracks -- so seeing (and logging) a vendor's case status doesn't
  // require leaving the modal to go search for it on a separate tab. Only
  // one vendor's cases are needed here, so it fetches that vendor's own
  // `/requests` log directly rather than the board's bulk case-summary
  // endpoint (which computes this for every vendor at once).
  async function renderVendorCasesSection(host, v) {
    host.innerHTML = `<p class="review-checklist-hint">Loading cases…</p>`;
    const entries = await api.get(`/api/admin/vendors/${v.id}/requests`);
    host.innerHTML = `
      ${renderWelcomeEmailLine(latestCaseOfType(entries, WELCOME_EMAIL_REQUEST_TYPE))}
      <div class="onboarding-cases-heading">Toyota Onboarding</div>
      <div class="onboarding-cases">
        ${ONBOARDING_CASE_TYPES.map((ct) => renderCasePillHtml(v, ct, latestCaseOfType(entries, ct.type))).join("")}
      </div>
      <button type="button" class="btn btn-link vendor-case-history-toggle">Full case history</button>
      <div class="onboarding-case-log" hidden></div>
    `;
    wireWelcomeEmailLine(host, v, () => renderVendorCasesSection(host, v));
    ONBOARDING_CASE_TYPES.forEach((ct) => {
      const caseEl = host.querySelector(`.onboarding-case[data-case-key="${ct.key}"]`);
      wireCasePill(caseEl, v, ct, () => renderVendorCasesSection(host, v), latestCaseOfType(entries, ct.type));
    });
    const historyToggle = host.querySelector(".vendor-case-history-toggle");
    const historyHost = host.querySelector(".onboarding-case-log");
    let historyLoaded = false;
    historyToggle.addEventListener("click", async () => {
      historyHost.hidden = !historyHost.hidden;
      historyToggle.textContent = historyHost.hidden ? "Full case history" : "Hide case history";
      if (!historyHost.hidden && !historyLoaded) {
        historyLoaded = true;
        await renderCaseLog(historyHost, v);
      }
    });
  }

  async function renderCaseLog(host, v) {
    host.innerHTML = `<p class="review-checklist-hint">Loading…</p>`;
    const entries = await api.get(`/api/admin/vendors/${v.id}/requests`);
    host.innerHTML = `
      <div class="onboarding-case-entries">
        ${
          entries.length === 0
            ? `<p class="empty-note">No cases logged yet.</p>`
            : entries
                .map(
                  (e) => `
              <p class="onboarding-case-entry">
                <strong>${escapeHtml(e.requestType)}</strong>${e.referenceNumber ? ` #${escapeHtml(e.referenceNumber)}` : ""}
                — <span class="badge badge-${caseStatusBadgeClass(e.status)}">${escapeHtml(e.status || "no status")}</span>
                <span class="task-comment-time">logged ${new Date(e.updatedAt || e.requestedAt).toLocaleString()}${
                    formatCaseDate(e.asOf) ? ` · as of ${formatCaseDate(e.asOf)}` : ""
                  }</span>
                ${e.note ? `<br /><span class="onboarding-case-note">${escapeHtml(e.note)}</span>` : ""}
              </p>
            `
                )
                .join("")
        }
      </div>
    `;
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
      <h3>Vendor Directory</h3>
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
      ${
        unregisteredPoVendorsCache.length === 0
          ? ""
          : `<div class="expiring-forms-banner">
              <div class="expiring-forms-title">Vendors with no profile on file</div>
              <div class="expiring-forms-row">
                <span class="rfm-flag">Unregistered</span>
                <span>${unregisteredPoVendorsCache.length} vendor${unregisteredPoVendorsCache.length === 1 ? "" : "s"} show${unregisteredPoVendorsCache.length === 1 ? "s" : ""} up on a Budget PO by name and JDE # but ${unregisteredPoVendorsCache.length === 1 ? "has" : "have"} no vendor profile here yet.</span>
                <button class="btn btn-link vendor-view-unregistered-btn" type="button">${showUnregisteredPoVendors ? "Hide" : "View"}</button>
              </div>
              ${showUnregisteredPoVendors ? renderUnregisteredPoVendorsList(content) : ""}
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
        <button class="btn btn-secondary vendor-add-toggle" type="button">+ Add vendor</button>
      </div>
      <p class="vendor-count"></p>
      <div class="review-list" id="vendor-list"></div>
    `;

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
      openAddVendorModal(content);
    });
    const viewOutdatedBtn = content.querySelector(".vendor-view-outdated-btn");
    if (viewOutdatedBtn) {
      viewOutdatedBtn.addEventListener("click", () => {
        vendorFilters.formsStatus = "outdated";
        renderVendorsUI(content);
      });
    }
    const viewUnregisteredBtn = content.querySelector(".vendor-view-unregistered-btn");
    if (viewUnregisteredBtn) {
      viewUnregisteredBtn.addEventListener("click", () => {
        showUnregisteredPoVendors = !showUnregisteredPoVendors;
        renderVendorsUI(content);
      });
    }
    content.querySelectorAll(".unregistered-po-vendor-create-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openAddVendorModal(content, { name: btn.dataset.name, jdeVendorNumber: btn.dataset.vendorNumber });
      });
    });

    refreshVendorList(content);
  }

  // Plain HTML string (not a DOM mutation) so it can sit inline inside
  // renderVendorsUI's own template literal -- the "Create vendor profile"
  // buttons it renders are wired up alongside the rest of that function's
  // listeners, after the real innerHTML assignment.
  function renderUnregisteredPoVendorsList(content) {
    return `
      <table class="detail-table unregistered-po-vendor-table">
        <thead><tr><th>Vendor Name (as imported)</th><th>JDE Vendor #</th><th>PO Count</th><th>Total $</th><th></th></tr></thead>
        <tbody>
          ${unregisteredPoVendorsCache
            .map(
              (v) => `
            <tr>
              <td>${escapeHtml(v.vendorName || "(no name on file)")}</td>
              <td>${escapeHtml(v.vendorNumber)}</td>
              <td>${v.poCount}</td>
              <td>$${formatMoney(v.totalAmount || 0)}</td>
              <td><button type="button" class="btn btn-secondary unregistered-po-vendor-create-btn" data-name="${escapeHtml(v.vendorName || "")}" data-vendor-number="${escapeHtml(v.vendorNumber)}">Create vendor profile</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
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

  function openAddVendorModal(content, prefill) {
    const { body, close } = openModal({
      title: "Add Vendor",
      bodyHtml: `
        <form class="add-vendor-form modal-form">
          <div class="add-tech-grid">
            <input name="name" placeholder="Vendor name" value="${escapeHtml(prefill?.name || "")}" required />
            <input name="jdeVendorNumber" placeholder="JDE Vendor #" value="${escapeHtml(prefill?.jdeVendorNumber || "")}" />
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
          <p class="review-checklist-hint">
            Starts this vendor as In Progress on the Onboarding tab automatically, with all 4 cases
            (Request, COI, W-9, Payment) not yet started.
          </p>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Add vendor</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const addForm = body.querySelector(".add-vendor-form");
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = addForm.querySelector(".save-message");
      try {
        const created = await api.post("/api/admin/vendors", {
          name: addForm.name.value.trim(),
          jdeVendorNumber: addForm.jdeVendorNumber.value.trim(),
          cwStatus: addForm.cwStatus.value,
          toyotaStatus: addForm.toyotaStatus.value,
          services: selectedServicesValue(addForm.services),
        });
        invalidateVendorsCache();
        close();
        // Straight into the new vendor's own profile -- Add vendor -> Open
        // profile -> Start onboarding is the whole flow, not three separate
        // trips back to the directory list.
        openVendorProfile(created.id);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // Opening a vendor used to expand its edit form inline in the list --
  // fine for a short list, but scrolling back down to find your spot in a
  // 292-row list every time is exactly the "doesn't feel like an
  // application" friction the pop-up dialog pattern (modal.js) exists to
  // fix elsewhere (WOM Smartsheet detail, document viewer). Same fix here.
  const VENDOR_DOC_CATEGORIES = [
    { value: "coi", label: "COI (Certificate of Insurance)" },
    { value: "w9", label: "W-9" },
    { value: "ach", label: "ACH / Bank Letter" },
    { value: "vpo_waiver", label: "VPO Waiver" },
    { value: "vendor_other", label: "Other Vendor Document" },
  ];

  // A COI (or other document) that arrived before it was clear which
  // vendor it belonged to gets parked on a task instead (see tasks.js's
  // own Documents panel) -- this is the other end of that: once the
  // vendor's known, assign it here rather than re-uploading it, which
  // moves the same file (not a copy) from the task onto this vendor's
  // own record.
  async function renderAssignTaskDocumentControl(host, v, onAssigned) {
    let pending = [];
    try {
      pending = await api.get("/api/files/task-documents");
    } catch {
      pending = [];
    }
    if (pending.length === 0) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = `
      <div class="vendor-assign-task-doc">
        <select class="vendor-assign-task-doc-select">
          ${pending
            .map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.originalName)} — from task: ${escapeHtml(f.taskTitle || "(task deleted)")}</option>`)
            .join("")}
        </select>
        <select class="vendor-assign-task-doc-category">
          ${VENDOR_DOC_CATEGORIES.map((c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <button type="button" class="btn btn-secondary vendor-assign-task-doc-btn">Assign to this vendor</button>
      </div>
    `;
    host.querySelector(".vendor-assign-task-doc-btn").addEventListener("click", async () => {
      const fileId = host.querySelector(".vendor-assign-task-doc-select").value;
      const category = host.querySelector(".vendor-assign-task-doc-category").value;
      try {
        await api.patch(`/api/files/${fileId}/relocate`, { relatedType: "vendor", relatedId: v.id, category });
        await onAssigned();
        await renderAssignTaskDocumentControl(host, v, onAssigned);
      } catch (err) {
        window.alert(err.message);
      }
    });
  }

  // The profile's "Edit vendor" button -- just the editable fields, in a
  // focused modal, rather than a giant form embedded in the page itself.
  // Onboarding/cost-history/documents each have their own profile tab now,
  // so they're not part of this form anymore.
  function openVendorEditFormModal(v, content) {
    const { body, close } = openModal({
      title: `Edit ${v.name}`,
      size: "large",
      bodyHtml: renderVendorEditFormFields(v),
    });
    const form = body.querySelector(".vendor-edit-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        const updated = await api.patch(
          `/api/admin/vendors/${v.id}`,
          vendorFullPayload(v, {
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
            services: selectedServicesValue(form.services),
            invoicedPreviously: form.invoicedPreviously.value.trim(),
            successfulInvoiceRecords: form.successfulInvoiceRecords.value === "" ? null : Number(form.successfulInvoiceRecords.value),
            successfulSinceDate: form.successfulSinceDate.value || null,
            trackerWorkExamples: form.trackerWorkExamples.value.trim(),
            coverageOutsideMidwest: form.coverageOutsideMidwest.value.trim(),
            notes: form.notes.value.trim(),
          })
        );
        Object.assign(v, updated);
        invalidateVendorsCache();
        close();
        await drawVendors(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    body.querySelector(".cancel-vendor-edit").addEventListener("click", () => close());
    body.querySelector(".delete-vendor-btn").addEventListener("click", async () => {
      if (!window.confirm(`Remove vendor "${v.name}"? This can't be undone.`)) return;
      try {
        await api.delete(`/api/admin/vendors/${v.id}`);
        invalidateVendorsCache();
        vendorProfileId = null;
        close();
        await drawVendors(content);
      } catch (err) {
        window.alert(`Could not remove: ${err.message}`);
      }
    });
  }

  function renderVendorRow(v, content) {
    const el = document.createElement("div");
    el.className = "review-row vendor-row";

    el.innerHTML = `
      <div class="review-row-summary vendor-summary">
        <span class="review-row-name">
          ${v.preferred ? `<span class="vendor-preferred-star is-preferred" title="Preferred vendor">★</span>` : ""}
          ${escapeHtml(v.name)}
          ${v.services ? `<span class="wom-desc"> — ${escapeHtml(formatServicesList(v.services))}</span>` : ""}
        </span>
        <span class="vendor-jde">${escapeHtml(v.jdeVendorNumber || "No JDE #")}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.cwStatus]}">${escapeHtml(CW_STATUS_LABELS[v.cwStatus])}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.toyotaStatus]}">${escapeHtml(TOYOTA_STATUS_LABELS[v.toyotaStatus])}</span>
        <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.formsStatus]}">${escapeHtml(FORMS_STATUS_LABELS[v.formsStatus])}</span>
        ${!v.formChecksComplete || v.w9InvoiceStale ? `<span class="badge badge-rejected">Doc checks incomplete</span>` : ""}
        ${v.onboardingStage === "in_progress" ? `<span class="badge badge-draft">Onboarding: In Progress</span>` : ""}
        ${v.onboardingStage === "denied" ? `<span class="badge badge-rejected">Onboarding: Denied</span>` : ""}
        ${v.openTaskCount > 0 ? `<span class="chip">${v.openTaskCount} open task${v.openTaskCount === 1 ? "" : "s"}</span>` : ""}
        <button class="btn btn-secondary vendor-open-btn" type="button">Open</button>
      </div>
    `;
    el.querySelector(".vendor-open-btn").addEventListener("click", () => {
      openVendorProfile(v.id);
    });
    return el;
  }

  const VENDOR_PROFILE_TABS = [
    { key: "overview", label: "Overview" },
    { key: "onboarding", label: "Onboarding & Compliance" },
    { key: "tasks", label: "Tasks" },
    { key: "documents", label: "Documents" },
    { key: "costs", label: "Work & Costs" },
    { key: "activity", label: "Activity" },
  ];
  const ONBOARDING_STAGE_LABELS = { not_started: "Not Started", in_progress: "In Progress", denied: "Denied", onboarded: "Onboarded" };
  const ONBOARDING_STAGE_BADGE_CLASS = { not_started: "draft", in_progress: "draft", denied: "rejected", onboarded: "approved" };

  // The full vendor profile page -- replaces the old single long edit
  // modal. Read-only Overview by default; Edit vendor opens just the
  // editable fields in a focused modal. Every other tab reuses the exact
  // same render/wire functions the Onboarding board and Task Manager
  // already use against the same underlying records, so updating a case,
  // task, or document from here updates it everywhere else too.
  async function renderVendorProfile(content, v) {
    content.innerHTML = `
      <button type="button" class="btn btn-link vendor-back-btn">&larr; Vendor Directory</button>
      <div class="page-header">
        <div>
          <h1 class="page-header-title">
            <button type="button" class="vendor-preferred-star ${v.preferred ? "is-preferred" : ""}" title="${v.preferred ? "Preferred vendor -- click to unmark" : "Mark as preferred vendor"}">${v.preferred ? "★" : "☆"}</button>
            ${escapeHtml(v.name)}
          </h1>
          <p class="page-header-subtitle">
            <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.cwStatus]}">${escapeHtml(CW_STATUS_LABELS[v.cwStatus])}</span>
            <span class="badge badge-${VENDOR_STATUS_BADGE_CLASS[v.toyotaStatus]}">${escapeHtml(TOYOTA_STATUS_LABELS[v.toyotaStatus])}</span>
            ${v.preferred ? `<span class="badge badge-approved">Preferred</span>` : ""}
          </p>
        </div>
        <div class="page-header-actions">
          <button type="button" class="btn btn-outline vendor-edit-btn">Edit vendor</button>
          <button type="button" class="btn btn-link vendor-delete-btn">Delete vendor</button>
        </div>
      </div>
      <div class="tabs vendor-profile-tabs">
        ${VENDOR_PROFILE_TABS.map((t) => `<button class="tab ${vendorProfileTab === t.key ? "active" : ""}" data-tab="${t.key}" type="button">${t.label}</button>`).join("")}
      </div>
      <div class="vendor-profile-body"></div>
    `;

    content.querySelector(".vendor-back-btn").addEventListener("click", () => {
      vendorProfileId = null;
      drawVendors(content);
    });
    content.querySelector(".vendor-edit-btn").addEventListener("click", () => {
      openVendorEditFormModal(v, content);
    });
    content.querySelector(".vendor-preferred-star").addEventListener("click", async () => {
      await api.patch(`/api/admin/vendors/${v.id}/preferred`, { preferred: !v.preferred });
      invalidateVendorsCache();
      renderVendorProfile(content, { ...v, preferred: !v.preferred });
    });
    content.querySelector(".vendor-delete-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete ${v.name}? This removes its profile, case log, tasks, and documents. This can't be undone.`)) return;
      try {
        await api.delete(`/api/admin/vendors/${v.id}`);
        invalidateVendorsCache();
        vendorProfileId = null;
        drawVendors(content);
      } catch (err) {
        window.alert(err.message);
      }
    });
    content.querySelectorAll(".vendor-profile-tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        vendorProfileTab = btn.dataset.tab;
        renderVendorProfile(content, v);
      });
    });

    const body = content.querySelector(".vendor-profile-body");
    if (vendorProfileTab === "onboarding") await renderVendorOnboardingTab(body, v);
    else if (vendorProfileTab === "tasks") await renderVendorTasksTab(body, v);
    else if (vendorProfileTab === "documents") await renderVendorDocumentsTab(body, v);
    else if (vendorProfileTab === "costs") await renderVendorCostsTab(body, v);
    else if (vendorProfileTab === "activity") await renderVendorActivityTab(body, v);
    else await renderVendorOverviewTab(body, v);
  }

  async function renderVendorOverviewTab(host, v) {
    const nextAction =
      v.onboardingStage !== "onboarded"
        ? "Continue onboarding -- see the Onboarding & Compliance tab."
        : !v.formChecksComplete || v.formsStatus === "outdated" || v.w9InvoiceStale
          ? "Update compliance documents -- see the Onboarding & Compliance tab."
          : "No action needed -- this vendor is in good standing.";
    host.innerHTML = `
      <div class="vendor-overview-grid">
        <div class="vendor-overview-card">
          <h4>Contact &amp; Services</h4>
          <dl class="vendor-overview-fields">
            <div><dt>Contact phone</dt><dd>${v.phone ? escapeHtml(v.phone) : "Not provided"}</dd></div>
            <div><dt>Email</dt><dd>${v.email ? escapeHtml(v.email) : "Not provided"}</dd></div>
            <div><dt>PO email</dt><dd>${v.poEmail ? escapeHtml(v.poEmail) : "Not provided"}</dd></div>
            <div><dt>JDE Vendor #</dt><dd>${v.jdeVendorNumber ? escapeHtml(v.jdeVendorNumber) : "Not on file"}</dd></div>
            <div><dt>Services</dt><dd>${v.services ? escapeHtml(formatServicesList(v.services)) : "Not set"}</dd></div>
            <div><dt>Coverage outside Midwest</dt><dd>${v.coverageOutsideMidwest ? escapeHtml(v.coverageOutsideMidwest) : "Not confirmed"}</dd></div>
            <div><dt>Midwest sites seen</dt><dd>${v.midwestSitesSeen ? escapeHtml(v.midwestSitesSeen) : "None on file"}</dd></div>
          </dl>
          ${v.notes ? `<h4>Notes</h4><p class="vendor-overview-notes">${escapeHtml(v.notes)}</p>` : ""}
        </div>
        <div class="vendor-overview-card">
          <h4>Onboarding summary</h4>
          <p><span class="badge badge-${ONBOARDING_STAGE_BADGE_CLASS[v.onboardingStage] || "draft"}">${escapeHtml(ONBOARDING_STAGE_LABELS[v.onboardingStage] || v.onboardingStage)}</span></p>
          <p class="vendor-next-action">${escapeHtml(nextAction)}</p>
          <p class="review-checklist-hint">
            $${formatMoney(v.totalContractedApplied || 0)} in contracted services applied across
            ${v.contractedWomCount || 0} WOM${v.contractedWomCount === 1 ? "" : "s"}. Last invoiced
            ${v.lastInvoicedAt ? new Date(v.lastInvoicedAt).toLocaleDateString() : "never yet"}.
          </p>
        </div>
      </div>
      <div class="vendor-overview-card vendor-remarks-card">
        <h4>Remarks</h4>
        <p class="review-checklist-hint">A running, dated log -- separate from Notes above, nothing here gets overwritten.</p>
        <form class="vendor-remark-form">
          <textarea name="body" rows="2" placeholder="Add a remark..." required></textarea>
          <button type="submit" class="btn btn-secondary">Add remark</button>
        </form>
        <div class="vendor-remarks-list"></div>
      </div>
    `;

    const remarkForm = host.querySelector(".vendor-remark-form");
    const remarksList = host.querySelector(".vendor-remarks-list");

    async function refreshRemarks() {
      let remarks;
      try {
        remarks = await api.get(`/api/admin/vendors/${v.id}/remarks`);
      } catch (err) {
        remarksList.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      remarksList.innerHTML =
        remarks.length === 0
          ? `<p class="empty-note">No remarks yet.</p>`
          : remarks
              .map(
                (r) => `
            <div class="vendor-remark">
              <div class="vendor-remark-meta">${escapeHtml(r.author_name)} &mdash; ${new Date(r.created_at).toLocaleString()}</div>
              <div class="vendor-remark-body">${escapeHtml(r.body)}</div>
            </div>`
              )
              .join("");
    }

    remarkForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = remarkForm.body.value.trim();
      if (!body) return;
      await api.post(`/api/admin/vendors/${v.id}/remarks`, { body });
      remarkForm.body.value = "";
      await refreshRemarks();
    });

    await refreshRemarks();
  }

  async function renderVendorOnboardingTab(host, v) {
    host.innerHTML = `
      <h4>Onboarding cases</h4>
      <div class="vendor-cases-section"></div>
      <h4>Document Compliance</h4>
      <div class="vendor-doc-checks-host"></div>
      <h4>Compliance Follow-up</h4>
      <p class="review-checklist-hint">
        A follow-up task is generated automatically whenever this vendor needs attention (an
        unconfirmed document check, outdated forms, a stale W-9 invoice, or an expired COI/W-9/ACH
        upload) -- work it, snooze it, or comment on it from Task Manager like any other task. It
        closes on its own once the actual gap is fixed; notes logged on it stay visible here even
        after it's done.
      </p>
      <div class="vendor-compliance-tasks-host"></div>
    `;
    renderVendorCasesSection(host.querySelector(".vendor-cases-section"), v);
    const docChecksHost = host.querySelector(".vendor-doc-checks-host");
    function attachDocChecksForm() {
      docChecksHost.innerHTML = renderVendorDocChecksForm(v);
      wireVendorDocChecksForm(docChecksHost.querySelector(".vendor-doc-checks-form"), v, (updated) => {
        Object.assign(v, updated);
        invalidateVendorsCache();
        attachDocChecksForm();
      });
    }
    attachDocChecksForm();
    await renderVendorComplianceTasks(host.querySelector(".vendor-compliance-tasks-host"), v);
  }

  async function renderVendorTasksTab(host, v) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let tasks;
    try {
      tasks = await api.get(`/api/admin/vendors/${v.id}/tasks`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (tasks.length === 0) {
      host.innerHTML = `<p class="empty-note">No tasks linked to this vendor.</p>`;
      return;
    }
    const taskStatusBadgeClass = { completed: "approved", cancelled: "rejected", waiting: "warn" };
    host.innerHTML = `
      <table class="detail-table">
        <thead><tr><th>Task</th><th>Owner</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead>
        <tbody>
          ${tasks
            .map(
              (t) => `<tr>
            <td>${escapeHtml(t.title)}</td>
            <td>${escapeHtml(t.assignedToName)}</td>
            <td>${escapeHtml(t.priority)}</td>
            <td><span class="badge badge-${taskStatusBadgeClass[t.status] || "draft"}">${escapeHtml(t.status)}</span></td>
            <td>${t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  async function renderVendorDocumentsTab(host, v) {
    host.innerHTML = `<div class="vendor-documents-panel"></div><div class="vendor-assign-task-doc-host"></div>`;
    const documentsPanel = host.querySelector(".vendor-documents-panel");
    const refreshDocumentsPanel = () =>
      renderAttachments(documentsPanel, {
        title: "Vendor Documents",
        relatedType: "vendor",
        relatedId: v.id,
        categories: VENDOR_DOC_CATEGORIES,
        canUpload: true,
        groupByCategory: true,
        trackExpiration: true,
        emptyText: "No documents on file yet.",
      });
    await refreshDocumentsPanel();
    await renderAssignTaskDocumentControl(host.querySelector(".vendor-assign-task-doc-host"), v, refreshDocumentsPanel);
  }

  async function renderVendorCostsTab(host, v) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let woms, pos;
    try {
      [woms, pos] = await Promise.all([
        api.get("/api/woms").then((all) => all.filter((w) => w.vendorId === v.id)),
        // Only Active POs ever surface here -- a Needs Organization record
        // is only visible through the POs tab itself until it's moved to
        // Active, same rule as Task Manager.
        api.get(`/api/admin/pos?${new URLSearchParams({ vendorId: v.id, lifecycleStatus: "active" })}`),
      ]);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    host.innerHTML = `
      <div class="task-tiles">
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(v.totalContractedApplied || 0)}</div><div class="task-tile-label">Contracted Services Applied</div></div>
        <div class="task-tile"><div class="task-tile-count">${v.contractedWomCount || 0}</div><div class="task-tile-label">WOMs With Contracted Spend</div></div>
        <div class="task-tile"><div class="task-tile-count">${v.lastInvoicedAt ? new Date(v.lastInvoicedAt).toLocaleDateString() : "Never"}</div><div class="task-tile-label">Last Invoiced</div></div>
      </div>
      <p class="review-checklist-hint">See Financials &rarr; Cost Analysis for the full cross-vendor cost breakdown.</p>
      <h4>WOM Projects (${woms.length})</h4>
      <div class="review-list" id="vendor-cost-wom-list"></div>
      <h4>Budget POs (${pos.length})</h4>
      <div class="review-list" id="vendor-cost-po-list"></div>
    `;
    const list = host.querySelector("#vendor-cost-wom-list");
    if (woms.length === 0) {
      list.innerHTML = `<p class="empty-note">No WOM projects linked to this vendor yet.</p>`;
    } else {
      list.innerHTML = woms
        .map(
          (w) => `
        <div class="review-row">
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description)} <span class="wom-code">${escapeHtml(w.code)}</span></span>
            <span class="badge badge-${womStatusBadgeClass(w.status)}">${escapeHtml(WOM_STATUS_LABELS[w.status] || w.status)}</span>
          </div>
          <div class="wom-desc">Est. $${formatMoney(w.estimatedPrice)} / Applied $${formatMoney(w.appliedPrice)}</div>
        </div>`
        )
        .join("");
    }
    const poList = host.querySelector("#vendor-cost-po-list");
    if (pos.length === 0) {
      poList.innerHTML = `<p class="empty-note">No active Budget POs linked to this vendor yet.</p>`;
    } else {
      poList.innerHTML = pos
        .map(
          (p) => `
        <div class="review-row">
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(p.description || "PO record")} ${p.poNumber ? `<span class="wom-code">PO ${escapeHtml(p.poNumber)}</span>` : ""}</span>
            <span class="badge badge-draft">${escapeHtml(p.status || "—")}</span>
          </div>
          <div class="wom-desc">$${formatMoney(p.poAmount || 0)} &mdash; ${escapeHtml(p.locationName || "Unclassified")}</div>
        </div>`
        )
        .join("");
    }
  }

  async function renderVendorActivityTab(host, v) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let requests;
    try {
      requests = await api.get(`/api/admin/vendors/${v.id}/requests`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (requests.length === 0) {
      host.innerHTML = `<p class="empty-note">No activity logged for this vendor yet.</p>`;
      return;
    }
    host.innerHTML = `
      <table class="detail-table">
        <thead><tr><th>When</th><th>Case</th><th>Status</th><th>Note</th></tr></thead>
        <tbody>
          ${requests
            .map(
              (r) => `<tr>
            <td>${new Date(r.updatedAt).toLocaleString()}</td>
            <td>${escapeHtml(r.requestType)}${r.referenceNumber ? ` #${escapeHtml(r.referenceNumber)}` : ""}</td>
            <td>${escapeHtml(r.status || "—")}</td>
            <td>${escapeHtml(r.note || "")}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    `;
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

  // A vendor can do more than one kind of work (electrical AND HVAC, say),
  // so this is a real multi-select -- currentValue is the stored "|"-joined
  // string (see splitServices above), and the caller reads the result back
  // out with selectedServicesValue. Ctrl/Cmd-click (or drag) picks more
  // than one, same as any native multi-select.
  function renderServicesSelect(currentValue) {
    const selectedValues = splitServices(currentValue);
    const matchedLabels = new Set(COI_MATRIX.map((e) => e.label));
    const groups = new Map();
    for (const entry of COI_MATRIX) {
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    const optgroups = [...groups.entries()]
      .map(
        ([group, entries]) =>
          `<optgroup label="${escapeHtml(group)}">${entries
            .map((e) => `<option value="${escapeHtml(e.label)}" ${selectedValues.includes(e.label) ? "selected" : ""}>${escapeHtml(e.label)}</option>`)
            .join("")}</optgroup>`
      )
      .join("");
    // A vendor imported before this was matrix-backed (or with a service
    // type outside the matrix) keeps its original free-text value(s) as
    // preserved options, rather than silently losing them the moment the
    // field renders as a select.
    const unmatchedOptions = selectedValues
      .filter((v) => !matchedLabels.has(v))
      .map((v) => `<option value="${escapeHtml(v)}" selected>${escapeHtml(v)} (not in matrix)</option>`)
      .join("");
    return `<select name="services" multiple size="8" class="vendor-services-select">
      ${unmatchedOptions}
      ${optgroups}
    </select>
    <p class="services-select-hint">Ctrl/Cmd-click (or drag) to select more than one service.</p>`;
  }

  // Reads a <select multiple name="services"> back into the single "|"-
  // joined storage string -- the one place that knows the join delimiter,
  // mirroring splitServices on the way in.
  function selectedServicesValue(selectEl) {
    return [...selectEl.selectedOptions].map((o) => o.value).join("|");
  }

  // The document-compliance checklist (does the vendor's actual uploaded
  // COI/W-9/ACH meet requirements) -- its own standalone form, shared by
  // the Onboarding & Compliance modal and (for the services-driven COI
  // autofill) nowhere else now that it no longer shares a page with the
  // Services select. Previously lived inline in the vendor edit modal;
  // moved out so onboarding case status and document compliance live
  // together in one place, separate from the vendor's general profile.
  function renderVendorDocChecksForm(v) {
    const coiLimitInputs = Object.entries(COI_LIMIT_LABELS)
      .map(
        ([key, label]) =>
          `<label class="profile-field"><span>${label}</span><input name="coi_${key}" placeholder="e.g. $1M or -" value="${escapeHtml((v.coiLimits && v.coiLimits[key]) || "")}" /></label>`
      )
      .join("");
    return `
      <form class="vendor-doc-checks-form">
        <h4>COI (Certificate of Insurance) requirements</h4>
        <p class="review-checklist-hint">
          The limits Toyota requires for this vendor's service type (from the insurance matrix) --
          still editable if this vendor has a negotiated exception. Check the boxes once the
          vendor's actual COI (uploaded on the vendor's own Documents panel) has been reviewed
          against them.
        </p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="coiMeetsRequiredLimits" ${v.coiMeetsRequiredLimits ? "checked" : ""} /> Meets required limits</label>
          <label><input type="checkbox" name="coiMeetsLanguageRequirements" ${v.coiMeetsLanguageRequirements ? "checked" : ""} /> Meets language requirements</label>
        </div>
        <div class="vendor-edit-grid">${coiLimitInputs}</div>

        <h4>COI document checks</h4>
        <p class="review-checklist-hint">Verified against the actual COI document uploaded on the vendor's Documents panel.</p>
        <div class="vendor-coi-checks">
          <label><input type="checkbox" name="coiIsAcord25_2016_03" ${v.formChecks.coiIsAcord25_2016_03 ? "checked" : ""} /> Issued on ACORD 25 form (2016/03 version)</label>
          <label><input type="checkbox" name="coiMatchesW9" ${v.formChecks.coiMatchesW9 ? "checked" : ""} /> Matches W-9 name &amp; address</label>
        </div>

        <h4>W-9 document checks</h4>
        <p class="review-checklist-hint">Verified against the actual W-9 document uploaded on the vendor's Documents panel.</p>
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
        <p class="review-checklist-hint">Verified against the actual ACH/bank letter uploaded on the vendor's Documents panel.</p>
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
          <button type="submit" class="btn btn-primary">Save document checks</button>
          <span class="save-message doc-checks-save-message"></span>
        </div>
      </form>
    `;
  }

  // Wires the doc-checks form's save -- shared so both the Onboarding &
  // Compliance modal (its only caller now) gets the same save behavior
  // without duplicating it. `onSaved(updatedVendor)` lets the caller decide
  // what else needs refreshing (the vendors cache, a badge elsewhere).
  function wireVendorDocChecksForm(docChecksForm, v, onSaved) {
    docChecksForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = docChecksForm.querySelector(".save-message");
      try {
        const updated = await api.patch(
          `/api/admin/vendors/${v.id}`,
          vendorFullPayload(v, {
            coiMeetsRequiredLimits: docChecksForm.coiMeetsRequiredLimits.checked,
            coiMeetsLanguageRequirements: docChecksForm.coiMeetsLanguageRequirements.checked,
            coiLimits: Object.fromEntries(
              Object.keys(COI_LIMIT_LABELS).map((key) => [key, docChecksForm[`coi_${key}`].value.trim()])
            ),
            formChecks: Object.fromEntries(FORM_CHECK_KEYS.map((key) => [key, docChecksForm[key].checked])),
            w9InvoiceDate: docChecksForm.w9InvoiceDate.value || null,
          })
        );
        msg.textContent = "Saved.";
        onSaved(updated);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // "Onboarding and compliance" as one combined view for a single vendor --
  // case status (has ServiceEdge approved the COI/W-9/Payment case) and
  // document compliance (does the uploaded document actually meet
  // requirements) used to live in two different places (the Onboarding
  // board vs. the vendor edit modal); now they're one modal, reachable for
  // any vendor at any time regardless of where it stands on the board.
  function openVendorOnboardingComplianceModal(v, content) {
    const { body } = openModal({
      title: `Onboarding & Compliance — ${v.name}`,
      size: "large",
      bodyHtml: `
        <h4>Onboarding cases</h4>
        <div class="vendor-cases-section"></div>
        <h4>Document Compliance</h4>
        <div class="vendor-doc-checks-host"></div>
        <h4>Compliance Follow-up</h4>
        <p class="review-checklist-hint">
          A follow-up task is generated automatically whenever this vendor needs attention (an
          unconfirmed document check, outdated forms, a stale W-9 invoice, or an expired COI/W-9/ACH
          upload) -- work it, snooze it, or comment on it from Priorities like any other task. It
          closes on its own once the actual gap is fixed; notes logged on it stay visible here even
          after it's done.
        </p>
        <div class="vendor-compliance-tasks-host"></div>
      `,
    });
    renderVendorCasesSection(body.querySelector(".vendor-cases-section"), v);
    const docChecksHost = body.querySelector(".vendor-doc-checks-host");
    function attachDocChecksForm() {
      docChecksHost.innerHTML = renderVendorDocChecksForm(v);
      wireVendorDocChecksForm(docChecksHost.querySelector(".vendor-doc-checks-form"), v, (updated) => {
        Object.assign(v, updated);
        invalidateVendorsCache();
        attachDocChecksForm();
      });
    }
    attachDocChecksForm();
    renderVendorComplianceTasks(body.querySelector(".vendor-compliance-tasks-host"), v);
  }

  async function renderVendorComplianceTasks(host, v) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    try {
      const tasks = await api.get(`/api/admin/vendors/${v.id}/compliance-tasks`);
      if (tasks.length === 0) {
        host.innerHTML = `<p class="empty-note">No compliance follow-up has ever been needed for this vendor.</p>`;
        return;
      }
      host.innerHTML = tasks
        .map((t) => {
          const statusBadge =
            t.status === "completed"
              ? `<span class="badge badge-approved">Resolved ${new Date(t.completedAt).toLocaleDateString()}</span>`
              : t.snoozedUntil
                ? `<span class="badge badge-draft">Snoozed until ${new Date(t.snoozedUntil).toLocaleDateString()}</span>`
                : `<span class="badge badge-rejected">Open</span>`;
          const comments = t.comments
            .map(
              (c) =>
                `<div class="task-comment"><strong>${escapeHtml(c.authorName)}</strong> &middot; ${new Date(c.createdAt).toLocaleString()}<br>${escapeHtml(c.body)}</div>`
            )
            .join("");
          return `
            <div class="review-row vendor-compliance-task-row">
              <div class="review-row-summary">
                <span class="review-row-name">${escapeHtml(t.title)}</span>
                ${statusBadge}
              </div>
              <div class="wom-desc">${escapeHtml(t.description || "")}</div>
              ${comments ? `<div class="task-comments-list">${comments}</div>` : ""}
            </div>
          `;
        })
        .join("");
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderVendorEditFormFields(v) {
    const cwSelect = ["unknown", "active", "inactive"]
      .map((s) => `<option value="${s}" ${v.cwStatus === s ? "selected" : ""}>${escapeHtml(CW_STATUS_LABELS[s])}</option>`)
      .join("");
    const toyotaSelect = ["unknown", "approved", "not_approved"]
      .map((s) => `<option value="${s}" ${v.toyotaStatus === s ? "selected" : ""}>${escapeHtml(TOYOTA_STATUS_LABELS[s])}</option>`)
      .join("");
    const formsSelect = ["unknown", "current", "outdated"]
      .map((s) => `<option value="${s}" ${v.formsStatus === s ? "selected" : ""}>${escapeHtml(FORMS_STATUS_LABELS[s])}</option>`)
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

    // The technician switcher sits in the sub-tab band, pushed to the right
    // of the Tech Allocation/Overview/Weekly Review pills (not up in the
    // dark top bar) -- it reads easier sitting right next to the tabs it's
    // page-context for, rather than separated out above them. Appended
    // (not replacing subtabHost's innerHTML) since draw() already put the
    // pills there; a second field (#topbar-week-field) sits alongside it,
    // filled in by renderTechWeek below once it knows this page wants its
    // week-nav there too, not inline in the page content.
    subtabHost.insertAdjacentHTML(
      "beforeend",
      `
      <div class="subtab-context-picker">
        <div class="topbar-field">
          <label>Technician</label>
          <div class="topbar-field-row">
            <button class="topbar-arrow-btn tech-alloc-prev" type="button" ${currentIndex <= 0 ? "disabled" : ""} aria-label="Previous technician">&larr;</button>
            <select class="topbar-pill-select tech-alloc-select">${options}</select>
            <button class="topbar-arrow-btn tech-alloc-next" type="button" ${currentIndex === -1 || currentIndex >= selectable.length - 1 ? "disabled" : ""} aria-label="Next technician">&rarr;</button>
          </div>
        </div>
        <div class="topbar-field" id="topbar-week-field"></div>
      </div>
    `
    );

    content.innerHTML = `
      <p class="tech-alloc-hint">You're allocating this technician's time on their behalf.</p>
      <div class="tech-alloc-body"></div>
    `;

    if (selectable.length === 0) {
      content.querySelector(".tech-alloc-body").innerHTML = `<p class="empty-note">No active technicians.</p>`;
      return;
    }

    subtabHost.querySelector(".tech-alloc-select").addEventListener("change", (e) => {
      allocTechId = e.target.value;
      draw();
    });
    subtabHost.querySelector(".tech-alloc-prev").addEventListener("click", () => {
      if (currentIndex > 0) allocTechId = selectable[currentIndex - 1].id;
      draw();
    });
    subtabHost.querySelector(".tech-alloc-next").addEventListener("click", () => {
      if (currentIndex < selectable.length - 1) allocTechId = selectable[currentIndex + 1].id;
      draw();
    });

    await renderTechWeek(content.querySelector(".tech-alloc-body"), allocTechId, subtabHost.querySelector("#topbar-week-field"));
  }

  const DAILY_GOAL_TARGET = 10;

  // The tab's own badge count -- a small number next to its label, not a
  // banner anywhere else. Never blocks the tab bar itself if one of these
  // calls fails.
  async function computePriorityCount() {
    try {
      const [expiringForms, vendors, weekendAddenda, reportGaps, missingUkg, woms, purelyhrUnverified, punchIssues, taskSummary] = await Promise.all([
        api.get("/api/admin/expiring-forms"),
        api.get("/api/admin/vendors"),
        api.get("/api/admin/weekend-addenda"),
        api.get("/api/admin/report-gaps"),
        api.get("/api/admin/missing-ukg"),
        api.get("/api/woms"),
        api.get("/api/admin/purelyhr-unverified"),
        api.get("/api/admin/punch-issues"),
        api.get("/api/tasks/summary"),
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
        punchIssues.length +
        taskSummary.overdue +
        taskSummary.exceptions
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
          vendorProfileId = null;
          activeTab = "vendors";
        } else if (kind === "vendor-doc") {
          vendorProfileId = Number(vendor);
          vendorProfileTab = "documents";
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

  // Persists across reloads (backed by wom_sync_log) so "when did this last
  // run and what did it do" doesn't disappear the moment someone navigates
  // away -- collapsed to one line by default, "View Sync Details" expands
  // it back into the same breakdown shown right after a sync.
  function renderLastSyncLine(lastSync) {
    if (!lastSync) return `<p class="empty-note">No sync has been run yet.</p>`;
    const when = new Date(lastSync.synced_at).toLocaleString();
    const exceptions = lastSync.exceptions_flagged;
    return `
      <div class="wom-sync-meta-row">
        <span class="smartsheet-last-sync">
          Last sync <strong>${escapeHtml(when)}</strong> &middot;
          ${lastSync.woms_created + lastSync.woms_promoted + lastSync.woms_updated} WOM${
      lastSync.woms_created + lastSync.woms_promoted + lastSync.woms_updated === 1 ? "" : "s"
    } updated,
          ${lastSync.tasks_created} task${lastSync.tasks_created === 1 ? "" : "s"} created,
          ${lastSync.tasks_completed} task${lastSync.tasks_completed === 1 ? "" : "s"} completed
          &middot; ${exceptions === 0 ? "No exceptions" : `${exceptions} workflow exception${exceptions === 1 ? "" : "s"}`}
        </span>
        <button class="btn btn-link smartsheet-sync-details-btn" type="button">Sync details</button>
      </div>
      <div class="smartsheet-sync-details" hidden>
        <ul>
          <li>${lastSync.woms_created} new WOM(s) added (open or pending)</li>
          <li>${lastSync.woms_promoted} pending WOM(s) promoted now that a real WOM # showed up</li>
          <li>${lastSync.woms_updated} existing WOM(s) refreshed</li>
          <li>${lastSync.tasks_created} workflow task(s) created</li>
          <li>${lastSync.tasks_completed} workflow task(s) completed</li>
          <li>${lastSync.exceptions_flagged} workflow exception(s) flagged</li>
          <li>${lastSync.total_rows} sheet row(s) processed</li>
        </ul>
        ${renderChangedWomsList(lastSync.changedWoms)}
      </div>
    `;
  }

  // The actual "what changed" answer -- one line per WOM this sync touched,
  // naming which fields differed, instead of just a total count. A WOM
  // whose values already matched the sheet doesn't appear here at all,
  // even though it's still part of "N sheet rows processed" above.
  function renderChangedWomsList(changedWoms) {
    if (!changedWoms || changedWoms.length === 0) {
      return `<p class="empty-note">No WOM fields actually changed this sync -- every matching row already had current data.</p>`;
    }
    return `
      <div class="smartsheet-changed-woms-title">What changed</div>
      <ul class="smartsheet-changed-woms-list">
        ${changedWoms
          .map(
            (c) =>
              `<li><span class="wom-code">${escapeHtml(c.code)}</span> ${escapeHtml(c.description || "")} — ${escapeHtml(c.fields.join(", "))}</li>`
          )
          .join("")}
      </ul>
    `;
  }

  function wireLastSyncToggle(scope) {
    const btn = scope.querySelector(".smartsheet-sync-details-btn");
    const details = scope.querySelector(".smartsheet-sync-details");
    if (!btn || !details) return;
    btn.addEventListener("click", () => {
      const hidden = details.hasAttribute("hidden");
      if (hidden) details.removeAttribute("hidden");
      else details.setAttribute("hidden", "");
      btn.textContent = hidden ? "Hide details" : "Sync details";
    });
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
        <div class="wom-sync-row">
          <div class="wom-sync-status">
            <span class="status-dot status-dot-off"></span>
            <strong>Smartsheet not connected</strong>
          </div>
        </div>
        <p class="empty-note">Needs SMARTSHEET_API_TOKEN and SMARTSHEET_SHEET_ID set on the server, then a restart.</p>
      `;
      return;
    }

    container.innerHTML = `
      <div class="wom-sync-row">
        <div class="wom-sync-status">
          <span class="status-dot status-dot-ok"></span>
          <strong>Smartsheet connected</strong>
          <span class="chip chip-muted">Read-only</span>
        </div>
        <div class="wom-sync-row-actions">
          <button class="btn btn-outline smartsheet-sync-btn" type="button">&#8635; Sync WOMs</button>
          <button class="btn btn-link smartsheet-preview-btn" type="button">Preview data</button>
        </div>
      </div>
      <div class="smartsheet-sync-result">${renderLastSyncLine(status.lastSync)}</div>
      <div class="smartsheet-preview"></div>
    `;
    wireLastSyncToggle(container);

    container.querySelector(".smartsheet-sync-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const resultEl = container.querySelector(".smartsheet-sync-result");
      btn.disabled = true;
      resultEl.innerHTML = `<p class="empty-note">Syncing…</p>`;
      try {
        const result = await api.post("/api/admin/smartsheet/sync-woms");
        const summaryHtml = `
          ${renderLastSyncLine(result.lastSync)}
          <p class="smartsheet-sync-summary">
            <strong>${result.created}</strong> new WOM${result.created === 1 ? "" : "s"} added (open or pending),
            <strong>${result.promoted}</strong> pending WOM${result.promoted === 1 ? "" : "s"} promoted now that a real WOM # showed up,
            <strong>${result.updated}</strong> existing WOM${result.updated === 1 ? "" : "s"} refreshed — out of ${result.total} sheet rows.
            Matched by "${escapeHtml(result.womColumn)}", pricing from ${escapeHtml(result.estimateColumn || "no estimate column found")} /
            ${escapeHtml(result.appliedColumn || "no applied column found")}, "requested" status from
            ${escapeHtml(result.dateRequestedColumn || "no Date Requested column found")}, location from
            ${escapeHtml(result.locationColumn || "no Site Location column found")} (matched by name against your own
            locations -- add a location here if one doesn't match), subsidiary code from
            ${escapeHtml(result.subsidiaryColumn || "no Subsidiary Code column found")}, Maximo # from
            ${escapeHtml(result.maximoColumn || "no Maximo column found")}, labor/contracted-services
            breakdown from ${escapeHtml(result.estimatedLaborColumn || "no Estimate Labor column found")} /
            ${escapeHtml(result.estimatedContractedColumn || "no Estimate Contracted Services column found")} /
            ${escapeHtml(result.appliedLaborColumn || "no Applied Labor column found")} /
            ${escapeHtml(result.appliedContractedColumn || "no Applied Contracted Services column found")} /
            ${escapeHtml(result.estimatedMaterialsColumn || "no Estimate Materials column found")} /
            ${escapeHtml(result.appliedMaterialsColumn || "no Applied Materials column found")} /
            ${escapeHtml(result.estimatedOtherDirectColumn || "no Estimate Other Direct column found")} /
            ${escapeHtml(result.appliedOtherDirectColumn || "no Applied Other Direct column found")} /
            ${escapeHtml(result.estimatedTaxColumn || "no Estimate Sales Tax column found")} /
            ${escapeHtml(result.appliedTaxColumn || "no Applied Tax column found")} /
            ${escapeHtml(result.estimatedContingencyColumn || "no Estimated Contingency column found")} /
            ${escapeHtml(result.appliedContingencyColumn || "no Contingency column found")}, Toyota PO value from
            ${escapeHtml(result.toyotaPoValueColumn || "no Toyota PO value column found")}, vendor from
            ${escapeHtml(result.vendorColumn || "no Vendor column found")} (matched by name against your own vendors).
          </p>
        `;
        // The WOM Projects list below needs to show the freshly-synced
        // prices right away, not just after a manual page reload -- a full
        // redraw rebuilds this whole panel too, so re-find it afterward to
        // keep the summary message visible.
        await drawWoms(content);
        const freshResultEl = content.querySelector(".smartsheet-sync-result");
        if (freshResultEl) {
          freshResultEl.innerHTML = summaryHtml;
          wireLastSyncToggle(content);
        }
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

  async function drawLocations(content) {
    const locations = await api.get("/api/locations");
    const efSubsidiary = locations[0] ? locations[0].efSubsidiaryCode : "20920000";
    const territoriesInUse = [...new Set(locations.map((l) => l.territory || "Midwest"))];
    const filtered = locationTerritoryFilter
      ? locations.filter((l) => (l.territory || "Midwest") === locationTerritoryFilter)
      : locations;

    content.innerHTML = `
      <div class="review-actions">
        <h3 style="margin: 0;">Locations</h3>
        <button type="button" class="btn btn-primary" id="add-location-btn">Add location</button>
        <label class="roster-filter-field">
          <span>Territory</span>
          <select class="location-territory-filter">
            <option value="">All territories</option>
            ${territoriesInUse.map((t) => `<option value="${escapeHtml(t)}" ${locationTerritoryFilter === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </label>
      </div>
      <p class="review-checklist-hint">
        Each location has its own E&amp;F Contract Job Number and WOM Job Number (from the JDE lookup). E&amp;F time
        always uses the standard subsidiary code <strong>${escapeHtml(efSubsidiary)}</strong> at every location —
        that part never changes location to location; WOM subsidiary codes vary by project and are set on each WOM
        (WOM tab). Region is used to match this location up against the monthly labor report.
      </p>
      <div class="review-list" id="location-list"></div>
    `;

    const locationList = content.querySelector("#location-list");
    if (filtered.length === 0) {
      locationList.innerHTML = `<p class="empty-note">No locations match this filter.</p>`;
    } else {
      for (const l of filtered) {
        locationList.appendChild(renderLocationRow(l, content));
      }
    }

    const territorySelect = content.querySelector(".location-territory-filter");
    if (territorySelect) {
      territorySelect.addEventListener("change", (e) => {
        locationTerritoryFilter = e.target.value;
        drawLocations(content);
      });
    }

    content.querySelector("#add-location-btn").addEventListener("click", () => {
      openAddLocationModal(content);
    });
  }

  function openAddLocationModal(content) {
    const { body, close } = openModal({
      title: "Add Location",
      bodyHtml: `
        <form class="add-location-form modal-form">
          <div class="add-tech-grid">
            <input name="code" placeholder="Location code" required />
            <input name="name" placeholder="Location name" required />
            <input name="efJobNumber" placeholder="E&amp;F Contract Job Number" />
            <input name="womJobNumber" placeholder="WOM Job Number" />
            <input name="region" placeholder="Region (e.g. Southeast)" />
            <select name="territory">${renderTerritorySelect("Midwest")}</select>
          </div>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Add location</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".add-location-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = body.querySelector(".save-message");
      try {
        await api.post("/api/locations", {
          code: form.code.value.trim(),
          name: form.name.value.trim(),
          efJobNumber: form.efJobNumber.value.trim() || null,
          womJobNumber: form.womJobNumber.value.trim() || null,
          region: form.region.value.trim() || null,
          territory: form.territory.value,
        });
        close();
        await drawLocations(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // active = everything still in play (or not yet real); closed = invoiced,
  // closed, and cancelled all together, since all three just mean "this job
  // is done, one way or another" -- each row still shows its own status
  // badge, so an invoice vs. a cancellation still reads differently at a
  // glance even grouped into one list.
  const WOM_CLOSED_STATUSES = ["invoiced", "closed", "cancelled"];

  async function drawWoms(content) {
    const [allWoms, locations] = await Promise.all([api.get("/api/woms"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const womTerritoryOf = (w) => (locationByCode[w.locationCode] && locationByCode[w.locationCode].territory) || "Midwest";
    const territoriesInUse = [...new Set(locations.map((l) => l.territory || "Midwest"))];
    const locationsInUse = [...new Set(allWoms.map((w) => w.locationCode).filter(Boolean))]
      .map((code) => locationByCode[code])
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-header-title">WOM Projects</h1>
          <p class="page-header-subtitle">Track project status, costs and requests.</p>
        </div>
        <div class="page-header-actions">
          <a class="btn btn-primary" href="${WOM_REQUEST_FORM_URL}" target="_blank" rel="noopener">+ Request WOM</a>
        </div>
      </div>

      <div class="wom-sync-card" id="smartsheet-panel"></div>

      <div class="wom-filter-bar">
        <label class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="search" class="wom-search-input" placeholder="Search WOM projects..." value="${escapeHtml(womSearchQuery)}" />
        </label>
        <select class="wom-location-filter">
          <option value="">All locations</option>
          ${locationsInUse.map((l) => `<option value="${escapeHtml(l.code)}" ${womLocationFilter === l.code ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}
        </select>
        <select class="wom-status-filter">
          <option value="">All statuses</option>
          ${WOM_STATUSES.map((s) => `<option value="${s}" ${womStatusFilter === s ? "selected" : ""}>${escapeHtml(WOM_STATUS_LABELS[s])}</option>`).join("")}
        </select>
        ${
          territoriesInUse.length > 1
            ? `<label class="roster-filter-field">
                <span>Territory</span>
                <select class="wom-territory-filter">
                  <option value="">All</option>
                  ${territoriesInUse.map((t) => `<option value="${escapeHtml(t)}" ${womTerritoryFilter === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
                </select>
              </label>`
            : ""
        }
      </div>

      <div class="pill-toggle-group">
        <button type="button" class="pill-toggle-btn ${womGroupFilter === "active" ? "active" : ""}" data-group="active">Active</button>
        <button type="button" class="pill-toggle-btn ${womGroupFilter === "closed" ? "active" : ""}" data-group="closed">Closed</button>
      </div>

      <div class="review-list" id="wom-list"></div>
    `;

    await renderSmartsheetPanel(content.querySelector("#smartsheet-panel"), content);

    const territoryFiltered = womTerritoryFilter ? allWoms.filter((w) => womTerritoryOf(w) === womTerritoryFilter) : allWoms;
    const groupFiltered = territoryFiltered.filter((w) =>
      womGroupFilter === "closed" ? WOM_CLOSED_STATUSES.includes(w.status) : !WOM_CLOSED_STATUSES.includes(w.status)
    );
    const locationFiltered = womLocationFilter ? groupFiltered.filter((w) => w.locationCode === womLocationFilter) : groupFiltered;
    const statusFiltered = womStatusFilter ? locationFiltered.filter((w) => w.status === womStatusFilter) : locationFiltered;
    const query = womSearchQuery.trim().toLowerCase();
    const woms = query
      ? statusFiltered.filter((w) => w.description.toLowerCase().includes(query) || w.code.toLowerCase().includes(query))
      : statusFiltered;

    const list = content.querySelector("#wom-list");
    for (const w of woms) {
      list.appendChild(await renderWomRow(w, content, locationByCode, locations));
    }
    if (woms.length === 0) {
      list.innerHTML = `<p class="empty-note">No WOM projects match these filters.</p>`;
    }

    // One-shot deep link from a Priorities task card ("this WOM needs a
    // Maximo #", etc.) -- jump straight to its Open Project modal regardless
    // of whatever filters/group toggle happen to be active right now.
    if (womEditing.size > 0) {
      const codeToOpen = [...womEditing][0];
      womEditing.clear();
      const target = allWoms.find((x) => x.code === codeToOpen);
      if (target) openWomProjectModal(target, content, locationByCode, locations);
    }

    if (!content.dataset.rowMenuBound) {
      content.dataset.rowMenuBound = "1";
      content.addEventListener("click", (e) => {
        if (!e.target.closest(".row-menu")) {
          content.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
        }
      });
    }

    content.querySelectorAll(".pill-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        womGroupFilter = btn.dataset.group;
        drawWoms(content);
      });
    });
    content.querySelector(".wom-location-filter").addEventListener("change", (e) => {
      womLocationFilter = e.target.value;
      drawWoms(content);
    });
    content.querySelector(".wom-status-filter").addEventListener("change", (e) => {
      womStatusFilter = e.target.value;
      drawWoms(content);
    });
    content.querySelector(".wom-search-input").addEventListener("input", (e) => {
      womSearchQuery = e.target.value;
      refreshWomList(content, locationByCode, locations);
    });

    const womTerritorySelect = content.querySelector(".wom-territory-filter");
    if (womTerritorySelect) {
      womTerritorySelect.addEventListener("change", (e) => {
        womTerritoryFilter = e.target.value;
        drawWoms(content);
      });
    }
  }

  // Re-filters and redraws just the WOM list (not the whole tab, which would
  // steal focus out of the search box on every keystroke).
  async function refreshWomList(content, locationByCode, locations) {
    const allWoms = await api.get("/api/woms");
    const womTerritoryOf = (w) => (locationByCode[w.locationCode] && locationByCode[w.locationCode].territory) || "Midwest";
    const territoryFiltered = womTerritoryFilter ? allWoms.filter((w) => womTerritoryOf(w) === womTerritoryFilter) : allWoms;
    const groupFiltered = territoryFiltered.filter((w) =>
      womGroupFilter === "closed" ? WOM_CLOSED_STATUSES.includes(w.status) : !WOM_CLOSED_STATUSES.includes(w.status)
    );
    const locationFiltered = womLocationFilter ? groupFiltered.filter((w) => w.locationCode === womLocationFilter) : groupFiltered;
    const statusFiltered = womStatusFilter ? locationFiltered.filter((w) => w.status === womStatusFilter) : locationFiltered;
    const query = womSearchQuery.trim().toLowerCase();
    const woms = query
      ? statusFiltered.filter((w) => w.description.toLowerCase().includes(query) || w.code.toLowerCase().includes(query))
      : statusFiltered;

    const list = content.querySelector("#wom-list");
    list.innerHTML = "";
    for (const w of woms) {
      list.appendChild(await renderWomRow(w, content, locationByCode, locations));
    }
    if (woms.length === 0) {
      list.innerHTML = `<p class="empty-note">No WOM projects match these filters.</p>`;
    }
  }

  function renderTerritorySelect(currentValue) {
    return TERRITORIES.map((t) => `<option value="${t}" ${t === (currentValue || "Midwest") ? "selected" : ""}>${t}</option>`).join("");
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
          <select name="territory">${renderTerritorySelect(l.territory)}</select>
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-link cancel-edit">Cancel</button>
          <span class="save-message"></span>
        </form>
      `;
      el.querySelector(".cancel-edit").addEventListener("click", async () => {
        locationEditing.delete(l.code);
        await drawLocations(content);
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
            territory: form.territory.value,
          });
          locationEditing.delete(l.code);
          await drawLocations(content);
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      return el;
    }

    const jobLabel = l.efJobNumber ? `E&amp;F Job # ${escapeHtml(l.efJobNumber)}` : "No E&amp;F Job # on file";
    const womJobLabel = l.womJobNumber ? ` &middot; WOM Job # ${escapeHtml(l.womJobNumber)}` : " &middot; No WOM Job # on file";
    const regionLabel = l.region ? ` &middot; ${escapeHtml(l.region)}` : "";
    const territoryLabel = ` &middot; <span class="badge badge-draft">${escapeHtml(l.territory || "Midwest")}</span>`;
    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(l.name)} <span class="wom-desc">${jobLabel}${womJobLabel}${regionLabel}</span>${territoryLabel}</div>
        <button class="btn btn-link edit-location-btn" type="button">Edit</button>
        <button class="btn btn-link delete-location-btn" type="button">Delete</button>
      </div>
    `;
    el.querySelector(".edit-location-btn").addEventListener("click", async () => {
      locationEditing.add(l.code);
      await drawLocations(content);
    });
    // Unlike a WOM, there's no "force" option here -- a location in use by a
    // whole set of technicians/WOMs/allocations is too big a thing to bulldoze
    // through with one more click, so the error just says what to reassign
    // first rather than offering to do it anyway.
    el.querySelector(".delete-location-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete location "${l.name}" (${l.code})? This can't be undone.`)) return;
      try {
        await api.delete(`/api/locations/${encodeURIComponent(l.code)}`);
        await drawLocations(content);
      } catch (err) {
        window.alert(`Could not delete ${l.name}: ${err.message}`);
      }
    });
    return el;
  }

  async function renderWomRow(w, content, locationByCode, locations) {
    const el = document.createElement("div");
    el.className = "wom-card";
    const loc = locationByCode[w.locationCode];

    const metaItems = [
      { label: "Subsidiary", value: w.subsidiaryCode ? escapeHtml(w.subsidiaryCode) : "—" },
      { label: "Maximo #", value: w.maximoNumber ? escapeHtml(w.maximoNumber) : "—" },
      { label: "Estimated cost", value: w.estimatedPrice != null ? `$${formatMoney(w.estimatedPrice)}` : "—" },
      { label: "Applied cost", value: w.appliedPrice != null ? `$${formatMoney(w.appliedPrice)}` : "—" },
    ];
    if (w.budgetHours != null) metaItems.push({ label: "Hours remaining", value: `${w.remainingHours}h of ${w.budgetHours}h` });

    const statusBadgeClass = womStatusBadgeClass(w.status);
    const statusOptions = WOM_STATUSES.map(
      (s) => `<option value="${s}" ${w.status === s ? "selected" : ""}>${escapeHtml(WOM_STATUS_LABELS[s])}</option>`
    ).join("");
    // The project name is the thing people actually recognize; the WOM code
    // is only there for whoever needs to key it into JDE/UKG, so it's a
    // small, secondary chip rather than the headline.
    const locationChip = loc
      ? `<span class="chip">${escapeHtml(loc.name)}</span>`
      : `<span class="chip chip-muted">No location on file</span>`;
    // A WOM a Smartsheet sync has never touched (created by hand here, or
    // left over from testing) has no smartsheetSyncedAt at all -- flagging
    // that distinguishes "real WOMs not synced yet" from "we never actually
    // imported this one" at a glance, since those are exactly the ones
    // worth reviewing for deletion.
    const sourceChip = w.smartsheetSyncedAt == null ? `<span class="chip chip-warn">Not imported from Smartsheet</span>` : "";
    // The Smartsheet grid's own row number -- much easier to actually find
    // and identify a request by (especially one still missing a real WOM #
    // and description) than the WOM code alone, which for those is just a
    // generated PENDING-<opaque id> placeholder.
    const lineChip = w.smartsheetLineNumber ? `<span class="chip">Line ${escapeHtml(String(w.smartsheetLineNumber))}</span>` : "";

    el.innerHTML = `
      <div class="wom-card-top">
        <div class="wom-card-title-group">
          <div class="wom-card-title">${escapeHtml(w.description)}</div>
          <div class="chip-row">
            ${locationChip}
            <span class="chip chip-code">WOM ${escapeHtml(w.code)}</span>
            <span class="badge badge-${statusBadgeClass}">${escapeHtml(WOM_STATUS_LABELS[w.status] || w.status)}</span>
            ${lineChip}${sourceChip}
          </div>
        </div>
        <div class="wom-card-actions">
          <select class="wom-status-select">${statusOptions}</select>
          <button class="btn btn-primary wom-open-btn" type="button">Open project</button>
          <div class="row-menu">
            <button class="btn btn-ghost row-menu-toggle" type="button" aria-label="More actions">&#8943;</button>
            <div class="row-menu-panel" hidden>
              ${w.smartsheetData ? `<button class="row-menu-item smartsheet-detail-btn" type="button">Smartsheet detail</button>` : ""}
              ${w.smartsheetLink ? `<a class="row-menu-item" href="${escapeHtml(w.smartsheetLink)}" target="_blank" rel="noopener">Open in Smartsheet ↗</a>` : ""}
              <button class="row-menu-item row-menu-item-danger delete-wom-btn" type="button">Delete</button>
            </div>
          </div>
        </div>
      </div>
      <div class="wom-card-meta">
        ${metaItems.map((m) => `<div class="wom-meta-item"><span class="wom-meta-label">${m.label}</span><span class="wom-meta-value">${m.value}</span></div>`).join("")}
      </div>
    `;

    el.querySelector(".wom-open-btn").addEventListener("click", () => {
      openWomProjectModal(w, content, locationByCode, locations);
    });

    el.querySelector(".row-menu-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = el.querySelector(".row-menu-panel");
      const isHidden = panel.hasAttribute("hidden");
      content.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
      if (isHidden) panel.removeAttribute("hidden");
    });

    // A WOM created by mistake (a test entry, a typo) should just go away.
    // Blocked with a 409 if hours are already allocated against it -- ask
    // to confirm that specific, scarier consequence before forcing it.
    el.querySelector(".delete-wom-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete "${w.description}" (${w.code})? This can't be undone.`)) return;
      try {
        await api.delete(`/api/woms/${encodeURIComponent(w.code)}`);
        await refreshWomList(content, locationByCode, locations);
      } catch (err) {
        if (err.status === 409 && err.payload && err.payload.allocatedHours != null) {
          const forceConfirmed = window.confirm(
            `${err.payload.allocatedHours}h already allocated against ${w.code} on technician timesheets. Deleting it removes those hours too -- delete anyway?`
          );
          if (!forceConfirmed) return;
          try {
            await api.delete(`/api/woms/${encodeURIComponent(w.code)}`, { force: true });
            await refreshWomList(content, locationByCode, locations);
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
        await refreshWomList(content, locationByCode, locations);
      } catch (err) {
        window.alert(`Could not update ${w.code}: ${err.message}`);
        e.target.value = w.status;
      }
    });

    const smartsheetDetailBtn = el.querySelector(".smartsheet-detail-btn");
    if (smartsheetDetailBtn) {
      smartsheetDetailBtn.addEventListener("click", () => openSmartsheetDetailModal(w));
    }

    return el;
  }

  // Every column from the tracker's own row, verbatim -- not just the
  // handful this app's own logic reads directly (pricing, Maximo #,
  // subsidiary code, location). Covers every estimate/applied line item,
  // PO/invoice/batch tracking, RFM/PSE approval flags, whatever else is on
  // the sheet, without a dedicated field or a code change every time the
  // sheet grows a column. A pop-up (not another inline panel pushing the
  // rest of the list down) since it's a genuinely large table.
  function openSmartsheetDetailModal(w) {
    const rows = Object.entries(w.smartsheetData)
      .filter(([key]) => key !== "__smartsheetRowId")
      .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value == null || value === "" ? "—" : String(value))}</td></tr>`)
      .join("");
    const { body } = openModal({
      title: `Smartsheet Detail — ${w.code}`,
      size: "large",
      bodyHtml: `
        <div class="review-actions">
          <button type="button" class="btn btn-secondary wom-sync-history-btn">Sync History</button>
        </div>
        <div class="wom-sync-history-panel"></div>
        <table class="detail-table wom-smartsheet-table">
          <thead><tr><th>Column</th><th>Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `,
    });
    // What got changed on this specific WOM, sync by sync, pulled from
    // each past sync run's own changed_woms_json -- the answer to "why
    // does this keep showing as changed every time I sync," which the
    // main sync panel's "Last sync" summary alone can't answer since it
    // only ever shows the latest run.
    body.querySelector(".wom-sync-history-btn").addEventListener("click", async () => {
      const panel = body.querySelector(".wom-sync-history-panel");
      panel.innerHTML = `<p class="empty-note">Loading…</p>`;
      try {
        const history = await api.get(`/api/woms/${encodeURIComponent(w.code)}/sync-history`);
        if (history.length === 0) {
          panel.innerHTML = `<p class="empty-note">No sync has changed this WOM yet.</p>`;
          return;
        }
        panel.innerHTML = `
          <table class="detail-table wom-sync-history-table">
            <thead><tr><th>Synced</th><th>What changed</th></tr></thead>
            <tbody>
              ${history
                .map((h) => `<tr><td>${new Date(h.syncedAt).toLocaleString()}</td><td>${escapeHtml(h.fields.join(", "))}</td></tr>`)
                .join("")}
            </tbody>
          </table>
        `;
      } catch (err) {
        panel.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  // "Open project" is the one place to both edit a WOM's own fields and see
  // its documents -- replaces the old separate inline Edit row and
  // Documents expand-toggle with a single modal, matching the Add
  // Vendor/Add Location pattern used everywhere else in the app.
  function openWomProjectModal(w, content, locationByCode, locations) {
    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === w.locationCode ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");
    const { body, close } = openModal({
      title: w.description,
      size: "large",
      bodyHtml: `
        <form class="edit-wom-form modal-form">
          <div class="add-tech-grid">
            <input name="description" value="${escapeHtml(w.description)}" required placeholder="Description" />
            <select name="locationCode"><option value="">No location</option>${locationOptions}</select>
            <input name="budgetHours" type="number" min="0" step="0.5" placeholder="Budget hrs" value="${w.budgetHours == null ? "" : w.budgetHours}" />
            <input name="subsidiaryCode" placeholder="Subsidiary code" value="${escapeHtml(w.subsidiaryCode || "")}" />
            <input name="maximoNumber" placeholder="Maximo #" value="${escapeHtml(w.maximoNumber || "")}" />
          </div>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
          <span class="save-message"></span>
        </form>
        <div class="wom-modal-documents"></div>
      `,
    });
    body.querySelector(".edit-wom-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = body.querySelector(".save-message");
      try {
        await api.patch(`/api/woms/${encodeURIComponent(w.code)}/details`, {
          description: form.description.value.trim(),
          locationCode: form.locationCode.value || null,
          budgetHours: form.budgetHours.value === "" ? null : Number(form.budgetHours.value),
          subsidiaryCode: form.subsidiaryCode.value.trim() || null,
          maximoNumber: form.maximoNumber.value.trim() || null,
        });
        close();
        await refreshWomList(content, locationByCode, locations);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    renderAttachments(body.querySelector(".wom-modal-documents"), {
      title: "Documents & Photos",
      relatedType: "wom",
      relatedId: w.code,
      categories: [{ value: "wom_doc", label: "Document / Photo" }],
      canUpload: true,
      emptyText: "No documents attached yet.",
    });
  }

  // Financials-wide estimated-vs-applied picture -- every non-cancelled

  // WOM, not just the ones currently sitting in the PSE pipeline. Two
  // concrete follow-up lists rather than just totals: WOMs quoted higher
  // than what actually got applied (money quoted on labor that was never
  // used), and WOMs with a charge applied but no Toyota PO/Maximo # on
  // file yet (a billing gap waiting to be closed).
  async function drawCostAnalysis(content) {
    const summary = await api.get("/api/woms/cost-summary");
    content.innerHTML = `
      <p class="review-checklist-hint">
        Estimated vs. applied across every WOM on file (cancelled ones excluded), not just what's
        currently on the WOM lifecycle checklist.
      </p>
      <div class="task-tiles">
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(summary.totalEstimated)}</div><div class="task-tile-label">Total Estimated (${summary.estimatedCount} WOMs)</div></div>
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(summary.totalApplied)}</div><div class="task-tile-label">Total Applied (${summary.appliedCount} WOMs)</div></div>
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(summary.totalDelta)}</div><div class="task-tile-label">Estimated &minus; Applied</div></div>
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(summary.totalToyotaPoValue)}</div><div class="task-tile-label">Total Toyota PO Value (${summary.toyotaPoValueCount} WOMs)</div></div>
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(summary.appliedVsToyotaPoDelta)}</div><div class="task-tile-label">Applied &minus; Toyota PO Value</div></div>
        <div class="task-tile task-tile-clickable" data-target="cost-overquoted-list"><div class="task-tile-count">${summary.overquotedCount}</div><div class="task-tile-label">Excess Labor Budget</div></div>
        <div class="task-tile task-tile-clickable" data-target="cost-applied-no-po-list"><div class="task-tile-count">${summary.appliedNoPoCount}</div><div class="task-tile-label">Applied, No Toyota PO Yet</div></div>
        <div class="task-tile task-tile-clickable" data-target="cost-labor-overcharged-list"><div class="task-tile-count">${summary.laborOverchargedCount}</div><div class="task-tile-label">Labor Applied Over Estimate</div></div>
        <div class="task-tile task-tile-clickable" data-target="cost-contracted-increased-list"><div class="task-tile-count">${summary.contractedIncreasedCount}</div><div class="task-tile-label">Contracted Services Increased</div></div>
        ${summary.categoryOverages
          .map(
            (cat) =>
              `<div class="task-tile task-tile-clickable" data-target="cost-category-${cat.key}-list"><div class="task-tile-count">${cat.count}</div><div class="task-tile-label">${escapeHtml(cat.label)} Applied Over Estimate</div></div>`
          )
          .join("")}
        <div class="task-tile task-tile-clickable" data-target="cost-over-toyota-po-list"><div class="task-tile-count">${summary.appliedOverToyotaPoCount}</div><div class="task-tile-label">Applied Over Toyota PO Value</div></div>
      </div>

      <h3>Remaining estimate -- labor (${summary.overquotedCount})</h3>
      <p class="review-checklist-hint">
        Estimated price came in higher than what was actually applied -- $${formatMoney(summary.overquotedTotal)} in labor quoted
        that hasn't been used (yet, or at all). This is remaining estimate, not confirmed savings --
        it's only accurate once the project is complete and costs are reconciled.
      </p>
      <div class="review-list" id="cost-overquoted-list"></div>

      <h3>Applied cost, no Toyota PO yet (${summary.appliedNoPoCount})</h3>
      <p class="review-checklist-hint">
        A charge has been applied against these WOMs, but there's no Maximo/PO # on file yet -- $${formatMoney(summary.appliedNoPoTotal)}
        applied and not yet tied to a real PO.
      </p>
      <div class="review-list" id="cost-applied-no-po-list"></div>

      <h3>Labor applied over estimate (${summary.laborOverchargedCount})</h3>
      <p class="review-checklist-hint">
        Applied labor cost came in higher than what was estimated -- $${formatMoney(summary.laborOverchargedTotal)} over quote,
        across these WOMs. This compares against this app's own estimate, not a confirmed GL actual --
        see Reconciliation once a GL import is available for that comparison.
      </p>
      <div class="review-list" id="cost-labor-overcharged-list"></div>

      <h3>Contracted services increased (${summary.contractedIncreasedCount})</h3>
      <p class="review-checklist-hint">
        Applied contracted-services cost came in higher than what was estimated -- $${formatMoney(summary.contractedIncreasedTotal)}
        over quote, across these WOMs. Each row names the vendor whose charge came in over their own quote.
      </p>
      <div class="review-list" id="cost-contracted-increased-list"></div>

      ${summary.categoryOverages
        .map(
          (cat) => `
      <h3>${escapeHtml(cat.label)} applied over estimate (${cat.count})</h3>
      <p class="review-checklist-hint">
        Applied ${escapeHtml(cat.label.toLowerCase())} cost came in higher than what was estimated -- $${formatMoney(cat.total)}
        over quote, across these WOMs.
      </p>
      <div class="review-list" id="cost-category-${cat.key}-list"></div>
      `
        )
        .join("")}

      <h3>Applied over Toyota PO value (${summary.appliedOverToyotaPoCount})</h3>
      <p class="review-checklist-hint">
        Applied project total came in higher than the actual Toyota-approved PO amount -- $${formatMoney(summary.appliedOverToyotaPoTotal)}
        over the approved ceiling, across these WOMs. This checks against what Toyota actually approved, not
        just against this app's own estimate (see Remaining Estimate/Labor Applied Over Estimate/Contracted
        Services Increased above for estimate-vs-applied by category).
      </p>
      <div class="review-list" id="cost-over-toyota-po-list"></div>

      ${
        summary.vendorsOverchargingRepeatedly.length > 0
          ? `
      <h3>Vendors repeatedly over quote</h3>
      <p class="review-checklist-hint">
        Vendors whose contracted-services charge has come in over their own quote on more than one WOM --
        worth a conversation about why their estimates keep running short. Compared against this app's own
        estimate, not a confirmed GL actual.
      </p>
      <div class="review-list" id="cost-vendor-repeat-list"></div>
      `
          : ""
      }

      <h3>Vendor cost analysis</h3>
      <p class="review-checklist-hint">
        Total contracted-services $ applied per vendor, across every WOM on file -- how much business we
        actually do with each one.
      </p>
      <div class="review-list" id="cost-vendor-spend-list"></div>
    `;

    content.querySelectorAll(".task-tile-clickable").forEach((tile) => {
      tile.addEventListener("click", () => {
        const target = content.querySelector(`#${tile.dataset.target}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    const overquotedList = content.querySelector("#cost-overquoted-list");
    if (summary.overquoted.length === 0) {
      overquotedList.innerHTML = `<p class="empty-note">No WOMs have excess labor budget right now.</p>`;
    } else {
      summary.overquoted.forEach((w) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
            <span class="wom-code">${escapeHtml(w.code)}</span>
            <span class="wom-desc">${w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</span>
            <span class="wom-desc">Est $${formatMoney(w.estimatedPrice)} &middot; Applied $${formatMoney(w.appliedPrice)}</span>
            <span class="badge badge-approved">$${formatMoney(w.overage)} unused</span>
          </div>
        `;
        overquotedList.appendChild(row);
      });
    }

    const appliedNoPoList = content.querySelector("#cost-applied-no-po-list");
    if (summary.appliedNoPo.length === 0) {
      appliedNoPoList.innerHTML = `<p class="empty-note">Every WOM with an applied cost has a Toyota PO on file.</p>`;
    } else {
      summary.appliedNoPo.forEach((w) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
            <span class="wom-code">${escapeHtml(w.code)}</span>
            <span class="wom-desc">${w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</span>
            <span class="badge badge-draft">${escapeHtml(w.status)}</span>
            <span class="badge badge-rejected">$${formatMoney(w.appliedPrice)} applied</span>
          </div>
        `;
        appliedNoPoList.appendChild(row);
      });
    }

    const laborOverList = content.querySelector("#cost-labor-overcharged-list");
    if (summary.laborOvercharged.length === 0) {
      laborOverList.innerHTML = `<p class="empty-note">No WOMs have applied labor over estimate right now.</p>`;
    } else {
      summary.laborOvercharged.forEach((w) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
            <span class="wom-code">${escapeHtml(w.code)}</span>
            <span class="wom-desc">${w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</span>
            <span class="wom-desc">Est $${formatMoney(w.estimatedLabor)} &middot; Applied $${formatMoney(w.appliedLabor)}</span>
            <span class="badge badge-rejected">$${formatMoney(w.overage)} over</span>
          </div>
        `;
        laborOverList.appendChild(row);
      });
    }

    const contractedIncList = content.querySelector("#cost-contracted-increased-list");
    if (summary.contractedIncreased.length === 0) {
      contractedIncList.innerHTML = `<p class="empty-note">No WOMs have a contracted-services increase right now.</p>`;
    } else {
      summary.contractedIncreased.forEach((w) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
            <span class="wom-code">${escapeHtml(w.code)}</span>
            <span class="wom-desc">${w.vendorName ? escapeHtml(w.vendorName) : "No vendor matched"}</span>
            <span class="wom-desc">Est $${formatMoney(w.estimatedContracted)} &middot; Applied $${formatMoney(w.appliedContracted)}</span>
            <span class="badge badge-rejected">$${formatMoney(w.overage)} over</span>
          </div>
        `;
        contractedIncList.appendChild(row);
      });
    }

    for (const cat of summary.categoryOverages) {
      const list = content.querySelector(`#cost-category-${cat.key}-list`);
      if (cat.items.length === 0) {
        list.innerHTML = `<p class="empty-note">No WOMs have a ${escapeHtml(cat.label.toLowerCase())} increase right now.</p>`;
      } else {
        cat.items.forEach((w) => {
          const row = document.createElement("div");
          row.className = "review-row";
          row.innerHTML = `
            <div class="review-row-summary">
              <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
              <span class="wom-code">${escapeHtml(w.code)}</span>
              <span class="wom-desc">${w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</span>
              <span class="wom-desc">Est $${formatMoney(w.estimated)} &middot; Applied $${formatMoney(w.applied)}</span>
              <span class="badge badge-rejected">$${formatMoney(w.overage)} over</span>
            </div>
          `;
          list.appendChild(row);
        });
      }
    }

    const overToyotaPoList = content.querySelector("#cost-over-toyota-po-list");
    if (summary.appliedOverToyotaPo.length === 0) {
      overToyotaPoList.innerHTML = `<p class="empty-note">No WOMs are applied over their Toyota PO value right now.</p>`;
    } else {
      summary.appliedOverToyotaPo.forEach((w) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description || w.code)}</span>
            <span class="wom-code">${escapeHtml(w.code)}</span>
            <span class="wom-desc">${w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</span>
            <span class="wom-desc">Toyota PO $${formatMoney(w.toyotaPoValue)} &middot; Applied $${formatMoney(w.appliedPrice)}</span>
            <span class="badge badge-rejected">$${formatMoney(w.overage)} over</span>
          </div>
        `;
        overToyotaPoList.appendChild(row);
      });
    }

    const vendorRepeatList = content.querySelector("#cost-vendor-repeat-list");
    if (vendorRepeatList) {
      summary.vendorsOverchargingRepeatedly.forEach((v) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(v.vendorName || "Unknown vendor")}</span>
            <span class="wom-desc">${v.count} WOMs over quote</span>
            <span class="badge badge-rejected">$${formatMoney(v.totalOverage)} total over</span>
          </div>
        `;
        vendorRepeatList.appendChild(row);
      });
    }

    const vendorSpendList = content.querySelector("#cost-vendor-spend-list");
    if (summary.vendorContractedSpend.length === 0) {
      vendorSpendList.innerHTML = `<p class="empty-note">No WOM has both a vendor match and an applied contracted-services cost yet.</p>`;
    } else {
      summary.vendorContractedSpend.forEach((v) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(v.vendorName || "Unknown vendor")}</span>
            <span class="wom-desc">${v.womCount} WOM${v.womCount === 1 ? "" : "s"}</span>
            <span class="badge badge-submitted">$${formatMoney(v.totalAppliedContracted)} applied</span>
          </div>
        `;
        vendorSpendList.appendChild(row);
      });
    }
  }

  // "WOM Lookup": pick any WOM and see everything about it in one place --
  // status/budget/pricing (same data drawWoms already manages), plus who's
  // logged time against it and how much, all-time across every week it's
  // ever appeared on, not scoped to the current month the way most other
  // tabs here are. Read-only, and open to techs too (see techHome.js) since
  // it's a lookup tool, not a management screen.
  async function drawWomLookup(content) {
    const [allWoms, locations] = await Promise.all([api.get("/api/woms"), api.get("/api/locations")]);
    // "Pending"/"requested" WOMs have no real WOM # yet -- there's nothing
    // to look up hours/pricing against, so they don't belong in a tool for
    // finding a WOM you already have hours/pricing on. They still show up
    // in the main WOM Projects list and Priorities, where following up on
    // them is the actual point.
    const woms = allWoms.filter((w) => w.status !== "pending" && w.status !== "requested");
    const sorted = [...woms].sort((a, b) => a.code.localeCompare(b.code));
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");

    content.innerHTML = `
      <p class="review-checklist-hint">
        Look up any WOM to see its status, budget, and pricing, plus every technician who's logged
        time against it and how much -- all-time, not just this month.
      </p>
      <div class="roster-filters">
        <label class="roster-filter-field">
          <span>Location</span>
          <select class="wom-lookup-location-filter"><option value="">All locations</option>${locationOptions}</select>
        </label>
        <label class="roster-filter-field">
          <span>Search</span>
          <input type="text" class="wom-lookup-search" placeholder="Type a WOM # or project name…" />
        </label>
      </div>
      <select class="wom-lookup-select" size="8"></select>
      <div class="wom-lookup-detail"></div>
    `;

    const locationFilter = content.querySelector(".wom-lookup-location-filter");
    const searchInput = content.querySelector(".wom-lookup-search");
    const select = content.querySelector(".wom-lookup-select");
    const detail = content.querySelector(".wom-lookup-detail");

    // Narrows the visible options as either filter changes -- a plain
    // <select> can't be typed into to filter its own options, so the text
    // box rebuilds the list instead, same idea as the roster's own search.
    function renderOptions() {
      const loc = locationFilter.value;
      const q = searchInput.value.trim().toLowerCase();
      const filtered = sorted.filter((w) => {
        if (loc && w.locationCode !== loc) return false;
        if (q && !`${w.code} ${w.description}`.toLowerCase().includes(q)) return false;
        return true;
      });
      const previousValue = select.value;
      const optionsHtml = filtered
        .map((w) => {
          const loc = locationByCode[w.locationCode];
          return `<option value="${escapeHtml(w.code)}">${escapeHtml(w.code)} -- ${escapeHtml(w.description)}${loc ? ` (${escapeHtml(loc.name)})` : ""}</option>`;
        })
        .join("");
      select.innerHTML = `<option value="">${filtered.length === 0 ? "No matching WOMs" : "Choose a WOM…"}</option>${optionsHtml}`;
      if (filtered.some((w) => w.code === previousValue)) {
        select.value = previousValue;
      } else {
        detail.innerHTML = "";
      }
    }

    renderOptions();
    locationFilter.addEventListener("change", renderOptions);
    searchInput.addEventListener("input", renderOptions);

    select.addEventListener("change", async () => {
      if (!select.value) {
        detail.innerHTML = "";
        return;
      }
      detail.innerHTML = `<p class="review-checklist-hint">Loading…</p>`;
      const wom = await api.get(`/api/woms/${encodeURIComponent(select.value)}/lookup`);
      detail.innerHTML = renderWomLookupDetail(wom);
    });
  }

  function renderWomLookupDetail(wom) {
    const hoursLine =
      wom.budgetHours == null
        ? `${wom.totalHours}h logged (no budget set)`
        : `${wom.totalHours}h of ${wom.budgetHours}h budgeted (${wom.remainingHours}h left)`;
    const byTech =
      wom.hoursByTechnician.length === 0
        ? `<p class="review-checklist-hint">No hours logged against this WOM yet.</p>`
        : `<table class="detail-table">
            <thead><tr><th>Technician</th><th>Hours</th></tr></thead>
            <tbody>${wom.hoursByTechnician.map((h) => `<tr><td>${escapeHtml(h.techName)}</td><td>${h.hours}</td></tr>`).join("")}</tbody>
          </table>`;

    return `
      <div class="wom-lookup-card">
        <div class="wom-lookup-header">
          <span class="wom-code">${escapeHtml(wom.code)}</span>
          <strong>${escapeHtml(wom.description)}</strong>
          <span class="badge badge-${womStatusBadgeClass(wom.status)}">${escapeHtml(WOM_STATUS_LABELS[wom.status] || wom.status)}</span>
          ${wom.smartsheetLineNumber ? `<span class="wom-line-tag">Line ${escapeHtml(String(wom.smartsheetLineNumber))}</span>` : ""}
          ${wom.smartsheetLink ? `<a class="btn btn-link" href="${escapeHtml(wom.smartsheetLink)}" target="_blank" rel="noopener">Open in Smartsheet ↗</a>` : ""}
        </div>
        <div class="wom-lookup-stats">
          <div><span class="wom-lookup-stat-label">Location</span>${escapeHtml(wom.locationCode || "—")}</div>
          <div><span class="wom-lookup-stat-label">Hours</span>${hoursLine}</div>
          <div><span class="wom-lookup-stat-label">Estimated</span>$${formatMoney(wom.estimatedPrice)}</div>
          <div><span class="wom-lookup-stat-label">Applied (posted)</span>$${formatMoney(wom.appliedPrice)}</div>
        </div>
        <h4>Hours by technician</h4>
        ${byTech}
      </div>
    `;
  }

  function auditActionLabel(action) {
    return action
      .toLowerCase()
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }

  function auditRangeCutoff(range) {
    if (!range) return null;
    const days = { "1": 1, "7": 7, "30": 30, "90": 90 }[range];
    if (!days) return null;
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }

  async function drawAudit(content) {
    const entries = await api.get("/api/audit");
    const actions = [...new Set(entries.map((e) => e.action))].sort();

    content.innerHTML = `
      <div class="wom-filter-bar audit-filter-bar">
        <div class="search-field">
          <span class="search-field-icon">&#128269;</span>
          <input type="text" class="audit-search" placeholder="Search actor, action, or details" value="${escapeHtml(auditFilters.search)}" />
        </div>
        <select class="audit-action-filter">
          <option value="">All actions</option>
          ${actions.map((a) => `<option value="${escapeHtml(a)}" ${auditFilters.action === a ? "selected" : ""}>${escapeHtml(auditActionLabel(a))}</option>`).join("")}
        </select>
        <select class="audit-range-filter">
          <option value="">All time</option>
          <option value="1" ${auditFilters.range === "1" ? "selected" : ""}>Last 24 hours</option>
          <option value="7" ${auditFilters.range === "7" ? "selected" : ""}>Last 7 days</option>
          <option value="30" ${auditFilters.range === "30" ? "selected" : ""}>Last 30 days</option>
          <option value="90" ${auditFilters.range === "90" ? "selected" : ""}>Last 90 days</option>
        </select>
      </div>
      <p class="audit-count"></p>
      <div id="audit-table-wrap"></div>
    `;

    function refresh() {
      const search = auditFilters.search.toLowerCase();
      const cutoff = auditRangeCutoff(auditFilters.range);
      const filtered = entries.filter((e) => {
        if (auditFilters.action && e.action !== auditFilters.action) return false;
        if (cutoff && new Date(e.timestamp).getTime() < cutoff) return false;
        if (search && !`${e.actor} ${e.action} ${e.details}`.toLowerCase().includes(search)) return false;
        return true;
      });
      content.querySelector(".audit-count").textContent = `${filtered.length} of ${entries.length} entries.`;
      content.querySelector("#audit-table-wrap").innerHTML = `
        <table class="detail-table audit-table">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            ${filtered
              .map(
                (e) => `
              <tr>
                <td>${new Date(e.timestamp).toLocaleString()}</td>
                <td>${escapeHtml(e.actor)}</td>
                <td>${escapeHtml(auditActionLabel(e.action))}</td>
                <td>${escapeHtml(e.details)}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      `;
    }

    content.querySelector(".audit-search").addEventListener("input", (e) => {
      auditFilters.search = e.target.value;
      refresh();
    });
    content.querySelector(".audit-action-filter").addEventListener("change", (e) => {
      auditFilters.action = e.target.value;
      refresh();
    });
    content.querySelector(".audit-range-filter").addEventListener("change", (e) => {
      auditFilters.range = e.target.value;
      refresh();
    });

    refresh();
  }
}
