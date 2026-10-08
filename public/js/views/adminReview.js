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
import { renderInvoicing } from "./invoicing.js";
import { renderGlReconciliation } from "./gl.js";
import { renderPerformance } from "./performance.js";
import { renderSpendBreakdown } from "./spendBreakdown.js";
import { renderBudgetReview } from "./budgetReview.js";
import { renderCellPhones } from "./cellPhones.js";
import { renderMeals } from "./meals.js";
import { renderFiscalCalendar } from "./fiscalCalendar.js";
import { renderIntegrations } from "./integrations.js";
import { openModal } from "../modal.js";
import { WOM_REQUEST_FORM_URL, TERRITORIES } from "../constants.js";
import { getTerritory, setTerritory, onTerritoryChange } from "../globalFilters.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";

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
  { key: "timekeeping", label: "Timekeeping", tabs: ["techalloc", "overview", "review", "fiscalcalendar"] },
  { key: "roster", label: "Roster", tabs: ["technicians"] },
  { key: "vendors", label: "Vendors", tabs: ["vendors", "onboarding"] },
  { key: "locations", label: "Locations", tabs: ["locations"] },
  { key: "wom", label: "WOM", tabs: ["woms", "womlookup", "schedule"] },
  { key: "pos", label: "POs", tabs: ["pos"] },
  { key: "financials", label: "Financials", tabs: ["costanalysis", "invoicing", "reclasses", "glreconciliation", "spendbreakdown", "budgetreview", "cellphones", "meals", "laborreports"] },
  { key: "performance", label: "Performance", tabs: ["performance"] },
  { key: "audit", label: "Audit Trail", tabs: ["audit"] },
  { key: "integrations", label: "Integrations", tabs: ["integrations"] },
];

const TAB_LABELS = {
  mywork: "My Work",
  checklist: "Checklist",
  techalloc: "Tech Allocation",
  schedule: "Schedule",
  overview: "Overview",
  review: "Weekly Review",
  fiscalcalendar: "Fiscal Calendar",
  costanalysis: "Overview",
  invoicing: "Invoicing",
  reclasses: "Reclasses",
  glreconciliation: "Reconciliation",
  spendbreakdown: "Spend Analysis",
  budgetreview: "Budget Review",
  cellphones: "Cell Phones",
  meals: "Meals",
  laborreports: "Reports",
  technicians: "Technicians",
  vendors: "Vendor Directory",
  onboarding: "Onboarding",
  locations: "Locations",
  woms: "WOM Projects",
  womlookup: "WOM Lookup",
  pos: "Budget PO Tracker",
  performance: "Performance",
  audit: "Audit Trail",
  integrations: "Integrations",
};

function sectionForTab(tab) {
  return NAV_SECTIONS.find((s) => s.tabs.includes(tab)) || NAV_SECTIONS[0];
}

// Financials is limited to Midwest admins (by their own home location's
// territory, snapshotted into state.user at login -- see
// db.getAdminTerritory) plus whoever holds the RFM/reviewer role, mirroring
// the server-side requireFinancialsAccess gate on the same routes. An admin
// with no home location set yet (territory null) is let through, same as
// server-side, rather than hidden for every admin the moment this ships.
function canSeeFinancials() {
  const territory = state.user && state.user.territory;
  return territory == null || territory === "Midwest" || Boolean(state.user && state.user.isPseReviewer);
}

function visibleNavSections() {
  return canSeeFinancials() ? NAV_SECTIONS : NAV_SECTIONS.filter((s) => s.key !== "financials");
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

export async function renderAdminReview(container, navHost, topbarHost, subtabHost, globalToolsHost) {
  let activeTab = "review";
  let allocTechId = null;
  // Which technicians' detail panels are expanded on Weekly Review -- just
  // membership, not a cache of the detail itself, so a stale snapshot can
  // never be shown after something changes it elsewhere (Tech Allocation,
  // another tab, etc.). Detail is always fetched fresh when rendering.
  const expanded = new Set();
  // Which WOM's full profile page is open (null = showing the list instead),
  // and which of its tabs -- same pattern as vendorProfileId/vendorProfileTab.
  let womProfileCode = null;
  let womProfileTab = "overview";
  // Where "back" should actually go -- a WOM profile can be opened from
  // somewhere other than the WOM Projects list itself (e.g. a row in
  // Financials > Invoicing), and jumping to the WOM Projects list on the
  // way back loses that place entirely, which is its own reported
  // annoyance. null means "opened from the WOM Projects list" (the default,
  // original behavior); anything else is a tab key to goTo() instead.
  let womProfileReturnTo = null;
  function openWomProfile(code, tab, returnTo) {
    womProfileCode = code;
    womProfileTab = tab || "overview";
    womProfileReturnTo = returnTo || null;
    goTo("woms");
  }
  const locationEditing = new Set();
  // Territory is filtered globally now (see globalFilters.js / the topbar
  // selector), not as a separate per-page dropdown.
  let womGroupFilter = "active"; // "active" | "closed" -- the pill toggle above the WOM list
  let womLocationFilter = ""; // "" = all locations
  let womStatusFilter = ""; // "" = all statuses
  let womSearchQuery = "";
  // Financials -> Cost Analysis: which review category's table is showing
  // below the tile strip, plus that table's own location/search filters and
  // sort state. null costCategoryKey means "not drawn yet" -- drawCostAnalysis
  // defaults it to the first category the first time it runs.
  let costCategoryKey = null;
  let costLocationFilter = "";
  let costSearchQuery = "";
  let costSortKey = null; // "project" | "wom" | "location" | "col<N>" | null (server's own default order)
  let costSortDir = "asc";
  // One-shot: a reclass item id to auto-open in the Reclasses tab, set when
  // a "Reclassed" link is clicked from the Applied-over-PO category table.
  let reclassItemToOpen = null;
  // One-shot: a PO id to auto-open in the Budget PO Tracker, set by the
  // global topbar search (same pattern as reclassItemToOpen above).
  let poToOpen = null;
  function openPoProfile(poId) {
    poToOpen = poId;
    goTo("pos");
  }
  // One-shot: a WOM # to pre-fill into the "Flag a Reclass Finding" form,
  // set when "+ Flag a reclass for this WOM" is clicked from a WOM's own
  // detail modal.
  let reclassFlagPrefillWom = null;
  // Contracted Services Increased groups its rows by vendor (Krista: one
  // vendor name + total, drilling down to the specifics, same idea as the
  // Vendor cost analysis section lower on the page) -- which vendor groups
  // are currently expanded.
  const expandedCostVendors = new Set();
  // Financials -> Repeated Costs Above Quote / Vendor Spend Overview: one
  // shared filter bar (region/location/subsidiary/project status, plus
  // review status for the first table only), each table's own sort, and
  // which vendor rows are expanded to show their supporting WOMs.
  let vaRegionFilter = "";
  let vaLocationFilter = "";
  let vaSubsidiaryFilter = "";
  let vaStatusFilter = ""; // "" | "open" | "completed"
  let vaReviewStatusFilter = ""; // "" | "needs_review" | "mixed" | "reviewed" -- table 1 only
  const vaAboveQuoteExpanded = new Set();
  const vaSpendExpanded = new Set();
  let vaAboveQuoteSort = { key: "aboveQuoteCount", dir: "desc" };
  let vaSpendSort = { key: "totalAppliedContracted", dir: "desc" };
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
  // A case-log save recomputes several vendor-level fields server-side
  // (onboardingStage, parentStage, the two onboarding approval flags) that
  // don't come back in that endpoint's own response (an array of case-log
  // entries, kept that shape for existing callers/tests). Refetching the
  // list and merging the caller's own `v` keeps it in sync on the vendor
  // profile tab, which re-renders from that same `v` reference rather than
  // a full board redraw.
  async function refreshVendorFields(v) {
    vendorsCache = await api.get("/api/admin/vendors");
    unregisteredPoVendorsCache = null;
    const fresh = vendorsCache.find((x) => x.id === v.id);
    if (fresh) Object.assign(v, fresh);
  }
  const vendorFilters = { search: "", cwStatus: "", toyotaStatus: "", formsStatus: "" };
  const vendorRequestEditing = new Set(); // vendor case-log request ids currently showing their edit form
  // Onboarding board rows: which vendor IDs currently have their "Details"
  // section expanded -- every field in there autosaves, which re-renders
  // the whole board (drawVendorOnboarding) on every change, so the open/
  // closed state has to live outside that render or it would snap back
  // shut after each edit.
  const onboardingRowDetailsExpanded = new Set();
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
    if (activeTab === "woms" && tab !== "woms") womProfileCode = null;
    activeTab = tab;
    sectionLastTab[sectionForTab(tab).key] = tab;
    draw();
  }

  renderGlobalTopbarTools(globalToolsHost);
  draw();

  async function draw() {
    const myGeneration = ++drawGeneration;
    // Defensive only -- nothing in this file currently navigates straight to
    // a Financials tab, but if that ever changes, a Midwest/RFM check that
    // only hid the sidebar button would still leave the tab reachable.
    if (!canSeeFinancials() && sectionForTab(activeTab).key === "financials") {
      activeTab = "review";
    }
    const sections = visibleNavSections();
    const currentSection = sectionForTab(activeTab);

    navHost.innerHTML = sections.map(
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
    // Every tab fetches its own data before rendering real content, so one
    // shared loading state shown here -- overwritten the moment that tab's
    // own draw function sets content.innerHTML -- is enough to make every
    // page's loading look the same without each one building its own.
    renderLoadingState(content, loadingLabelFor(TAB_LABELS[activeTab] || "content"));
    // No admin tab currently fills this back in (Tech Allocation's own
    // technician/week picker moved into the sub-tab band instead -- see
    // drawTechAllocation); still cleared up front in case a future tab
    // wants it, same as the technician-facing view still does.
    topbarHost.innerHTML = "";
    if (activeTab === "mywork") await renderTaskBoard(content);
    else if (activeTab === "checklist") await drawPriorities(content);
    else if (activeTab === "techalloc") await drawTechAllocation(content);
    else if (activeTab === "schedule") await renderSchedule(content, { onOpenWom: openWomProfile });
    else if (activeTab === "overview") await drawOverview(content);
    else if (activeTab === "review") await drawReview(content);
    else if (activeTab === "fiscalcalendar") await renderFiscalCalendar(content);
    else if (activeTab === "locations") await drawLocations(content);
    else if (activeTab === "woms") await drawWoms(content);
    else if (activeTab === "womlookup") await drawWomLookup(content);
    else if (activeTab === "technicians") {
      renderTechniciansTab(content, jumpToTech);
      jumpToTech = null;
    }
    else if (activeTab === "vendors") await drawVendors(content);
    else if (activeTab === "onboarding") await drawVendorOnboarding(content);
    else if (activeTab === "pos") {
      const openPoId = poToOpen;
      poToOpen = null;
      await renderPos(content, { openPoId });
    }
    else if (activeTab === "costanalysis") await drawCostAnalysis(content);
    else if (activeTab === "invoicing") {
      await renderInvoicing(content, { onOpenWom: (code) => openWomProfile(code, "overview", "invoicing") });
    }
    else if (activeTab === "reclasses") {
      const openItemId = reclassItemToOpen;
      reclassItemToOpen = null;
      const flagPrefillWom = reclassFlagPrefillWom;
      reclassFlagPrefillWom = null;
      await renderReclasses(content, { openItemId, flagPrefillWom, onOpenWom: openWomProfile });
    }
    else if (activeTab === "glreconciliation") await renderGlReconciliation(content);
    else if (activeTab === "spendbreakdown") await renderSpendBreakdown(content);
    else if (activeTab === "budgetreview") await renderBudgetReview(content);
    else if (activeTab === "cellphones") await renderCellPhones(content);
    else if (activeTab === "meals") await renderMeals(content);
    else if (activeTab === "laborreports") await drawLaborReports(content);
    else if (activeTab === "performance") await renderPerformance(content);
    else if (activeTab === "integrations") await renderIntegrations(content);
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
    // The nav pill and the bell deliberately count different things (the
    // pill is a curated "a few things to look at today," per the comment on
    // computePriorityCount; the bell's badge mirrors exactly what's in its
    // own dropdown, built by computeBellItems) -- fetched in parallel so one
    // slow/failing count never blocks the other.
    const [count, bellItems] = await Promise.all([computePriorityCount(), computeBellItems().catch(() => [])]);
    if (myGeneration !== drawGeneration) return;
    priorityCount = count;
    const nav = navHost.querySelector('.sidebar-nav-item[data-section="priorities"]');
    if (nav) {
      const existingBadge = nav.querySelector(".tab-badge");
      if (count > 0) {
        if (existingBadge) existingBadge.textContent = count;
        else nav.insertAdjacentHTML("beforeend", ` <span class="tab-badge">${count}</span>`);
      } else if (existingBadge) {
        existingBadge.remove();
      }
    }
    const bellBadge = globalToolsHost && globalToolsHost.querySelector(".topbar-bell-badge");
    if (bellBadge) {
      bellBadge.textContent = bellItems.length;
      bellBadge.hidden = bellItems.length === 0;
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
  // Mirrors db.js's 4 canonical document case types exactly -- Blank
  // Invoice joined COI/W-9/Payment as a real required case alongside them
  // (see the onboarding redesign). Kept as a small client-side constant
  // rather than fetched from the bulk case-summary endpoint so the vendor
  // profile's Cases section can render immediately from a single
  // per-vendor `/requests` call instead of pulling every vendor's case
  // summary just to get this static list.
  const ONBOARDING_CASE_TYPES = [
    { type: "Onboarding - COI", key: "coi", label: "COI" },
    { type: "Onboarding - W8/W9", key: "w9", label: "W-9" },
    { type: "Onboarding - Payment Details", key: "payment", label: "Payment / ACH" },
    { type: "Onboarding - Blank Invoice", key: "blank_invoice", label: "Blank Invoice" },
  ];
  // Per-case collection status -- separate from the case's own approval
  // status (CASE_STATUS_OPTIONS below). Lives on the vendor row itself
  // (v.coiFormStatus etc.) rather than the case log, since it has to exist
  // even before any case has been started.
  const FORM_STATUS_OPTIONS = ["not_requested", "requested", "gathering", "received", "not_required"];
  const FORM_STATUS_LABELS = {
    not_requested: "Not Requested",
    requested: "Requested",
    gathering: "Gathering",
    received: "Received",
    not_required: "Not required",
  };
  const FORM_STATUS_KEY_BY_CASE_KEY = {
    coi: "coiFormStatus",
    w9: "w9FormStatus",
    payment: "paymentFormStatus",
    blank_invoice: "blankInvoiceFormStatus",
  };
  // Each form's own review-notes checklist -- an expandable multi-select
  // list of the specific issues that can be found on that document, per
  // the redesign spec. Stored per-case as an array of these keys
  // (reviewNotesSelected); label text is what renders when the checklist
  // is collapsed/closed.
  const REVIEW_NOTES_OPTIONS = {
    coi: [
      { key: "needs_limits_fixed", label: "Needs Limits Fixed" },
      { key: "missing_coverage", label: "Missing Coverage" },
      { key: "needs_ai_wording", label: "Needs AI Wording" },
      { key: "fix_holder_information", label: "Fix Holder information" },
      { key: "doesnt_match_w9_information", label: "Doesn't Match W9 Information" },
      { key: "acord_25_form", label: "ACORD 25 form" },
    ],
    w9: [
      { key: "incorrect_version", label: "Incorrect W-9 version — must be October 2018 or March 2024" },
      { key: "not_signed_dated", label: "Not signed and dated" },
    ],
    payment: [
      { key: "not_on_bank_letterhead", label: "Not on Bank Letterhead" },
      { key: "doesnt_match_w9_name", label: "Doesn't Match W9 Name" },
      { key: "doesnt_match_w9_address", label: "Doesn't Match W9 Address" },
      { key: "not_signed_dated", label: "Not Signed/Dated" },
      { key: "no_contact_info", label: "Doesn't have Contact name and phone number" },
      { key: "no_remit_to_info", label: "Doesn't have Remit-to/payment information" },
    ],
    blank_invoice: [
      { key: "doesnt_match_w9_name", label: "Doesn't Match W9 Name" },
      { key: "doesnt_match_w9_address", label: "Doesn't Match W9 Address" },
      { key: "no_remit_to_address", label: "Doesn't have Remit-to/payment address" },
    ],
  };
  function latestCaseOfType(entries, type) {
    const matches = entries.filter((e) => e.requestType === type);
    if (matches.length === 0) return null;
    return matches.reduce((latest, e) =>
      new Date(e.updatedAt || e.requestedAt) >= new Date(latest.updatedAt || latest.requestedAt) ? e : latest
    );
  }
  // A vendor's own latest case of each of the 4 canonical types, keyed by
  // ct.key -- same shape the bulk case-summary endpoint already returns
  // per vendor, built here from a single vendor's own /requests list so
  // the profile tab and the board read identically (see
  // computeApprovalBadge, renderCasePillHtml).
  function caseSummaryFromEntries(entries) {
    const summary = {};
    ONBOARDING_CASE_TYPES.forEach((ct) => {
      const latest = latestCaseOfType(entries, ct.type);
      if (latest) summary[ct.key] = latest;
    });
    return summary;
  }
  // "X/4 document cases approved" -- Not-required forms are excluded from
  // the denominator; a W-9 marked "previously approved in ServiceEdge"
  // already carries status Approved by the time this reads it.
  function computeApprovalBadge(v, caseSummary) {
    let approved = 0;
    let total = 0;
    ONBOARDING_CASE_TYPES.forEach((ct) => {
      if (v[FORM_STATUS_KEY_BY_CASE_KEY[ct.key]] === "not_required") return;
      total++;
      const latest = caseSummary[ct.key];
      if (latest && String(latest.status || "").trim().toLowerCase() === "approved") approved++;
    });
    return { approved, total };
  }
  function renderApprovalBadgeHtml(v, caseSummary) {
    const { approved, total } = computeApprovalBadge(v, caseSummary);
    return `<span class="badge badge-${approved === total && total > 0 ? "approved" : "draft"}">${approved}/${total} document cases approved</span>`;
  }
  // A real checkbox (not a one-way "Mark sent" link) -- checking it
  // records the sent date and bulk-advances the 4 forms that are still
  // Not Requested; clearing it only removes the date, never reverting a
  // form's own collection progress (see db.setWelcomeEmailSent).
  function renderWelcomeEmailLine(v) {
    return `
      <div class="onboarding-welcome-line">
        <label class="onboarding-welcome-checkbox-label">
          <input type="checkbox" class="onboarding-welcome-checkbox" ${v.welcomeEmailSentAt ? "checked" : ""} />
          Welcome Email Sent
        </label>
        ${v.welcomeEmailSentAt ? `<span class="wom-desc">sent ${new Date(v.welcomeEmailSentAt).toLocaleDateString()}</span>` : ""}
      </div>
      <div class="onboarding-approval-flags">
        <span class="badge badge-${v.onboardingCwApproved ? "approved" : "draft"}">C&amp;W ${v.onboardingCwApproved ? "Approved" : "Pending"}</span>
        <span class="badge badge-${v.onboardingToyotaApproved ? "approved" : "draft"}">Toyota ${v.onboardingToyotaApproved ? "Approved" : "Pending"}</span>
      </div>
    `;
  }
  function wireWelcomeEmailLine(host, v, onLogged) {
    const checkbox = host.querySelector(".onboarding-welcome-checkbox");
    if (!checkbox) return;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        const updated = await api.patch(`/api/admin/vendors/${v.id}/welcome-email`, { sent: checkbox.checked });
        Object.assign(v, updated);
        invalidateVendorsCache();
        await onLogged();
      } catch (err) {
        window.alert(err.message);
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
      }
    });
  }
  const COI_ONLY_STATUS = "Waiting on VPO Waiver";
  const CASE_STATUS_OPTIONS = ["Not started", "Case started", "In review", "Revisions needed", "Approved", "Denied"];
  function caseStatusOptionsFor(caseKey) {
    if (caseKey !== "coi") return CASE_STATUS_OPTIONS;
    const withoutDenied = CASE_STATUS_OPTIONS.slice(0, -1);
    return [...withoutDenied, COI_ONLY_STATUS, CASE_STATUS_OPTIONS[CASE_STATUS_OPTIONS.length - 1]];
  }
  // Mirrors db.js's VENDOR_DENIAL_REASONS. An explicit denial an admin picks
  // directly -- "unacceptable work or service" and "cost" in particular are
  // business calls no onboarding case status captures, so this exists
  // alongside (not instead of) a case being denied.
  const VENDOR_DENIAL_REASONS = [
    { key: "insurance", label: "Insurance" },
    { key: "document_chasing", label: "Document chasing" },
    { key: "unacceptable_service", label: "Unacceptable work or service" },
    { key: "cost", label: "Cost" },
    { key: "other", label: "Other" },
  ];
  function denialReasonLabel(key) {
    return (VENDOR_DENIAL_REASONS.find((r) => r.key === key) || {}).label || "";
  }
  function caseStatusBadgeClass(status) {
    const s = String(status || "").trim().toLowerCase();
    if (s === "approved") return "approved";
    if (s === "denied") return "rejected";
    if (s === "revisions needed" || s === "waiting on vpo waiver") return "warn";
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
  // A vendor's compliance checklist entry is scoped to whoever actually
  // deals with that vendor -- its own real territories (derived from PO/WOM
  // activity, v.territories) when it has any, or whoever created its
  // profile when it doesn't yet (brand new, nothing matched to it). Left
  // unfiltered on "All territories" so RFM/cross-territory review still
  // sees everything -- this is deliberately scoped lower than Financials'
  // own Midwest-only gate, since any admin can reach the Vendors tab.
  function vendorInTerritoryScope(v) {
    const activeTerritory = getTerritory();
    if (!activeTerritory) return true;
    if (v.territories && v.territories.includes(activeTerritory)) return true;
    if ((!v.territories || v.territories.length === 0) && v.createdBy === (state.user && state.user.id)) return true;
    return false;
  }

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
      .filter(
        (v) =>
          v.onboardingStage === "onboarded" &&
          (v.formsStatus === "outdated" || !v.formChecksComplete || v.w9InvoiceStale) &&
          vendorInTerritoryScope(v)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    content.innerHTML = `
      <p class="review-checklist-hint">
        Onboarding is tracked as ServiceEdge tracks it -- a COI, W-9, Payment/ACH, and Blank Invoice
        case per vendor, each independently approved or denied, all four nested under one parent
        onboarding case with its own case #, notes, and 6-stage pipeline (Gathering forms &rarr;
        Cases started &rarr; Document review &rarr; Ready for Toyota &rarr; Submitted to Toyota &rarr;
        Approved). All four cases approved moves the parent to Ready for Toyota; recording Toyota's
        actual approval is what finally moves the vendor to Onboarded -- any one case denied moves it
        to Denied. A vendor with no case update in ${ONBOARDING_STALE_DAYS}+ days is flagged so nothing
        quietly sits untouched. This board shows case status only, never a vendor's actual documents.
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
            await api.patch(`/api/admin/vendors/${v.id}/welcome-email`, { sent: true });
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

  const PARENT_STAGES = ["gathering_forms", "cases_started", "document_review", "ready_for_toyota", "submitted_to_toyota", "approved"];
  const PARENT_STAGE_LABELS = {
    gathering_forms: "Gathering forms",
    cases_started: "Cases started",
    document_review: "Document review",
    ready_for_toyota: "Ready for Toyota",
    submitted_to_toyota: "Submitted to Toyota",
    approved: "Approved",
  };
  // A non-interactive progress pill -- the stage itself only ever moves via
  // the specific actions below (auto-advancing through the first four,
  // Submit to Toyota/Record Toyota Approval for the last two), never by
  // clicking a stage directly.
  function renderParentStagePillHtml(v) {
    const currentIndex = PARENT_STAGES.indexOf(v.parentStage);
    return `
      <div class="onboarding-parent-stage-pills">
        ${PARENT_STAGES.map((s, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
          return `<span class="onboarding-parent-stage-pill onboarding-parent-stage-pill-${state}">${PARENT_STAGE_LABELS[s]}</span>`;
        }).join("")}
      </div>
    `;
  }
  // The parent onboarding case: its own case #, notes (kept separate from
  // any document case's own notes), the two onboarding contacts, and the
  // 3 stage-progression actions (Submit to Toyota / Record Toyota Approval
  // -- Mark vendor denied lives in the deny panel below, same optional-
  // exit action either way). Shared between the board and the vendor
  // profile tab so editing it updates both without duplication.
  function parentCaseHintText(v, caseSummary) {
    if (v.parentStage === "approved") return "Toyota's approval is on file -- this vendor is fully onboarded.";
    if (v.parentStage === "submitted_to_toyota") return "Submitted -- waiting on Toyota to record their approval.";
    const { approved, total } = computeApprovalBadge(v, caseSummary);
    const remaining = total - approved;
    return `${remaining} required case${remaining === 1 ? "" : "s"} pending approval.`;
  }
  function renderParentCaseHtml(v, caseSummary) {
    return `
      <div class="onboarding-parent-case">
        <div class="onboarding-parent-case-heading">
          Parent onboarding case
          <span class="badge badge-draft">${PARENT_STAGE_LABELS[v.parentStage]}</span>
        </div>
        <div class="onboarding-parent-grid">
          <label class="onboarding-field">
            Payment Verification Contact
            <span class="onboarding-contact-subfields">
              <input type="text" class="onboarding-parent-contact-name" placeholder="Contact name" value="${escapeHtml(v.paymentVerificationContactName || "")}" />
              <input type="text" class="onboarding-parent-contact-phone" placeholder="Contact phone number" value="${escapeHtml(v.paymentVerificationContactPhone || "")}" />
              <input type="text" class="onboarding-parent-contact-email" placeholder="Contact email" value="${escapeHtml(v.paymentVerificationContactEmail || "")}" />
            </span>
          </label>
          <label class="onboarding-field">
            PO Notification Email
            <input type="text" class="onboarding-parent-po-email" placeholder="Email for purchase order notifications" value="${escapeHtml(v.poNotificationEmail || "")}" />
          </label>
          <label class="onboarding-field">
            Parent case number
            <input type="text" class="onboarding-parent-case-number" placeholder="Case number" value="${escapeHtml(v.parentCaseNumber || "")}" />
          </label>
          <label class="onboarding-field">
            Parent-case notes
            <textarea class="onboarding-parent-case-notes" placeholder="Notes for the parent case (separate from any document case's own notes)">${escapeHtml(v.parentCaseNotes || "")}</textarea>
          </label>
        </div>
        ${renderParentStagePillHtml(v)}
        <div class="onboarding-parent-case-actions">
          <button type="button" class="btn btn-primary onboarding-submit-toyota-btn" ${v.parentStage === "ready_for_toyota" ? "" : "disabled"}>Submit parent to Toyota</button>
          <button type="button" class="btn btn-secondary onboarding-record-toyota-approval-btn" ${v.parentStage === "submitted_to_toyota" ? "" : "disabled"}>Record Toyota approval</button>
        </div>
        <p class="onboarding-parent-case-hint">${parentCaseHintText(v, caseSummary)}</p>
      </div>
    `;
  }
  function wireParentCase(el, v, onLogged) {
    let saveTimer = null;
    async function save() {
      try {
        const updated = await api.patch(`/api/admin/vendors/${v.id}/parent-case`, {
          caseNumber: el.querySelector(".onboarding-parent-case-number").value.trim(),
          notes: el.querySelector(".onboarding-parent-case-notes").value.trim(),
          paymentContactName: el.querySelector(".onboarding-parent-contact-name").value.trim(),
          paymentContactPhone: el.querySelector(".onboarding-parent-contact-phone").value.trim(),
          paymentContactEmail: el.querySelector(".onboarding-parent-contact-email").value.trim(),
          poNotificationEmail: el.querySelector(".onboarding-parent-po-email").value.trim(),
        });
        Object.assign(v, updated);
        invalidateVendorsCache();
      } catch (err) {
        window.alert(err.message);
      }
    }
    // Autosaves as the admin types/leaves a field -- no explicit Save
    // button, matching every other field on this card. Debounced while
    // typing, flushed immediately on blur.
    el.querySelectorAll(
      ".onboarding-parent-case-number, .onboarding-parent-contact-name, .onboarding-parent-contact-phone, .onboarding-parent-contact-email, .onboarding-parent-po-email, .onboarding-parent-case-notes"
    ).forEach((input) => {
      input.addEventListener("input", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 700);
      });
      input.addEventListener("blur", () => {
        clearTimeout(saveTimer);
        save();
      });
    });
    el.querySelector(".onboarding-submit-toyota-btn").addEventListener("click", async () => {
      try {
        const updated = await api.post(`/api/admin/vendors/${v.id}/submit-to-toyota`, {});
        Object.assign(v, updated);
        invalidateVendorsCache();
        await onLogged();
      } catch (err) {
        window.alert(err.message);
      }
    });
    el.querySelector(".onboarding-record-toyota-approval-btn").addEventListener("click", async () => {
      try {
        const updated = await api.post(`/api/admin/vendors/${v.id}/record-toyota-approval`, {});
        Object.assign(v, updated);
        invalidateVendorsCache();
        await onLogged();
      } catch (err) {
        window.alert(err.message);
      }
    });
  }

  function renderOnboardingRow(v, content, caseTypes, caseSummary) {
    const el = document.createElement("div");
    const age = daysSince(v.updatedAt);
    const stale = v.onboardingStage === "in_progress" && age >= ONBOARDING_STALE_DAYS;
    el.className = `review-row onboarding-row${stale ? " review-row-pending" : ""}`;

    el.innerHTML = `
      <div class="review-row-summary">
        <span class="review-row-name">${escapeHtml(v.name)}</span>
        ${renderApprovalBadgeHtml(v, caseSummary)}
        <span class="wom-desc">${age === 0 ? "updated today" : `${age}d since last update`}</span>
        ${stale ? `<span class="badge badge-rejected">Stale</span>` : ""}
        <button class="btn btn-secondary onboarding-open-vendor-btn" type="button">Open vendor</button>
        <button class="btn btn-link onboarding-log-toggle" type="button">Full case history</button>
        <button class="btn btn-link onboarding-row-details-toggle" type="button">Details</button>
      </div>
      <div class="onboarding-row-details" ${onboardingRowDetailsExpanded.has(v.id) ? "" : "hidden"}>
        ${renderWelcomeEmailLine(v)}
        ${renderParentCaseHtml(v, caseSummary)}
        <div class="onboarding-cases-heading">
          Forms &amp; individual cases
          ${renderApprovalBadgeHtml(v, caseSummary)}
        </div>
        <div class="onboarding-cases">
          ${caseTypes.map((ct) => renderCasePillHtml(v, ct, caseSummary[ct.key])).join("")}
        </div>
        ${
          v.onboardingStage === "denied"
            ? `<div class="onboarding-denied-reason">
                 ${v.deniedReasonCategory ? `<span class="badge badge-rejected">${escapeHtml(denialReasonLabel(v.deniedReasonCategory))}</span>` : ""}
                 <input type="text" class="onboarding-denied-reason-input" placeholder="Note (optional, e.g. which case and why)" value="${escapeHtml(v.deniedReason)}" />
                 <button type="button" class="btn btn-link onboarding-denied-reason-save">Save note</button>
                 <button type="button" class="btn btn-link onboarding-reinstate-btn">Reinstate vendor</button>
               </div>`
            : `<details class="onboarding-deny-action">
                 <summary class="onboarding-other-outcome-toggle">Other outcome: mark vendor denied</summary>
                 <div class="onboarding-deny-panel">
                   <select class="onboarding-deny-reason-select">
                     <option value="">Reason for denial…</option>
                     ${VENDOR_DENIAL_REASONS.map((r) => `<option value="${r.key}">${escapeHtml(r.label)}</option>`).join("")}
                   </select>
                   <input type="text" class="onboarding-deny-detail-input" placeholder="Detail (optional)" />
                   <button type="button" class="btn btn-secondary danger-link onboarding-deny-confirm-btn">Confirm denial</button>
                 </div>
               </details>`
        }
      </div>
      <div class="review-row-detail onboarding-case-log" hidden></div>
    `;

    el.querySelector(".onboarding-open-vendor-btn").addEventListener("click", () => {
      openVendorProfile(v.id, "onboarding");
    });

    const detailsToggle = el.querySelector(".onboarding-row-details-toggle");
    const detailsHost = el.querySelector(".onboarding-row-details");
    detailsToggle.textContent = detailsHost.hidden ? "Details" : "Hide details";
    detailsToggle.addEventListener("click", () => {
      detailsHost.hidden = !detailsHost.hidden;
      detailsToggle.textContent = detailsHost.hidden ? "Details" : "Hide details";
      if (detailsHost.hidden) onboardingRowDetailsExpanded.delete(v.id);
      else onboardingRowDetailsExpanded.add(v.id);
    });

    wireWelcomeEmailLine(el, v, () => drawVendorOnboarding(content));
    wireParentCase(el, v, () => drawVendorOnboarding(content));

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

    const reinstateBtn = el.querySelector(".onboarding-reinstate-btn");
    if (reinstateBtn) {
      reinstateBtn.addEventListener("click", async () => {
        if (!window.confirm(`Reinstate ${v.name}? This clears the denial and re-checks their onboarding cases.`)) return;
        try {
          await api.post(`/api/admin/vendors/${v.id}/reinstate`, {});
          invalidateVendorsCache();
          await drawVendorOnboarding(content);
        } catch (err) {
          window.alert(err.message);
        }
      });
    }

    const denyConfirmBtn = el.querySelector(".onboarding-deny-confirm-btn");
    if (denyConfirmBtn) {
      denyConfirmBtn.addEventListener("click", async () => {
        const category = el.querySelector(".onboarding-deny-reason-select").value;
        const detail = el.querySelector(".onboarding-deny-detail-input").value.trim();
        if (!category) {
          window.alert("Pick a reason for the denial first.");
          return;
        }
        try {
          await api.post(`/api/admin/vendors/${v.id}/deny`, { category, reason: detail });
          invalidateVendorsCache();
          await drawVendorOnboarding(content);
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
  function selectedReviewNoteLabels(ct, selectedKeys) {
    const options = REVIEW_NOTES_OPTIONS[ct.key] || [];
    const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
    return options.filter((o) => keys.includes(o.key)).map((o) => o.label);
  }
  function renderReviewNotesChecklistHtml(ct, latest) {
    const options = REVIEW_NOTES_OPTIONS[ct.key] || [];
    if (options.length === 0) return "";
    const labels = selectedReviewNoteLabels(ct, latest && latest.reviewNotesSelected);
    return `
      <details class="onboarding-review-notes-details">
        <summary class="onboarding-review-notes-summary">${labels.length ? escapeHtml(labels.join(", ")) : "Review notes · select issues"}</summary>
        <div class="onboarding-review-notes-options">
          ${options
            .map(
              (o) => `
            <label class="onboarding-review-notes-option">
              <input type="checkbox" value="${o.key}" ${latest && (latest.reviewNotesSelected || []).includes(o.key) ? "checked" : ""} />
              ${escapeHtml(o.label)}
            </label>`
            )
            .join("")}
        </div>
      </details>
    `;
  }
  function vpoWaiverReasonLabel(reason) {
    return { limits: "Limits", missing_coverage: "Missing Coverage", both: "Limits & Missing Coverage" }[reason] || "Not set";
  }
  const VPO_WAIVER_STATUS_OPTIONS = ["not_started", "in_review", "approved", "denied"];
  const VPO_WAIVER_STATUS_LABELS = { not_started: "Not started", in_review: "In review", approved: "Approved", denied: "Denied" };
  // Only ever shown under COI, and only once its status is "Waiting on VPO
  // Waiver" -- COI itself is never marked Waived (see the spec). Approving
  // the waiver here never flips COI's own status; that's still a separate,
  // deliberate action on the COI case itself.
  function renderVpoWaiverPanelHtml(latest) {
    const w = (latest && latest.vpoWaiver) || null;
    return `
      <div class="onboarding-vpo-waiver-panel">
        <div class="onboarding-vpo-waiver-heading">VPO Waiver</div>
        <select class="onboarding-vpo-waiver-reason">
          <option value="">Reason…</option>
          <option value="limits" ${w && w.reason === "limits" ? "selected" : ""}>Limits</option>
          <option value="missing_coverage" ${w && w.reason === "missing_coverage" ? "selected" : ""}>Missing Coverage</option>
          <option value="both" ${w && w.reason === "both" ? "selected" : ""}>Limits & Missing Coverage</option>
        </select>
        <input type="text" class="onboarding-vpo-waiver-case-number" placeholder="Waiver case # (optional)" value="${escapeHtml(w ? w.caseNumber || "" : "")}" />
        <select class="onboarding-vpo-waiver-status">
          ${VPO_WAIVER_STATUS_OPTIONS.map((s) => `<option value="${s}" ${w && w.status === s ? "selected" : ""}>${VPO_WAIVER_STATUS_LABELS[s]}</option>`).join("")}
        </select>
        <label class="onboarding-vpo-waiver-expiration-label">Expiration <input type="date" class="onboarding-vpo-waiver-expiration" value="${w && w.expirationDate ? w.expirationDate.slice(0, 10) : ""}" /></label>
        <textarea class="onboarding-vpo-waiver-notes" placeholder="Waiver notes (optional)">${escapeHtml(w ? w.notes || "" : "")}</textarea>
        <button type="button" class="btn btn-secondary onboarding-vpo-waiver-save">Save Waiver</button>
        ${w ? `<span class="wom-desc">Waiver: ${escapeHtml(vpoWaiverReasonLabel(w.reason))} — <span class="badge badge-${caseStatusBadgeClass(w.status === "approved" ? "Approved" : w.status === "denied" ? "Denied" : "")}">${VPO_WAIVER_STATUS_LABELS[w.status]}</span></span>` : ""}
      </div>
    `;
  }
  function renderCasePillHtml(v, ct, latest) {
    const coiRef = ct.key === "coi" ? coiRequirementLine(v) : "";
    const formStatus = v[FORM_STATUS_KEY_BY_CASE_KEY[ct.key]] || "not_requested";
    const isW9 = ct.key === "w9";
    const statusOptions = caseStatusOptionsFor(ct.key);
    const currentStatus = latest ? latest.status || "" : "";
    return `
      <div class="onboarding-case" data-case-key="${ct.key}">
        <div class="onboarding-case-header">
          <span class="onboarding-case-label">${escapeHtml(ct.label)}</span>
          <span class="onboarding-case-type-tag">Individual document case</span>
        </div>
        ${coiRef ? `<div class="onboarding-case-coi-ref">${escapeHtml(coiRef)}</div>` : ""}
        <div class="onboarding-case-grid">
          <label class="onboarding-field">
            Form status
            <select class="onboarding-form-status-select">
              ${FORM_STATUS_OPTIONS.map((s) => `<option value="${s}" ${formStatus === s ? "selected" : ""}>${FORM_STATUS_LABELS[s]}</option>`).join("")}
            </select>
          </label>
          <label class="onboarding-field">
            Case number
            <input type="text" class="onboarding-case-ref-input" placeholder="Case number" value="${escapeHtml(latest ? latest.referenceNumber || "" : "")}" />
          </label>
          <label class="onboarding-field">
            Case status
            <select class="onboarding-case-status-select">
              ${statusOptions
                .map((s) => `<option value="${s}" ${currentStatus ? (currentStatus === s ? "selected" : "") : s === statusOptions[0] ? "selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </label>
          <label class="onboarding-field">
            Expiration date
            <input type="date" class="onboarding-case-expiration-input" value="${latest && latest.expirationDate ? latest.expirationDate.slice(0, 10) : ""}" />
          </label>
        </div>
        ${
          isW9
            ? `
          <label class="onboarding-w9-prev-approved-label">
            <input type="checkbox" class="onboarding-w9-prev-approved-checkbox" ${latest && latest.w9PreviouslyApproved ? "checked" : ""} />
            Previously approved in ServiceEdge
          </label>
          <div class="onboarding-case-w9-grid">
            <label class="onboarding-field">
              Name on W-9
              <input type="text" class="onboarding-w9-name-input" placeholder="Enter name exactly as shown on the form" value="${escapeHtml(latest ? latest.w9Name || "" : "")}" />
            </label>
            <label class="onboarding-field">
              Address on W-9
              <input type="text" class="onboarding-w9-address-input" placeholder="Street, city, state, ZIP" value="${escapeHtml(latest ? latest.w9Address || "" : "")}" />
            </label>
          </div>
        `
            : ""
        }
        ${renderReviewNotesChecklistHtml(ct, latest)}
        <label class="onboarding-field onboarding-case-notes-field">
          Document-case notes
          <textarea class="onboarding-case-note-input" placeholder="Additional notes for ${escapeHtml(ct.label)}">${latest ? escapeHtml(latest.note || "") : ""}</textarea>
        </label>
        ${ct.key === "coi" && currentStatus.trim() === COI_ONLY_STATUS ? renderVpoWaiverPanelHtml(latest) : ""}
      </div>
    `;
  }

  // Shared between the Onboarding board's rows and the vendor profile's own
  // Cases section -- both render the same case-pill markup
  // (renderCasePillHtml) and wire the same autosave behavior. Every field
  // is always visible and editable (no separate "Log update"/"Edit"
  // toggle); a case-status/form-status/checkbox change saves immediately,
  // a text field saves on blur (and silently in the background while
  // typing, debounced, so the row never re-renders out from under an
  // active keystroke -- see persist() vs persistAndRefresh() below). The
  // first save for a case that doesn't exist yet POSTs (creates it);
  // every save after that PATCHes the same row in place.
  function wireCasePill(caseEl, v, ct, onLogged, latest) {
    let editingId = latest ? latest.id : null;
    let saveTimer = null;

    const statusSelect = caseEl.querySelector(".onboarding-case-status-select");
    const refInput = caseEl.querySelector(".onboarding-case-ref-input");
    const noteInput = caseEl.querySelector(".onboarding-case-note-input");
    const expirationInput = caseEl.querySelector(".onboarding-case-expiration-input");
    const w9NameInput = caseEl.querySelector(".onboarding-w9-name-input");
    const w9AddressInput = caseEl.querySelector(".onboarding-w9-address-input");
    const w9PrevApprovedCheckbox = caseEl.querySelector(".onboarding-w9-prev-approved-checkbox");
    const reviewNotesDetails = caseEl.querySelector(".onboarding-review-notes-details");
    const reviewNotesSummary = caseEl.querySelector(".onboarding-review-notes-summary");

    function buildPayload() {
      const payload = {
        requestType: ct.type,
        status: statusSelect.value,
        referenceNumber: refInput.value.trim(),
        note: noteInput.value.trim(),
        expirationDate: expirationInput.value || null,
        reviewNotesSelected: reviewNotesDetails
          ? [...reviewNotesDetails.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value)
          : [],
      };
      if (ct.key === "w9") {
        payload.w9Name = w9NameInput.value.trim();
        payload.w9Address = w9AddressInput.value.trim();
        payload.w9PreviouslyApproved = w9PrevApprovedCheckbox.checked;
      }
      return payload;
    }

    async function persist() {
      const payload = buildPayload();
      try {
        if (editingId) {
          await api.patch(`/api/admin/vendors/${v.id}/requests/${editingId}`, payload);
        } else {
          const result = await api.post(`/api/admin/vendors/${v.id}/requests`, payload);
          editingId = result[0] ? result[0].id : null;
        }
      } catch (err) {
        window.alert(err.message);
      }
    }
    async function persistAndRefresh() {
      await persist();
      await refreshVendorFields(v);
      await onLogged();
    }
    function debouncedPersist() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 700);
    }
    function flushAndRefresh() {
      clearTimeout(saveTimer);
      persistAndRefresh();
    }

    statusSelect.addEventListener("change", flushAndRefresh);
    expirationInput.addEventListener("change", flushAndRefresh);
    if (w9PrevApprovedCheckbox) w9PrevApprovedCheckbox.addEventListener("change", flushAndRefresh);
    [refInput, noteInput, w9NameInput, w9AddressInput].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", debouncedPersist);
      input.addEventListener("blur", flushAndRefresh);
    });
    if (reviewNotesDetails) {
      reviewNotesDetails.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener("change", () => {
          const options = REVIEW_NOTES_OPTIONS[ct.key] || [];
          const checked = [...reviewNotesDetails.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
          const labels = options.filter((o) => checked.includes(o.key)).map((o) => o.label);
          reviewNotesSummary.textContent = labels.length ? labels.join(", ") : "Review notes · select issues";
          flushAndRefresh();
        });
      });
    }

    const formStatusSelect = caseEl.querySelector(".onboarding-form-status-select");
    if (formStatusSelect) {
      formStatusSelect.addEventListener("change", async () => {
        formStatusSelect.disabled = true;
        try {
          const updated = await api.patch(`/api/admin/vendors/${v.id}/form-status`, { caseKey: ct.key, formStatus: formStatusSelect.value });
          Object.assign(v, updated);
          invalidateVendorsCache();
          await onLogged();
        } catch (err) {
          window.alert(err.message);
          formStatusSelect.disabled = false;
        }
      });
    }

    const vpoWaiverSaveBtn = caseEl.querySelector(".onboarding-vpo-waiver-save");
    if (vpoWaiverSaveBtn && latest) {
      vpoWaiverSaveBtn.addEventListener("click", async () => {
        const reason = caseEl.querySelector(".onboarding-vpo-waiver-reason").value;
        const caseNumber = caseEl.querySelector(".onboarding-vpo-waiver-case-number").value.trim();
        const status = caseEl.querySelector(".onboarding-vpo-waiver-status").value;
        const expirationDate = caseEl.querySelector(".onboarding-vpo-waiver-expiration").value || null;
        const notes = caseEl.querySelector(".onboarding-vpo-waiver-notes").value.trim();
        try {
          await api.patch(`/api/admin/vendors/${v.id}/requests/${latest.id}/vpo-waiver`, { reason, caseNumber, status, expirationDate, notes });
          invalidateVendorsCache();
          await onLogged();
        } catch (err) {
          window.alert(err.message);
        }
      });
    }
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
    const caseSummary = caseSummaryFromEntries(entries);
    host.innerHTML = `
      ${renderWelcomeEmailLine(v)}
      ${renderParentCaseHtml(v, caseSummary)}
      <div class="onboarding-cases-heading">
        Forms &amp; individual cases
        ${renderApprovalBadgeHtml(v, caseSummary)}
      </div>
      <div class="onboarding-cases">
        ${ONBOARDING_CASE_TYPES.map((ct) => renderCasePillHtml(v, ct, caseSummary[ct.key])).join("")}
      </div>
      <button type="button" class="btn btn-link vendor-case-history-toggle">Full case history</button>
      <div class="onboarding-case-log" hidden></div>
    `;
    wireWelcomeEmailLine(host, v, () => renderVendorCasesSection(host, v));
    wireParentCase(host, v, () => renderVendorCasesSection(host, v));
    ONBOARDING_CASE_TYPES.forEach((ct) => {
      const caseEl = host.querySelector(`.onboarding-case[data-case-key="${ct.key}"]`);
      wireCasePill(caseEl, v, ct, () => renderVendorCasesSection(host, v), caseSummary[ct.key]);
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
            Starts this vendor as In Progress on the Onboarding tab automatically, with all 4 document
            cases (COI, W-9, Payment, Blank Invoice) not yet started.
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
    { value: "blank_invoice", label: "Blank Invoice Template" },
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
            <div><dt>Used in territory</dt><dd class="vendor-territories">Loading&hellip;</dd></div>
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
    const territoriesEl = host.querySelector(".vendor-territories");

    async function refreshTerritories() {
      let territories;
      try {
        territories = await api.get(`/api/admin/vendors/${v.id}/territories`);
      } catch (err) {
        territoriesEl.textContent = "Unable to load";
        return;
      }
      territoriesEl.textContent = territories.length === 0 ? "None on file" : territories.join(", ");
    }

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

    await refreshTerritories();
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
    const expiredCategories = v.expiredComplianceCategories || [];
    const expiredLabels = expiredCategories.map(
      (c) => (VENDOR_DOC_CATEGORIES.find((cat) => cat.value === c) || {}).label || c
    );
    host.innerHTML = `
      ${
        expiredCategories.length > 0
          ? `<div class="vendor-expired-docs-banner">
               <span>${escapeHtml(expiredLabels.join(", "))} expired on file.</span>
               <button type="button" class="btn btn-secondary danger-link vendor-notify-expired-btn" ${v.email ? "" : "disabled title=\"No email on file for this vendor\""}>Notify vendor</button>
             </div>`
          : ""
      }
      <div class="vendor-documents-panel"></div><div class="vendor-assign-task-doc-host"></div>
    `;
    const notifyBtn = host.querySelector(".vendor-notify-expired-btn");
    if (notifyBtn) {
      notifyBtn.addEventListener("click", async () => {
        notifyBtn.disabled = true;
        try {
          const result = await api.post(`/api/admin/vendors/${v.id}/notify-expired-docs`, {});
          window.alert(result.sent ? `Notification sent to ${v.email}.` : `Logged, but not actually delivered -- email isn't configured on this server.`);
        } catch (err) {
          window.alert(err.message);
        } finally {
          notifyBtn.disabled = false;
        }
      });
    }
    const documentsPanel = host.querySelector(".vendor-documents-panel");
    // A VPO waiver is only needed when the vendor's COI falls short of the
    // standard required limits or language requirements -- it's the sign-off
    // on that exception, not a blanket requirement every vendor needs.
    const requiredCategories = ["coi", "w9", "ach", "blank_invoice"];
    if (!v.coiMeetsRequiredLimits || !v.coiMeetsLanguageRequirements) requiredCategories.push("vpo_waiver");
    const refreshDocumentsPanel = () =>
      renderAttachments(documentsPanel, {
        title: "Vendor Documents",
        relatedType: "vendor",
        relatedId: v.id,
        categories: VENDOR_DOC_CATEGORIES,
        canUpload: true,
        trackExpiration: true,
        requiredCategories,
        emptyText: "No documents on file yet.",
      });
    await refreshDocumentsPanel();
    await renderAssignTaskDocumentControl(host.querySelector(".vendor-assign-task-doc-host"), v, refreshDocumentsPanel);
  }

  async function renderVendorCostsTab(host, v) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let woms, pos, poGlRollup;
    try {
      [woms, pos, poGlRollup] = await Promise.all([
        api.get("/api/woms").then((all) => all.filter((w) => w.vendorId === v.id)),
        // Only Active POs ever surface here -- a Needs Organization record
        // is only visible through the POs tab itself until it's moved to
        // Active, same rule as Task Manager.
        api.get(`/api/admin/pos?${new URLSearchParams({ vendorId: v.id, lifecycleStatus: "active" })}`),
        api.get(`/api/admin/vendors/${v.id}/po-gl-rollup`),
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
      <h4>PO vs. GL Rollup</h4>
      <p class="review-checklist-hint">
        PO Open is each Active PO's amount still outstanding (not yet matched to a GL posting); GL Applied is
        what's actually posted so far against any PO ever tied to this vendor. The two are never double-counted
        against each other -- see Spend Analysis's own "current estimated PO" checkbox for the same calculation.
      </p>
      <div class="task-tiles">
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(poGlRollup.poOpenTotal)}</div><div class="task-tile-label">PO Open (${poGlRollup.poOpenCount} PO${poGlRollup.poOpenCount === 1 ? "" : "s"})</div></div>
        <div class="task-tile"><div class="task-tile-count">$${formatMoney(poGlRollup.glAppliedTotal)}</div><div class="task-tile-label">Applied on GL (${poGlRollup.glAppliedPoCount} PO${poGlRollup.glAppliedPoCount === 1 ? "" : "s"})</div></div>
      </div>
      <p class="review-checklist-hint">See Financials &rarr; Overview for the full cross-vendor cost breakdown.</p>
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
        <div class="review-row wom-vendor-cost-row" data-code="${escapeHtml(w.code)}">
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.description)} <span class="wom-code">${escapeHtml(w.code)}</span></span>
            <span class="badge badge-${womStatusBadgeClass(w.status)}">${escapeHtml(WOM_STATUS_LABELS[w.status] || w.status)}</span>
          </div>
          <div class="wom-desc">Est. $${formatMoney(w.estimatedPrice)} / Applied $${formatMoney(w.appliedPrice)}</div>
        </div>`
        )
        .join("");
      list.querySelectorAll(".wom-vendor-cost-row").forEach((row) => {
        row.addEventListener("click", () => openWomProfile(row.dataset.code));
      });
    }
    const poList = host.querySelector("#vendor-cost-po-list");
    if (pos.length === 0) {
      poList.innerHTML = `<p class="empty-note">No active Budget POs linked to this vendor yet.</p>`;
    } else {
      poList.innerHTML = pos
        .map(
          (p) => `
        <div class="review-row po-vendor-cost-row" data-id="${p.id}">
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(p.description || "PO record")} ${p.poNumber ? `<span class="wom-code">PO ${escapeHtml(p.poNumber)}</span>` : ""}</span>
            <span class="badge badge-draft">${escapeHtml(p.status || "—")}</span>
          </div>
          <div class="wom-desc">$${formatMoney(p.poAmount || 0)} &mdash; ${escapeHtml(p.locationName || "Unclassified")}</div>
        </div>`
        )
        .join("");
      poList.querySelectorAll(".po-vendor-cost-row").forEach((row) => {
        row.addEventListener("click", () => openPoProfile(Number(row.dataset.id)));
      });
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
    const [techs, locations] = await Promise.all([api.get("/api/admin/technicians"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const territory = getTerritory();
    const selectable = techs.filter(
      (t) =>
        t.employmentStatus === "active" &&
        (!territory || ((locationByCode[t.homeLocationCode] || {}).territory || "Midwest") === territory)
    );
    if (!allocTechId || !selectable.some((t) => t.id === allocTechId)) allocTechId = selectable.length > 0 ? selectable[0].id : null;

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

  // One shared fetch behind both the tab's own badge count and the topbar
  // notification bell, so the two never drift out of sync by each hitting
  // these 9 endpoints separately with slightly different logic.
  async function fetchPriorityRaw() {
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
    return { expiringForms, vendors, weekendAddenda, reportGaps, missingUkg, woms, purelyhrUnverified, punchIssues, taskSummary };
  }

  // The tab's own badge count -- a small number next to its label, not a
  // banner anywhere else. Never blocks the tab bar itself if one of these
  // calls fails.
  async function computePriorityCount() {
    try {
      const raw = await fetchPriorityRaw();
      const outdatedVendorCount = raw.vendors.filter((v) => v.formsStatus === "outdated").length;
      const smartsheetGapCount = raw.woms.filter((w) => w.status === "closed" && !w.smartsheetReflectedAt).length;
      // Vendor document-check completeness and pending WOM requests are both
      // deliberately left out of this badge: against a real Smartsheet
      // sync, "not yet sent to Toyota" (or "not yet checked", for vendors)
      // starts out true for a large ongoing backlog, not a handful of new
      // items -- counting either here would make the badge reflect backlog
      // size instead of "a few things to look at." Both still show up in
      // full in their own section below, to work through at whatever pace
      // makes sense (see Today's focus).
      return (
        raw.expiringForms.length +
        outdatedVendorCount +
        raw.weekendAddenda.length +
        raw.reportGaps.length +
        raw.missingUkg.length +
        smartsheetGapCount +
        raw.purelyhrUnverified.length +
        raw.punchIssues.length +
        raw.taskSummary.overdue +
        raw.taskSummary.exceptions
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
        applyPriorityNavigation(btn.dataset);
        await draw();
      });
    });
  }

  // The "View" jump-to-record logic for a Priorities item -- factored out so
  // the topbar notification bell (a condensed view of the same items) can
  // reuse the exact same navigation instead of a second, divergable copy.
  function applyPriorityNavigation({ kind, tech, week, month, vendor, wom }) {
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
      womProfileCode = wom;
      womProfileTab = "overview";
      activeTab = "woms";
    } else if (kind === "report-gap") {
      laborReportMonth = month;
      activeTab = "laborreports";
    } else if (kind === "purelyhr") {
      state.weekMonday = week;
      expanded.add(tech);
      activeTab = "review";
    }
  }

  // The same 8-endpoint aggregation computePriorityCount/drawPriorities use,
  // but returning actual items (not just a count) for the topbar
  // notification bell's dropdown -- fetched fresh only when the bell is
  // opened, not on every page draw.
  async function computeBellItems() {
    const { expiringForms, vendors, weekendAddenda, reportGaps, missingUkg, woms, purelyhrUnverified, punchIssues } = await fetchPriorityRaw();
    const outdatedVendors = vendors.filter((v) => v.formsStatus === "outdated");
    const pendingWoms = woms.filter((w) => w.status === "pending");
    const todayIso = new Date().toISOString().slice(0, 10);

    return [
      ...outdatedVendors.map((v) => ({ section: "Vendor forms outdated", label: v.name, detail: "Forms outdated", kind: "vendor" })),
      ...expiringForms.map((f) => ({
        section: "Employee forms needing attention",
        label: f.techName,
        detail: `${f.formType || f.originalName} — ${f.expiresAt < todayIso ? "expired" : "expires"} ${f.expiresAt}`,
        kind: "tech-forms",
        tech: f.techId,
      })),
      ...missingUkg.map((m) => ({
        section: "Missing UKG hours",
        label: m.techName,
        detail: `week of ${m.weekMonday}`,
        kind: "missing-ukg",
        tech: m.techId,
        week: m.weekMonday,
      })),
      ...weekendAddenda.map((a) => ({
        section: "Weekend hours needing review",
        label: a.techName,
        detail: `week of ${a.weekMonday}`,
        kind: "weekend",
        tech: a.techId,
        week: a.weekMonday,
      })),
      ...punchIssues.map((p) => ({
        section: "Punch issues",
        label: p.techName,
        detail: `${p.day}, week of ${p.weekMonday}`,
        kind: "punch-issue",
        tech: p.techId,
        week: p.weekMonday,
      })),
      ...reportGaps.map((m) => ({ section: "Months missing a report", label: monthLabel(m), detail: "No report saved", kind: "report-gap", month: m })),
      ...pendingWoms.map((w) => ({ section: "WOM requests not yet sent to Toyota", label: w.description, detail: w.code, kind: "wom-pending", wom: w.code })),
      ...purelyhrUnverified.map((w) => ({
        section: "Time off needing PurelyHR verification",
        label: w.techName,
        detail: `week of ${w.weekMonday}`,
        kind: "purelyhr",
        tech: w.techId,
        week: w.weekMonday,
      })),
    ];
  }

  // The topbar's search/territory/notifications group -- rendered once into
  // a host that survives tab switches (unlike #topbar-context, which each
  // tab's own draw() clears), since these apply across the whole app rather
  // than to whichever tab is active.
  function renderGlobalTopbarTools(host) {
    if (!host) return;
    host.innerHTML = `
      <div class="topbar-search" id="topbar-search">
        <span class="search-field-icon">&#128269;</span>
        <input type="search" class="topbar-search-input" placeholder="Search WOMs, vendors, POs..." autocomplete="off" />
        <div class="topbar-search-dropdown" hidden></div>
      </div>
      <label class="topbar-territory-field">
        <span class="search-field-icon">&#127760;</span>
        <select class="topbar-territory-select">
          <option value="">All territories</option>
          ${TERRITORIES.map((t) => `<option value="${escapeHtml(t)}" ${getTerritory() === t ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
        </select>
      </label>
      <div class="topbar-bell" id="topbar-bell">
        <button type="button" class="topbar-bell-btn" aria-label="Notifications">
          &#128276;
          <span class="topbar-bell-badge" hidden></span>
        </button>
        <div class="topbar-bell-dropdown" hidden></div>
      </div>
    `;

    const searchInput = host.querySelector(".topbar-search-input");
    const searchDropdown = host.querySelector(".topbar-search-dropdown");
    let searchDebounce = null;
    let searchGeneration = 0;

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim();
      clearTimeout(searchDebounce);
      if (q.length < 2) {
        searchDropdown.hidden = true;
        searchDropdown.innerHTML = "";
        return;
      }
      searchDebounce = setTimeout(() => runSearch(q), 250);
    });
    searchInput.addEventListener("focus", () => {
      if (searchDropdown.innerHTML) searchDropdown.hidden = false;
    });

    async function runSearch(q) {
      const myGeneration = ++searchGeneration;
      let results;
      try {
        results = await api.get(`/api/admin/search?q=${encodeURIComponent(q)}`);
      } catch {
        return;
      }
      if (myGeneration !== searchGeneration) return;
      renderSearchResults(results);
    }

    function searchGroup(title, rows) {
      if (rows.length === 0) return "";
      return `
        <div class="topbar-search-group">
          <div class="topbar-search-group-title">${escapeHtml(title)}</div>
          ${rows.join("")}
        </div>
      `;
    }

    function renderSearchResults(results) {
      const groups = [
        searchGroup(
          "WOM Projects",
          results.woms.map(
            (w) => `
              <button type="button" class="topbar-search-result" data-kind="wom" data-code="${escapeHtml(w.code)}">
                <span class="topbar-search-result-label">${escapeHtml(w.description || w.code)}</span>
                <span class="topbar-search-result-sub">WOM ${escapeHtml(w.code)}${w.locationName ? ` &middot; ${escapeHtml(w.locationName)}` : ""}</span>
              </button>
            `
          )
        ),
        searchGroup(
          "Vendors",
          results.vendors.map(
            (v) => `
              <button type="button" class="topbar-search-result" data-kind="vendor" data-id="${v.id}">
                <span class="topbar-search-result-label">${escapeHtml(v.name)}</span>
              </button>
            `
          )
        ),
        searchGroup(
          "POs",
          results.pos.map(
            (p) => `
              <button type="button" class="topbar-search-result" data-kind="po" data-id="${p.id}">
                <span class="topbar-search-result-label">PO ${escapeHtml(p.poNumber || "—")} -- ${escapeHtml(p.vendorName || "Unassigned vendor")}</span>
                <span class="topbar-search-result-sub">${escapeHtml(p.description || "")}</span>
              </button>
            `
          )
        ),
      ].filter(Boolean);

      searchDropdown.innerHTML = groups.length ? groups.join("") : `<p class="empty-note">No matches.</p>`;
      searchDropdown.hidden = false;

      searchDropdown.querySelectorAll(".topbar-search-result").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const { kind, code, id } = btn.dataset;
          searchInput.value = "";
          searchDropdown.hidden = true;
          searchDropdown.innerHTML = "";
          if (kind === "wom") openWomProfile(code);
          else if (kind === "vendor") openVendorProfile(Number(id));
          else if (kind === "po") openPoProfile(Number(id));
          await draw();
        });
      });
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#topbar-search")) searchDropdown.hidden = true;
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") searchDropdown.hidden = true;
    });

    host.querySelector(".topbar-territory-select").addEventListener("change", (e) => {
      setTerritory(e.target.value);
    });

    const bellBtn = host.querySelector(".topbar-bell-btn");
    const bellDropdown = host.querySelector(".topbar-bell-dropdown");
    bellBtn.addEventListener("click", async () => {
      const opening = bellDropdown.hidden;
      bellDropdown.hidden = !opening;
      if (opening) await loadBellDropdown();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#topbar-bell")) bellDropdown.hidden = true;
    });

    async function loadBellDropdown() {
      bellDropdown.innerHTML = `<p class="empty-note">Loading…</p>`;
      let items;
      try {
        items = await computeBellItems();
      } catch (err) {
        bellDropdown.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      const shown = items.slice(0, 8);
      bellDropdown.innerHTML = `
        <div class="topbar-bell-title">Notifications</div>
        ${
          shown.length === 0
            ? `<p class="empty-note">Nothing needs attention right now.</p>`
            : shown
                .map(
                  (item, i) => `
                  <button type="button" class="topbar-bell-item" data-index="${i}">
                    <span class="topbar-bell-item-section">${escapeHtml(item.section)}</span>
                    <span class="topbar-bell-item-label">${escapeHtml(item.label)}</span>
                    <span class="topbar-bell-item-detail">${escapeHtml(item.detail)}</span>
                  </button>
                `
                )
                .join("")
        }
        ${items.length > 0 ? `<button type="button" class="btn btn-link topbar-bell-viewall">View all ${items.length} in Priorities</button>` : ""}
      `;
      bellDropdown.querySelectorAll(".topbar-bell-item").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const item = shown[Number(btn.dataset.index)];
          bellDropdown.hidden = true;
          applyPriorityNavigation(item);
          await draw();
        });
      });
      const viewAll = bellDropdown.querySelector(".topbar-bell-viewall");
      if (viewAll) {
        viewAll.addEventListener("click", async () => {
          bellDropdown.hidden = true;
          activeTab = "checklist";
          await draw();
        });
      }
    }

    // Any list currently on screen (WOM Projects, Locations, Budget PO
    // Tracker, Financials) re-filters itself by territory on its own next
    // draw -- a territory change just needs to trigger that redraw.
    onTerritoryChange(() => draw());
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
    const [allRows, locations, expiringForms, otTrends, vendors, weekendAddenda] = await Promise.all([
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
    const territory = getTerritory();
    const rows = territory
      ? allRows.filter((r) => ((locationByCode[r.technician.homeLocationCode] || {}).territory || "Midwest") === territory)
      : allRows;

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
        ${territory ? ` Showing <strong>${escapeHtml(territory)}</strong> only.` : ""}
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
    const [allRows, locations, woms] = await Promise.all([
      api.get(`/api/admin/weeks/${state.weekMonday}`),
      api.get("/api/locations"),
      api.get("/api/woms"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const womByCode = Object.fromEntries(woms.map((w) => [w.code, w]));
    const territory = getTerritory();
    const rows = territory
      ? allRows.filter((r) => ((locationByCode[r.technician.homeLocationCode] || {}).territory || "Midwest") === territory)
      : allRows;

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
        ${territory ? ` Showing <strong>${escapeHtml(territory)}</strong> only.` : ""}
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

  // The JDE accounting code a day's hours actually post to. E&F time is a
  // location's E&F Job Number + the standard E&F subsidiary code. WOM time
  // is location.subsidiary.WOM# -- the WOM's own location's WOM Job Number,
  // that WOM's own subsidiary code, and the WOM # itself, so the code alone
  // identifies which WOM it's for. "?" wherever a piece hasn't been entered
  // yet, so a missing code is obvious rather than silently blank. Returns
  // the gap reason too (null when there isn't one) so callers can explain
  // the "?" instead of leaving it looking like a bug -- see accountingCodeCell.
  function accountingCode(a, locationByCode, womByCode) {
    if (a.type === "timeoff") return { text: "—", gap: null };
    if (a.type === "wom") {
      const wom = womByCode[a.womCode];
      const loc = wom ? locationByCode[wom.locationCode] : null;
      const jobNumber = loc && loc.womJobNumber;
      const subsidiary = wom && wom.subsidiaryCode;
      let gap = null;
      if (!wom) gap = `WOM ${a.womCode} not found.`;
      else if (!loc) gap = `WOM ${a.womCode} has no location on file -- set one on its WOM profile.`;
      else if (!jobNumber) gap = `${loc.name} has no WOM Job Number on file -- add it on the Locations page.`;
      else if (!subsidiary) gap = `WOM ${a.womCode} has no subsidiary code on file -- set one on its WOM profile.`;
      return { text: `${jobNumber || "?"}.${subsidiary || "?"}.${a.womCode}`, gap };
    }
    const loc = locationByCode[a.locationCode];
    const gap = !loc
      ? `Location ${a.locationCode} not found.`
      : !loc.efJobNumber
        ? `${loc.name} has no E&F Contract Job Number on file -- add it on the Locations page.`
        : null;
    return { text: `${(loc && loc.efJobNumber) || "?"}.${(loc && loc.efSubsidiaryCode) || "20920000"}`, gap };
  }

  function accountingCodeCell(a, locationByCode, womByCode) {
    const { text, gap } = accountingCode(a, locationByCode, womByCode);
    return `<td${gap ? ` class="accounting-code-gap" title="${escapeHtml(gap)}"` : ""}>${escapeHtml(text)}</td>`;
  }

  function renderDetailTable(detail, locationByCode, womByCode) {
    if (detail.allocations.length === 0) {
      return `<p class="empty-note">No hours allocated.</p>`;
    }
    const rows = detail.allocations
      .map(
        (a) =>
          `<tr><td>${a.day}</td><td>${escapeHtml(describeAllocation(a, locationByCode))}</td>${accountingCodeCell(a, locationByCode, womByCode)}<td>${a.hours}h</td></tr>`
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
              ${accountingCodeCell(a, locationByCode, womByCode)}
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
                          ${accountingCodeCell(a, locationByCode, womByCode)}
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
    const territory = getTerritory();
    const filtered = territory ? locations.filter((l) => (l.territory || "Midwest") === territory) : locations;

    content.innerHTML = `
      <div class="review-actions">
        <h3 style="margin: 0;">Locations</h3>
        <button type="button" class="btn btn-primary" id="add-location-btn">Add location</button>
        <button type="button" class="btn btn-outline" id="import-coa-btn">Import Chart of Accounts</button>
      </div>
      <p class="review-checklist-hint">
        Each location has its own E&amp;F Contract Job Number and WOM Job Number (from the JDE lookup). E&amp;F time
        always uses the standard subsidiary code <strong>${escapeHtml(efSubsidiary)}</strong> at every location —
        that part never changes location to location; WOM subsidiary codes vary by project and are set on each WOM
        (WOM tab). Region is used to match this location up against the monthly labor report.
        ${territory ? ` Showing <strong>${escapeHtml(territory)}</strong> only -- change the territory filter in the top bar to see others.` : ""}
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

    content.querySelector("#add-location-btn").addEventListener("click", () => {
      openAddLocationModal(content);
    });
    content.querySelector("#import-coa-btn").addEventListener("click", () => {
      openCoaImportModal(content);
    });
  }

  // Backfills E&F Contract Job Number / WOM Job Number on existing locations
  // from Toyota's own Chart of Accounts export -- preview first, matched by
  // location name, never creating a location on its own. Mirrors the PO
  // Tracker import's own upload-then-preview-then-confirm shape.
  function openCoaImportModal(content) {
    const { body, close } = openModal({
      title: "Import Chart of Accounts",
      size: "large",
      bodyHtml: `
        <p class="review-checklist-hint">
          Reads the Job Numbers sheet and backfills each matching location's E&amp;F Contract Job Number, WOM Job
          Number, PPS Contract Job Number, and region. Matched by location name -- a sheet row with no matching
          location is listed, not updated.
        </p>
        <input type="file" class="coa-import-file" accept=".xlsx,.xls" />
        <label class="coa-import-create-toggle">
          <input type="checkbox" class="coa-import-create-unmatched" checked />
          Also create a new location for every Chart of Accounts row that doesn't match an existing one
        </label>
        <div class="coa-import-result"></div>
      `,
    });

    let currentFile = null;
    const createToggle = body.querySelector(".coa-import-create-unmatched");

    body.querySelector(".coa-import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      currentFile = file;
      await runCoaPreview();
    });
    createToggle.addEventListener("change", () => {
      if (currentFile) runCoaPreview();
    });

    async function runCoaPreview() {
      const resultEl = body.querySelector(".coa-import-result");
      resultEl.innerHTML = `<p class="empty-note">Reading file…</p>`;
      let preview;
      try {
        preview = await api.uploadRawFile("/api/locations/import-coa", currentFile, {
          dryRun: "true",
          createUnmatched: createToggle.checked ? "true" : "false",
        });
      } catch (err) {
        resultEl.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      const changedRows = preview.results.filter((r) => r.matched && r.changed);
      const unmatchedRows = preview.results.filter((r) => !r.matched);
      const fieldDiff = (f) => (f.before !== f.after ? `${escapeHtml(f.before || "—")} &rarr; <strong>${escapeHtml(f.after || "—")}</strong>` : escapeHtml(f.after || "—"));
      resultEl.innerHTML = `
        <p class="review-checklist-hint">
          Read sheet <strong>${escapeHtml(preview.sheetName)}</strong> -- ${preview.totalRows} rows with a job number.
          ${preview.missingColumns.length ? `<br /><span class="attachments-error">Missing expected column(s): ${preview.missingColumns.map(escapeHtml).join(", ")}</span>` : ""}
        </p>
        <div class="task-tiles">
          <div class="task-tile"><div class="task-tile-count">${preview.matchedCount}</div><div class="task-tile-label">Matched locations</div></div>
          <div class="task-tile"><div class="task-tile-count">${preview.changedCount}</div><div class="task-tile-label">Would update</div></div>
          <div class="task-tile"><div class="task-tile-count">${preview.unmatchedCount}</div><div class="task-tile-label">No matching location</div></div>
          ${createToggle.checked ? `<div class="task-tile"><div class="task-tile-count">${preview.createdCount}</div><div class="task-tile-label">Would create</div></div>` : ""}
        </div>
        ${
          changedRows.length > 0
            ? `<table class="detail-table">
                <thead><tr><th>Location</th><th>E&amp;F Job #</th><th>WOM Job #</th><th>PPS Job #</th><th>Region</th><th>Territory</th></tr></thead>
                <tbody>
                  ${changedRows
                    .map(
                      (r) => `<tr>
                        <td>${escapeHtml(r.locationName)}</td>
                        <td>${fieldDiff(r.efJobNumber)}</td>
                        <td>${fieldDiff(r.womJobNumber)}</td>
                        <td>${fieldDiff(r.ppsJobNumber)}</td>
                        <td>${fieldDiff(r.region)}</td>
                        <td>${fieldDiff(r.territory)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<p class="empty-note">No location job numbers would change.</p>`
        }
        ${
          unmatchedRows.length > 0
            ? `<details class="coa-unmatched-details" open>
                <summary>${unmatchedRows.length} Chart of Accounts row(s) with no matching location</summary>
                <ul>${unmatchedRows
                  .map(
                    (r) =>
                      `<li>${escapeHtml(r.description)}${r.willCreate ? ` &mdash; <strong>will create as ${escapeHtml(r.locationCode)}</strong> (${escapeHtml(r.territory)})` : ""}</li>`
                  )
                  .join("")}</ul>
              </details>`
            : ""
        }
        <div class="modal-form-actions">
          <button type="button" class="btn btn-primary coa-import-confirm" ${changedRows.length === 0 && preview.createdCount === 0 ? "disabled" : ""}>
            Apply ${changedRows.length} update${changedRows.length === 1 ? "" : "s"}${createToggle.checked && preview.createdCount > 0 ? ` and create ${preview.createdCount} location${preview.createdCount === 1 ? "" : "s"}` : ""}
          </button>
          <button type="button" class="btn btn-secondary coa-import-cancel">Cancel</button>
        </div>
        <span class="save-message"></span>
      `;
      resultEl.querySelector(".coa-import-cancel").addEventListener("click", close);
      const confirmBtn = resultEl.querySelector(".coa-import-confirm");
      if (!confirmBtn.disabled) {
        confirmBtn.addEventListener("click", async () => {
          confirmBtn.disabled = true;
          try {
            await api.uploadRawFile("/api/locations/import-coa", currentFile, {
              dryRun: "false",
              createUnmatched: createToggle.checked ? "true" : "false",
            });
            close();
            await drawLocations(content);
          } catch (err) {
            resultEl.querySelector(".save-message").textContent = err.message;
            confirmBtn.disabled = false;
          }
        });
      }
    }
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
            <input name="ppsJobNumber" placeholder="PPS Contract Job Number" />
            <input name="region" placeholder="Region (e.g. Southeast)" />
            <select name="territory" required>
              <option value="" disabled selected>Select territory…</option>
              ${TERRITORIES.map((t) => `<option value="${t}">${t}</option>`).join("")}
            </select>
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
          ppsJobNumber: form.ppsJobNumber.value.trim() || null,
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
    if (womProfileCode) {
      const w = allWoms.find((x) => x.code === womProfileCode);
      if (w) {
        await renderWomProfile(content, w, locationByCode, locations);
        return;
      }
      womProfileCode = null;
    }
    const womTerritoryOf = (w) => (locationByCode[w.locationCode] && locationByCode[w.locationCode].territory) || "Midwest";
    const territory = getTerritory();
    const locationsInUse = [...new Set(allWoms.map((w) => w.locationCode).filter(Boolean))]
      .map((code) => locationByCode[code])
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-header-title">WOM Projects</h1>
          <p class="page-header-subtitle">
            Track project status, costs and requests.
            ${territory ? `Showing <strong>${escapeHtml(territory)}</strong> only.` : ""}
          </p>
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
      </div>

      <div class="pill-toggle-group">
        <button type="button" class="pill-toggle-btn ${womGroupFilter === "active" ? "active" : ""}" data-group="active">Active</button>
        <button type="button" class="pill-toggle-btn ${womGroupFilter === "closed" ? "active" : ""}" data-group="closed">Closed</button>
      </div>

      <div class="review-list" id="wom-list"></div>
    `;

    await renderSmartsheetPanel(content.querySelector("#smartsheet-panel"), content);

    const territoryFiltered = territory ? allWoms.filter((w) => womTerritoryOf(w) === territory) : allWoms;
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
  }

  // Re-filters and redraws just the WOM list (not the whole tab, which would
  // steal focus out of the search box on every keystroke).
  async function refreshWomList(content, locationByCode, locations) {
    const allWoms = await api.get("/api/woms");
    const womTerritoryOf = (w) => (locationByCode[w.locationCode] && locationByCode[w.locationCode].territory) || "Midwest";
    const territory = getTerritory();
    const territoryFiltered = territory ? allWoms.filter((w) => womTerritoryOf(w) === territory) : allWoms;
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
          <input name="ppsJobNumber" placeholder="PPS Contract Job Number" value="${escapeHtml(l.ppsJobNumber || "")}" />
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
            ppsJobNumber: form.ppsJobNumber.value.trim() || null,
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
    const ppsJobLabel = l.ppsJobNumber ? ` &middot; PPS Job # ${escapeHtml(l.ppsJobNumber)}` : "";
    const regionLabel = l.region ? ` &middot; ${escapeHtml(l.region)}` : "";
    const territoryLabel = ` &middot; <span class="badge badge-draft">${escapeHtml(l.territory || "Midwest")}</span>`;
    el.innerHTML = `
      <div class="review-row-summary">
        <div class="review-row-name">${escapeHtml(l.name)} <span class="wom-desc">${jobLabel}${womJobLabel}${ppsJobLabel}${regionLabel}</span>${territoryLabel}</div>
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

  const WOM_PROFILE_TABS = [
    { key: "overview", label: "Overview" },
    { key: "tasks", label: "Tasks" },
    { key: "vendorspos", label: "Vendors & POs" },
    { key: "financials", label: "Labor & Financials" },
    { key: "documents", label: "Documents" },
    { key: "activity", label: "Activity" },
  ];

  // The full WOM profile page -- consolidates what used to be split across
  // the "Open project" edit modal and the separate "Smartsheet detail" raw
  // dump into one place, same shell as the Vendor Directory's own profile
  // page (see renderVendorProfile). The old raw Smartsheet dump survives as
  // the "Source details" header action (openSmartsheetDetailModal) rather
  // than a tab of its own, since it's reference material, not a working view.
  // The dropdown's own detailed wording ("Requested from Toyota (no WOM #
  // yet)") is useful when choosing a status; the header chip just needs the
  // short name, so this drops any trailing parenthetical.
  function womStatusShortLabel(status) {
    return (WOM_STATUS_LABELS[status] || status).replace(/\s*\([^)]*\)\s*$/, "");
  }

  async function renderWomProfile(content, w, locationByCode, locations) {
    const loc = locationByCode[w.locationCode];
    content.innerHTML = `
      <button type="button" class="btn btn-link wom-profile-back-btn">&larr; WOM Projects</button>
      <div class="page-header">
        <div>
          <h1 class="page-header-title">${escapeHtml(w.description)}</h1>
          <p class="page-header-subtitle">
            <span class="chip chip-code">WOM ${escapeHtml(w.code)}</span>
            <span class="badge badge-${womStatusBadgeClass(w.status)}">${escapeHtml(womStatusShortLabel(w.status))}</span>
            ${loc ? `<span class="chip">&#128205; ${escapeHtml(loc.name)}</span>` : `<span class="chip chip-muted">No location on file</span>`}
            ${w.statusConflict ? `<span class="badge badge-rejected">Smartsheet says this is done -- app status disagrees</span>` : ""}
          </p>
        </div>
        <div class="page-header-actions-col">
          <div class="page-header-actions">
            <button type="button" class="btn btn-outline wom-profile-edit-btn">&#9998; Edit</button>
            <div class="row-menu">
              <button type="button" class="btn btn-outline row-menu-toggle" aria-label="More actions">&#8943;</button>
              <div class="row-menu-panel" hidden>
                <button type="button" class="row-menu-item row-menu-item-danger wom-profile-delete-btn">Delete</button>
              </div>
            </div>
          </div>
          ${w.smartsheetData ? `<a href="#" class="wom-profile-source-link">Source details &rarr;</a>` : ""}
        </div>
      </div>
      <div class="tabs wom-profile-tabs">
        ${WOM_PROFILE_TABS.map((t) => `<button class="tab ${womProfileTab === t.key ? "active" : ""}" data-tab="${t.key}" type="button">${t.label}</button>`).join("")}
      </div>
      <div class="wom-profile-body"></div>
    `;

    function backToList() {
      const returnTo = womProfileReturnTo;
      womProfileCode = null;
      womProfileReturnTo = null;
      if (returnTo) goTo(returnTo);
      else drawWoms(content);
    }
    content.querySelector(".wom-profile-back-btn").addEventListener("click", backToList);
    content.querySelector(".wom-profile-edit-btn").addEventListener("click", () => {
      openWomEditFormModal(w, content, locationByCode, locations);
    });
    const sourceLink = content.querySelector(".wom-profile-source-link");
    if (sourceLink) {
      sourceLink.addEventListener("click", (e) => {
        e.preventDefault();
        openSmartsheetDetailModal(w);
      });
    }
    const menuToggle = content.querySelector(".row-menu-toggle");
    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = content.querySelector(".row-menu-panel");
      const isHidden = panel.hasAttribute("hidden");
      content.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
      if (isHidden) panel.removeAttribute("hidden");
    });
    content.querySelector(".wom-profile-delete-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete "${w.description}" (${w.code})? This can't be undone.`)) return;
      try {
        await api.delete(`/api/woms/${encodeURIComponent(w.code)}`);
        backToList();
      } catch (err) {
        if (err.status === 409 && err.payload && err.payload.allocatedHours != null) {
          const forceConfirmed = window.confirm(
            `${err.payload.allocatedHours}h already allocated against ${w.code} on technician timesheets. Deleting it removes those hours too -- delete anyway?`
          );
          if (!forceConfirmed) return;
          try {
            await api.delete(`/api/woms/${encodeURIComponent(w.code)}`, { force: true });
            backToList();
          } catch (err2) {
            window.alert(`Could not delete ${w.code}: ${err2.message}`);
          }
        } else {
          window.alert(`Could not delete ${w.code}: ${err.message}`);
        }
      }
    });
    content.querySelectorAll(".wom-profile-tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        womProfileTab = btn.dataset.tab;
        renderWomProfile(content, w, locationByCode, locations);
      });
    });
    if (!content.dataset.rowMenuBound) {
      content.dataset.rowMenuBound = "1";
      content.addEventListener("click", (e) => {
        if (!e.target.closest(".row-menu")) {
          content.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
        }
      });
    }

    const body = content.querySelector(".wom-profile-body");
    if (womProfileTab === "documents") await renderWomDocumentsTab(body, w);
    else if (womProfileTab === "tasks") await renderWomTasksTab(body, w);
    else if (womProfileTab === "vendorspos") await renderWomVendorsPosTab(body, w);
    else if (womProfileTab === "financials") await renderWomFinancialsTab(body, w);
    else if (womProfileTab === "activity") await renderWomActivityTab(body, w);
    else await renderWomOverviewTab(body, w, content, locationByCode, locations);
  }

  // "Multiple vendors" with no new join table: the distinct set of vendors
  // found across every PO linked to this WOM (by wom_number), plus the WOM's
  // own primary vendor match -- always backed by real PO/vendor rows, never
  // a fabricated profile. An admin-name-style vendor string on a PO that
  // never resolved to a real vendor profile shows as "Needs matching" text,
  // same as the PO Tracker's own vendor column.
  async function renderWomVendorsPosTab(host, w) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let pos;
    try {
      pos = await api.get(`/api/admin/pos?${new URLSearchParams({ womNumber: w.code })}`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const vendorMap = new Map();
    if (w.vendorId) vendorMap.set(w.vendorId, w.vendorName || `Vendor #${w.vendorId}`);
    pos.forEach((p) => {
      if (p.vendorId) vendorMap.set(p.vendorId, p.vendorLinkedName || `Vendor #${p.vendorId}`);
    });
    const unmatchedVendorNames = [...new Set(pos.filter((p) => !p.vendorId && p.vendorName).map((p) => p.vendorName))];

    host.innerHTML = `
      <div class="vendor-overview-card">
        <h4>Vendors</h4>
        ${
          vendorMap.size === 0 && unmatchedVendorNames.length === 0
            ? `<p class="empty-note">No vendor linked to this WOM or its POs yet.</p>`
            : `<div class="wom-vendor-chips">
                ${[...vendorMap]
                  .map(
                    ([id, name]) => `
                  <button type="button" class="chip wom-vendor-chip" data-vendor-id="${id}">
                    ${escapeHtml(name)}${id === w.vendorId ? ` &middot; Primary` : ""}
                  </button>`
                  )
                  .join("")}
                ${unmatchedVendorNames
                  .map((name) => `<span class="chip chip-muted">${escapeHtml(name)} (needs matching)</span>`)
                  .join("")}
              </div>`
        }
      </div>
      <div class="vendor-overview-card">
        <h4>Budget POs (${pos.length})</h4>
        <div class="review-list wom-po-list"></div>
      </div>
    `;

    host.querySelectorAll(".wom-vendor-chip").forEach((btn) => {
      btn.addEventListener("click", () => openVendorProfile(Number(btn.dataset.vendorId)));
    });

    const poList = host.querySelector(".wom-po-list");
    if (pos.length === 0) {
      poList.innerHTML = `<p class="empty-note">No Budget POs linked to this WOM yet.</p>`;
    } else {
      poList.innerHTML = pos
        .map(
          (p) => `
        <div class="review-row wom-po-row" data-po-id="${p.id}">
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(p.description || "PO record")} ${p.poNumber ? `<span class="wom-code">PO ${escapeHtml(p.poNumber)}</span>` : ""}</span>
            <span class="badge badge-draft">${escapeHtml(p.status || "—")}</span>
          </div>
          <div class="wom-desc">$${formatMoney(p.poAmount || 0)} &mdash; ${escapeHtml(p.vendorLinkedName || p.vendorName || "No vendor")}</div>
        </div>`
        )
        .join("");
      poList.querySelectorAll(".wom-po-row").forEach((row) => {
        row.addEventListener("click", () => openPoProfile(Number(row.dataset.poId)));
      });
    }
  }

  // "Posted to GL" here is what's actually matched to a real GL transaction
  // against one of this WOM's linked POs -- distinct from the Smartsheet
  // tracker's own self-reported appliedPrice (shown on Overview), which can
  // lag or disagree with it. Reclass activity is the exact same read-only
  // section the old edit-everything modal used to show, just mounted here
  // instead (see loadWomReclassActivity).
  async function renderWomFinancialsTab(host, w) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let glLinks;
    try {
      glLinks = await api.get(`/api/woms/${encodeURIComponent(w.code)}/gl-links`);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const totalPosted = glLinks.reduce((sum, p) => sum + (p.actualPaid || 0), 0);

    host.innerHTML = `
      <div class="wom-stat-cards">
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128176;</span>
          <div><div class="wom-stat-label">Estimated cost</div><div class="wom-stat-value">${w.estimatedPrice != null ? `$${formatMoney(w.estimatedPrice)}` : "—"}</div></div>
        </div>
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128196;</span>
          <div><div class="wom-stat-label">Reported applied</div><div class="wom-stat-value">${w.appliedPrice != null ? `$${formatMoney(w.appliedPrice)}` : "Not reported"}</div></div>
        </div>
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128179;</span>
          <div><div class="wom-stat-label">Posted to GL</div><div class="wom-stat-value">$${formatMoney(totalPosted)}</div></div>
        </div>
      </div>
      ${w.budgetHours != null ? `<p class="review-checklist-hint">Hours: ${w.remainingHours}h remaining of ${w.budgetHours}h budgeted.</p>` : ""}
      <div class="vendor-overview-card">
        <h4>GL Postings by PO</h4>
        <p class="review-checklist-hint">What's actually hit the general ledger against this WOM's linked POs -- not the same figure as "Reported applied" above, which comes from the Smartsheet tracker and can lag or disagree.</p>
        ${
          glLinks.length === 0
            ? `<p class="empty-note">No GL postings found yet for any PO linked to this WOM.</p>`
            : glLinks
                .map(
                  (p) => `
          <table class="detail-table wom-gl-po-table">
            <thead>
              <tr><th colspan="6">PO ${escapeHtml(p.poNumber || "—")} &mdash; $${formatMoney(p.actualPaid)} posted</th></tr>
              <tr><th>Period</th><th>GL Date</th><th>Doc Type</th><th>Doc #</th><th>Object Acct</th><th>Amount</th></tr>
            </thead>
            <tbody>
              ${p.lines
                .map(
                  (l) => `<tr>
                <td>${l.periodNumber != null ? `P${l.periodNumber} FY${l.fiscalYear}` : "—"}</td>
                <td>${l.glDate ? new Date(l.glDate).toLocaleDateString() : "—"}</td>
                <td>${escapeHtml(l.documentType || "—")}</td>
                <td>${escapeHtml(l.documentNumber || "—")}</td>
                <td>${escapeHtml(l.objectAccount || "—")}</td>
                <td>$${formatMoney(l.amount)}</td>
              </tr>`
                )
                .join("")}
            </tbody>
          </table>`
                )
                .join("")
        }
      </div>
    `;

    await loadWomReclassActivity(host, w);
  }

  const WOM_TASK_STATUS_BADGE_CLASS = { completed: "approved", cancelled: "rejected", waiting: "warn" };

  // Reads/writes the exact same task rows Task Manager and (if vendor-linked)
  // that vendor's own Tasks tab use -- relatedWomCode is just another filter
  // on the one tasks table, not a copy. Lists via the WOM's own dedicated
  // /tasks route rather than the general GET /api/tasks, which defaults to
  // "my work" scoping and would silently hide an unassigned task. The vendor
  // picker is intentionally bounded to vendors this WOM already has a real
  // connection to (its own confirmed vendor, plus whoever's on its linked
  // POs) rather than a free search, so a task can't get linked to a vendor
  // with nothing to do with this WOM.
  async function renderWomTasksTab(host, w) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let tasks, pos;
    try {
      [tasks, pos] = await Promise.all([
        api.get(`/api/woms/${encodeURIComponent(w.code)}/tasks`),
        api.get(`/api/admin/pos?${new URLSearchParams({ womNumber: w.code })}`),
      ]);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const vendorOptions = new Map();
    if (w.vendorId) vendorOptions.set(w.vendorId, w.vendorName || `Vendor #${w.vendorId}`);
    pos.forEach((p) => {
      if (p.vendorId) vendorOptions.set(p.vendorId, p.vendorLinkedName || `Vendor #${p.vendorId}`);
    });

    host.innerHTML = `
      <div class="vendor-overview-card">
        <h4>Add a task</h4>
        <form class="wom-task-form">
          <input type="text" name="title" placeholder="Task title" required />
          <select name="relatedVendorId">
            <option value="">No vendor</option>
            ${[...vendorOptions].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("")}
          </select>
          <input type="date" name="dueAt" />
          <button type="submit" class="btn btn-secondary">Add task</button>
        </form>
      </div>
      <div class="wom-task-list"></div>
    `;

    const listHost = host.querySelector(".wom-task-list");
    function renderList() {
      listHost.innerHTML =
        tasks.length === 0
          ? `<p class="empty-note">No tasks linked to this WOM yet.</p>`
          : `<table class="detail-table">
              <thead><tr><th>Task</th><th>Vendor</th><th>Owner</th><th>Status</th><th>Due</th></tr></thead>
              <tbody>
                ${tasks
                  .map(
                    (t) => `<tr>
                  <td>${escapeHtml(t.title)}</td>
                  <td>${escapeHtml(t.relatedVendorName || "—")}</td>
                  <td>${escapeHtml(t.assignedToName || "Unassigned")}</td>
                  <td><span class="badge badge-${WOM_TASK_STATUS_BADGE_CLASS[t.status] || "draft"}">${escapeHtml(t.status)}</span></td>
                  <td>${t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}</td>
                </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`;
    }
    renderList();

    host.querySelector(".wom-task-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const title = form.title.value.trim();
      if (!title) return;
      const relatedVendorId = form.relatedVendorId.value || null;
      const dueAt = form.dueAt.value || null;
      const created = await api.post("/api/tasks", { title, relatedWomCode: w.code, relatedVendorId, dueAt });
      tasks = [created, ...tasks];
      renderList();
      form.reset();
    });
  }

  // What every past Smartsheet sync actually changed on this WOM, in its own
  // always-visible section -- not hidden behind a button inside the
  // Smartsheet Detail modal (see openSmartsheetDetailModal), so "why does
  // this keep showing as changed every sync" has a real home on the profile
  // itself, named for what it is.
  async function renderWomActivityTab(host, w) {
    host.innerHTML = `<p class="empty-note">Loading…</p>`;
    let history, syncHistory, tasks;
    try {
      [history, syncHistory, tasks] = await Promise.all([
        api.get(`/api/woms/${encodeURIComponent(w.code)}/history`),
        api.get(`/api/woms/${encodeURIComponent(w.code)}/sync-history`),
        api.get(`/api/woms/${encodeURIComponent(w.code)}/tasks`),
      ]);
    } catch (err) {
      host.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const statusLabel = (v) => (v == null ? "—" : WOM_STATUS_LABELS[v] || v);

    host.innerHTML = `
      <div class="vendor-overview-card">
        <h4>Status History</h4>
        ${
          history.length === 0
            ? `<p class="empty-note">No status change recorded for this WOM yet.</p>`
            : `<table class="detail-table">
                <thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead>
                <tbody>
                  ${history
                    .map(
                      (h) => `<tr>
                    <td>${new Date(h.changedAt || h.detectedAt).toLocaleString()}</td>
                    <td>${statusLabel(h.previousValue)} &rarr; ${statusLabel(h.newValue)}</td>
                    <td>${escapeHtml(h.changedByName || (h.source === "smartsheet_sync" ? "Smartsheet sync" : "—"))}</td>
                  </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
        }
      </div>
      <div class="vendor-overview-card">
        <h4>WOM Sync History</h4>
        ${
          syncHistory.length === 0
            ? `<p class="empty-note">No sync has changed this WOM yet.</p>`
            : `<table class="detail-table wom-sync-history-table">
                <thead><tr><th>Synced</th><th>What changed</th></tr></thead>
                <tbody>
                  ${syncHistory
                    .map((h) => `<tr><td>${new Date(h.syncedAt).toLocaleString()}</td><td>${escapeHtml(h.fields.join(", "))}</td></tr>`)
                    .join("")}
                </tbody>
              </table>`
        }
      </div>
      <div class="vendor-overview-card">
        <h4>Task Activity</h4>
        ${
          tasks.length === 0
            ? `<p class="empty-note">No task has ever been linked to this WOM.</p>`
            : `<table class="detail-table">
                <thead><tr><th>Created</th><th>Task</th><th>Status</th></tr></thead>
                <tbody>
                  ${tasks
                    .map(
                      (t) => `<tr>
                    <td>${new Date(t.createdAt).toLocaleDateString()}</td>
                    <td>${escapeHtml(t.title)}</td>
                    <td><span class="badge badge-${WOM_TASK_STATUS_BADGE_CLASS[t.status] || "draft"}">${escapeHtml(t.status)}</span></td>
                  </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
        }
      </div>
    `;
  }

  // Friendlier sentence-case wording for the Overview tab's billing
  // checklist -- the backend's own labels (e.g. "Vendor INV Attached")
  // mirror the Smartsheet column names verbatim for traceability, which
  // reads better in Source details than in a plain-language status card.
  const WOM_BILLING_CHECKLIST_DISPLAY_LABELS = {
    vendorInvAttached: "Vendor invoice attached",
    invoiceAttached: "Invoice attached",
    journalEdit: "Journal edit",
    aribaConfirm: "Ariba confirm",
    sentToJason: "Sent to Jason",
    batchPostedConfirmed: "Batch posted confirmed",
  };

  async function renderWomOverviewTab(host, w, content, locationByCode, locations) {
    const metaItems = [
      { label: "Subsidiary", value: w.subsidiaryCode ? escapeHtml(w.subsidiaryCode) : "—" },
      { label: "Maximo #", value: w.maximoNumber ? escapeHtml(w.maximoNumber) : "—" },
      { label: "Requested by", value: w.sourceRequestedBy ? escapeHtml(w.sourceRequestedBy) : "—" },
      { label: "Location", value: locationByCode[w.locationCode] ? escapeHtml(locationByCode[w.locationCode].name) : "—" },
    ];
    if (w.budgetHours != null) metaItems.push({ label: "Hours remaining", value: `${w.remainingHours}h of ${w.budgetHours}h` });
    metaItems.push({
      label: "Last synced",
      value: w.smartsheetSyncedAt ? new Date(w.smartsheetSyncedAt).toLocaleDateString() : "Never",
    });

    const statusOptions = WOM_STATUSES.map(
      (s) => `<option value="${s}" ${w.status === s ? "selected" : ""}>${escapeHtml(WOM_STATUS_LABELS[s])}</option>`
    ).join("");

    const workCompletedLabel = w.workCompleted === 1 ? "Yes" : w.workCompleted === 0 ? "No" : "Not reported";

    const statCards = `
      <div class="wom-stat-cards">
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128176;</span>
          <div><div class="wom-stat-label">Estimated cost</div><div class="wom-stat-value">${w.estimatedPrice != null ? `$${formatMoney(w.estimatedPrice)}` : "—"}</div></div>
        </div>
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#128196;</span>
          <div><div class="wom-stat-label">Reported applied</div><div class="wom-stat-value">${w.appliedPrice != null ? `$${formatMoney(w.appliedPrice)}` : "Not reported"}</div></div>
        </div>
        <div class="wom-stat-card">
          <span class="wom-stat-icon">&#9989;</span>
          <div><div class="wom-stat-label">Work completion</div><div class="wom-stat-value">${escapeHtml(workCompletedLabel)}</div></div>
        </div>
      </div>
    `;

    // A WOM still waiting on a real WOM # (its code is a PENDING-<rowId>
    // placeholder) can't be invoiced yet by definition -- called out here so
    // an admin doesn't read "Requested from Toyota" as stuck/stalled.
    const pendingCodeHint = w.code.startsWith("PENDING-")
      ? `<div class="wom-info-box">&#8505;&#65039; WOM number is pending and will be available after creation in Toyota.</div>`
      : "";

    const billingChecklistRows = w.billingChecklist
      .map(
        (c) => `
        <div class="wom-checklist-row">
          <span class="wom-checklist-row-label">${escapeHtml(WOM_BILLING_CHECKLIST_DISPLAY_LABELS[c.key] || c.label)}</span>
          <span class="badge ${c.done ? "badge-approved" : "badge-draft"}">${c.done ? "Confirmed" : "Unconfirmed"}</span>
        </div>`
      )
      .join("");

    const conflictHint = w.statusConflict
      ? `<div class="vendor-overview-card"><p class="review-checklist-hint">Smartsheet shows real invoicing evidence (an invoice # on file, or the full billing checklist complete) that the app status below hasn't caught up to yet. The next sync auto-promotes this to Invoiced -- unless this WOM is cancelled, which a sync never auto-changes, so this will keep flagging until an admin looks at it.</p></div>`
      : "";

    host.innerHTML = `
      ${statCards}
      ${conflictHint}
      <div class="vendor-overview-grid wom-overview-main-grid">
        <div class="wom-overview-col">
          <div class="vendor-overview-card">
            <div class="wom-overview-card-header">
              <h4>Project information</h4>
              <span class="wom-overview-card-header-note" title="Fields imported from the Smartsheet tracker.">&#128229; Imported from Smartsheet &#9432;</span>
            </div>
            <dl class="vendor-overview-fields">
              ${metaItems.map((m) => `<div><dt>${m.label}</dt><dd>${m.value}</dd></div>`).join("")}
            </dl>
          </div>
          <div class="vendor-overview-card">
            <h4>Lifecycle checklist</h4>
            <div class="wom-lifecycle-checklist">
              ${w.lifecycleSteps
                .map((s) => {
                  const done = Boolean(s.completedAt);
                  const meta = done ? `${s.completedBy === "sync" ? "auto-completed" : "completed"} ${new Date(s.completedAt).toLocaleString()}` : "";
                  return `
                  <div class="wom-lifecycle-step${done ? " wom-lifecycle-step-done" : ""}">
                    <span class="wom-lifecycle-step-icon">${done ? "✓" : "○"}</span>
                    <span class="wom-lifecycle-step-label">${escapeHtml(s.label)}</span>
                    <span class="wom-lifecycle-step-meta">${escapeHtml(meta)}</span>
                  </div>`;
                })
                .join("")}
            </div>
            <p class="review-checklist-hint">Manage these steps from the Priorities &rarr; Task Manager card for this WOM.</p>
          </div>
        </div>
        <div class="wom-overview-col">
          <div class="vendor-overview-card">
            <div class="wom-overview-card-header">
              <h4>Project status</h4>
              <span class="wom-overview-card-header-note" title="The app's own status -- set manually, or auto-promoted to Invoiced once a real invoice # appears.">&#9432;</span>
            </div>
            <select class="wom-overview-status-select">${statusOptions}</select>
            ${pendingCodeHint}
          </div>
          <div class="vendor-overview-card">
            <div class="wom-overview-card-header">
              <h4>Billing progress</h4>
              <div class="wom-overview-card-header-right">
                <span class="wom-overview-card-header-note" title="Billing evidence from Smartsheet: a real invoice #, or the full checklist confirmed.">&#9432;</span>
                <span class="badge badge-draft">&#128196; ${w.invoiceNumber ? "Invoice recorded" : "Invoice not recorded"}</span>
              </div>
            </div>
            <dl class="vendor-overview-fields">
              <div><dt>Maximo #</dt><dd>${w.maximoNumber ? escapeHtml(w.maximoNumber) : "—"}</dd></div>
              <div><dt>Invoice #</dt><dd>${w.invoiceNumber ? escapeHtml(w.invoiceNumber) : "Not recorded"}</dd></div>
              <div><dt>Batch #</dt><dd>${w.batchNumber ? escapeHtml(w.batchNumber) : "Not recorded"}</dd></div>
              <div><dt>Batch date</dt><dd>${w.batchDate ? escapeHtml(w.batchDate) : "Not recorded"}</dd></div>
              <div><dt>Work completed date</dt><dd>${w.workCompletedDate ? escapeHtml(w.workCompletedDate) : "Not recorded"}</dd></div>
              <div><dt>Billing reference</dt><dd>${w.billingRefNumber ? escapeHtml(w.billingRefNumber) : "Not recorded"}</dd></div>
              <div><dt>Reclass requested</dt><dd>${w.reclassAmountRequested != null ? `$${formatMoney(w.reclassAmountRequested)}` : "Not recorded"}</dd></div>
              <div><dt>Reclass submitted</dt><dd>${w.reclassSubmitted === 1 ? "Yes" : w.reclassSubmitted === 0 ? "No" : "Not reported"}</dd></div>
              <div><dt>Reclass target</dt><dd>${w.reclassTarget ? escapeHtml(w.reclassTarget.label) : "Not recorded"}</dd></div>
            </dl>
            <div class="wom-checklist">${billingChecklistRows}</div>
            <p class="review-checklist-hint">&#8505;&#65039; Historical checklist data may be incomplete.</p>
          </div>
        </div>
      </div>
    `;

    host.querySelector(".wom-overview-status-select").addEventListener("change", async (e) => {
      const nextStatus = e.target.value;
      try {
        await api.patch(`/api/woms/${encodeURIComponent(w.code)}`, { status: nextStatus });
        await drawWoms(content);
      } catch (err) {
        window.alert(`Could not update ${w.code}: ${err.message}`);
        e.target.value = w.status;
      }
    });
  }

  async function renderWomDocumentsTab(host, w) {
    await renderAttachments(host, {
      title: "Documents & Photos",
      relatedType: "wom",
      relatedId: w.code,
      categories: [
        { value: "wom_doc", label: "Document / Photo" },
        { value: "quote", label: "Vendor Quote" },
        { value: "quote_revision", label: "Approved Quote Revision" },
        { value: "invoice", label: "Invoice Document" },
      ],
      canUpload: true,
      emptyText: "No documents attached yet.",
    });
  }

  // A focused edit modal, same split as the vendor profile's own Edit vendor
  // button -- Overview is read-only, this is the only place the WOM's own
  // fields (not its status, which has its own control) get changed.
  function openWomEditFormModal(w, content, locationByCode, locations) {
    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === w.locationCode ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");
    const { body, close } = openModal({
      title: `Edit ${w.code}`,
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
        await drawWoms(content);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
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
    metaItems.push({
      label: "Last synced",
      value: w.smartsheetSyncedAt ? new Date(w.smartsheetSyncedAt).toLocaleDateString() : "Never",
    });

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
      openWomProfile(w.code);
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
  // Shows any reclass item (from the Reclasses tab) tied to this WOM on
  // either side, with its current status -- so opening a WOM's own detail
  // answers "has a reclass against this WOM been accomplished" without
  // having to go search the Reclasses tab separately. Read-only: nothing
  // here can be edited, but "+ Flag a reclass" jumps to the Reclasses tab
  // with this WOM # already pre-filled into the flag form. closeModal is
  // only passed by the (now removed) modal-based caller's leftover callers,
  // if any ever exist again -- the WOM profile's Financials tab calls this
  // with no third argument, since there's no modal to close.
  async function loadWomReclassActivity(body, w, closeModal) {
    const wrap = document.createElement("div");
    wrap.className = "wom-modal-reclasses";
    wrap.innerHTML = `<h4>Reclasses tied to this WOM</h4><p class="empty-note">Loading…</p>`;
    body.appendChild(wrap);
    const goFlagThisWom = () => {
      reclassFlagPrefillWom = w.code;
      activeTab = "reclasses";
      if (closeModal) closeModal();
      draw();
    };
    try {
      const [items, meta] = await Promise.all([
        api.get(`/api/admin/reclasses/items?${new URLSearchParams({ womNumber: w.code })}`),
        api.get("/api/admin/reclasses/meta"),
      ]);
      if (items.length === 0) {
        wrap.innerHTML = `
          <h4>Reclasses tied to this WOM</h4>
          <p class="empty-note">No reclass item (submitted or flagged) references this WOM.</p>
          <button type="button" class="btn btn-secondary wom-flag-reclass-btn">+ Flag a reclass for this WOM</button>
        `;
        wrap.querySelector(".wom-flag-reclass-btn").addEventListener("click", goFlagThisWom);
        return;
      }
      wrap.innerHTML = `
        <h4>Reclasses tied to this WOM</h4>
        <table class="detail-table">
          <tbody>
            ${items
              .map((r) => {
                const label = meta.statuses.find((s) => s.value === r.status)?.label || r.status;
                const badgeClass = r.status === "confirmed_posted" ? "badge-approved" : r.status === "submitted" ? "badge-submitted" : "badge-draft";
                return `
              <tr>
                <th>${r.fromWomNumber === w.code ? "From this WOM" : "To this WOM"}</th>
                <td>${formatMoney(r.fromAmount)} -- ${escapeHtml(r.comments || "no comment")}</td>
                <td><span class="badge ${badgeClass}">${escapeHtml(label)}</span></td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
        <button type="button" class="btn btn-secondary wom-flag-reclass-btn">+ Flag another reclass for this WOM</button>
        <p class="review-checklist-hint">
          Status here is whatever was set on the Reclasses tab -- "Confirmed Posted" means someone verified it
          landed in the GL, not an automatic check. Open the item on the Reclasses tab for the full detail,
          including any matching GL posting found automatically.
        </p>
      `;
      wrap.querySelector(".wom-flag-reclass-btn").addEventListener("click", goFlagThisWom);
    } catch (err) {
      wrap.innerHTML = `<h4>Reclasses tied to this WOM</h4><p class="attachments-error">${escapeHtml(err.message)}</p>`;
    }
  }

  // Financials-wide estimated-vs-applied picture -- every non-cancelled
  // WOM, not just the ones currently sitting in the PSE pipeline. Each
  // "review category" below is one estimate-vs-applied check (remaining
  // labor budget, a cost category that came in over quote, applied cost
  // over the real Toyota PO ceiling, etc.) -- selecting a tile swaps in
  // that category's own sortable/filterable table rather than stacking
  // every category's list on the page at once.
  //
  // Turns the raw cost-summary category arrays (db.js's getWomCostSummary)
  // into one consistent shape the tile strip + detail table both render
  // off of: a tile label/count/total, and a `columns` list whose last
  // entry is always the category's own headline $ figure (remaining
  // estimate, or over-quote amount) -- used for both the table's last
  // column and the detail header's total.
  function buildCostCategories(summary, reclassItemsByWom) {
    const categories = [
      {
        key: "overquoted",
        tileLabel: "Estimated Summary - Applied Summary",
        count: summary.overquotedCount,
        total: summary.overquotedTotal,
        totalLabel: "total remaining",
        sectionTitle: "Estimated Summary - Applied Summary",
        hint:
          "Remaining estimate is not confirmed savings -- it's only accurate once the project is complete " +
          "and costs are reconciled.",
        emptyNote: "No WOMs have remaining estimate right now.",
        items: summary.overquoted,
        columns: [
          { label: "Estimated", get: (w) => w.estimatedPrice },
          { label: "Reported applied", get: (w) => w.appliedPrice },
          { label: "Toy Value", get: (w) => w.toyotaPoValue },
          { label: "Remaining estimate", get: (w) => w.overage, tone: "ok" },
        ],
      },
      {
        key: "remainingToyotaPo",
        tileLabel: "Remaining Toyota PO",
        count: summary.remainingToyotaPoCount,
        total: summary.remainingToyotaPoTotal,
        totalLabel: "total remaining",
        sectionTitle: "Remaining Toyota PO",
        hint:
          "Real PO Tracker amounts summed by WOM # (not the single synced “TOY Value” cell, and not this " +
          "app's own estimate) minus reported applied. Open a row for each PO's own status, exactly as tracked " +
          "— the app doesn't guess at whether Toyota has closed one out.",
        emptyNote: "No WOMs have remaining Toyota PO budget right now.",
        items: summary.remainingToyotaPo,
        columns: [
          { label: "# POs", get: (w) => w.pos.length, type: "number" },
          { label: "Toyota PO total", get: (w) => w.poTotal },
          { label: "Reported applied", get: (w) => w.appliedPrice },
          { label: "Remaining", get: (w) => w.overage, tone: "ok" },
        ],
      },
      {
        key: "appliedNoPo",
        tileLabel: "No Toyota PO",
        count: summary.appliedNoPoCount,
        total: summary.appliedNoPoTotal,
        totalLabel: "total applied",
        sectionTitle: "Applied cost, no Toyota PO yet",
        hint: "A charge has been applied against these WOMs, but there's no Maximo/PO # on file yet.",
        emptyNote: "Every WOM with an applied cost has a Toyota PO on file.",
        items: summary.appliedNoPo,
        columns: [
          { label: "Status", get: (w) => WOM_STATUS_LABELS[w.status] || w.status || "—", isText: true },
          { label: "Reported applied", get: (w) => w.appliedPrice },
        ],
      },
      {
        key: "laborOvercharged",
        tileLabel: "Labor over estimate",
        count: summary.laborOverchargedCount,
        total: summary.laborOverchargedTotal,
        totalLabel: "total over",
        sectionTitle: "Labor applied over estimate",
        hint:
          "Compares against this app's own estimate, not a confirmed GL actual -- see Reconciliation once a " +
          "GL import is available for that comparison.",
        emptyNote: "No WOMs have applied labor over estimate right now.",
        items: summary.laborOvercharged,
        columns: [
          { label: "Estimated labor", get: (w) => w.estimatedLabor },
          { label: "Applied labor", get: (w) => w.appliedLabor },
          { label: "Over amount", get: (w) => w.overage, tone: "danger" },
        ],
      },
      {
        key: "contractedIncreased",
        tileLabel: "Contracted services increased",
        count: summary.contractedIncreasedCount,
        total: summary.contractedIncreasedTotal,
        totalLabel: "total over",
        sectionTitle: "Contracted services increased",
        hint: "Grouped by vendor -- open a vendor to see which of their projects ran over quote.",
        emptyNote: "No WOMs have a contracted-services increase right now.",
        items: summary.contractedIncreased,
        groupByVendor: true,
        columns: [
          { label: "Estimated contracted", get: (w) => w.estimatedContracted },
          { label: "Applied contracted", get: (w) => w.appliedContracted },
          { label: "Over amount", get: (w) => w.overage, tone: "danger" },
        ],
      },
      // "Other Direct Costs" is excluded here on purpose (Krista: it's ~5% of
      // the other categories either way, not worth its own tile/table) --
      // db.js still computes it in case that changes later, this just
      // doesn't surface it.
      ...summary.categoryOverages
        .filter((cat) => cat.key !== "otherDirect")
        .map((cat) => ({
          key: `category-${cat.key}`,
          tileLabel: cat.label,
          count: cat.count,
          total: cat.total,
          totalLabel: "total over",
          sectionTitle: `${cat.label} applied over estimate`,
          hint: `Applied ${cat.label.toLowerCase()} cost came in higher than what was estimated.`,
          emptyNote: `No WOMs have a ${cat.label.toLowerCase()} increase right now.`,
          items: cat.items,
          columns: [
            { label: "Estimated", get: (w) => w.estimated },
            { label: "Applied", get: (w) => w.applied },
            { label: "Over amount", get: (w) => w.overage, tone: "danger" },
          ],
        })),
      {
        key: "appliedOverToyotaPo",
        tileLabel: "Applied over PO",
        count: summary.appliedOverToyotaPoCount,
        total: summary.appliedOverToyotaPoTotal,
        totalLabel: "total over",
        sectionTitle: "Applied over Toyota PO value",
        hint:
          "Checks against what Toyota actually approved, not just against this app's own estimate -- see the " +
          "other categories above for estimate-vs-applied by category. “Reclassed” means a reclass " +
          "referencing this WOM # is on file; “Unknown” just means none was found by WOM # -- it " +
          "doesn't rule one out.",
        emptyNote: "No WOMs are applied over their Toyota PO value right now.",
        items: summary.appliedOverToyotaPo,
        columns: [
          { label: "Toyota PO value", get: (w) => w.toyotaPoValue },
          { label: "Reported applied", get: (w) => w.appliedPrice },
          { label: "Over amount", get: (w) => w.overage, tone: "danger" },
          {
            label: "Reclass",
            type: "reclass",
            get: (w) => (reclassItemsByWom[w.code] && reclassItemsByWom[w.code][0]) || null,
          },
        ],
      },
    ];
    return categories;
  }

  function filterCostItems(items, locationFilter, query, locationByCode) {
    let filtered = items;
    const territory = getTerritory();
    if (territory && locationByCode) {
      filtered = filtered.filter((w) => w.locationCode && ((locationByCode[w.locationCode] || {}).territory || "Midwest") === territory);
    }
    if (locationFilter) filtered = filtered.filter((w) => w.locationCode === locationFilter);
    const q = query.trim().toLowerCase();
    if (q) filtered = filtered.filter((w) => (w.description || "").toLowerCase().includes(q) || (w.code || "").toLowerCase().includes(q));
    return filtered;
  }

  function sortCostItems(items, columns, sortKey, sortDir) {
    if (!sortKey) return items;
    let getter;
    if (sortKey === "project") getter = (w) => (w.description || w.code || "").toLowerCase();
    else if (sortKey === "wom") getter = (w) => (w.code || "").toLowerCase();
    else if (sortKey === "location") getter = (w) => (w.locationCode || "").toLowerCase();
    else {
      const col = columns[Number(sortKey.slice(3))];
      if (col.type === "reclass") getter = (w) => (col.get(w) ? 1 : 0);
      else if (col.isText) getter = (w) => String(col.get(w) || "").toLowerCase();
      else getter = (w) => Number(col.get(w)) || 0;
    }
    const sorted = [...items];
    sorted.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  // The $ column a category's header total and vendor-group sort key off
  // of -- normally just the last column, but a trailing non-money column
  // (the Reclass flag on Applied-over-PO) would otherwise get treated as
  // the headline figure and silently zero out the total.
  function headlineColumnOf(cat) {
    for (let i = cat.columns.length - 1; i >= 0; i--) {
      if (!cat.columns[i].isText && cat.columns[i].type !== "reclass") return cat.columns[i];
    }
    return cat.columns[cat.columns.length - 1];
  }

  function costSortArrow(key) {
    if (costSortKey !== key) return "";
    return costSortDir === "asc" ? " ▲" : " ▼";
  }

  function downloadCsv(filename, headers, rows) {
    const escapeCsv = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(escapeCsv).join(","), ...rows.map((r) => r.map(escapeCsv).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Repeated Costs Above Quote / Vendor Spend Overview -- helpers shared by
  // both tables. "Open" vs "completed" is the same split the WOM_STATUSES
  // comment above already draws: pending/requested/open are still in
  // flight, invoiced/closed are done. cancelled WOMs never reach either
  // table (getWomCostSummary already excludes them).
  const VA_OPEN_STATUSES = new Set(["pending", "requested", "open"]);
  const VA_REVIEW_REASON_LABELS = {
    scope_change: "Approved scope change / change order",
    entry_error: "Quote or estimate entry error",
    coding_issue: "Coding issue",
    unexplained: "Unexplained difference",
  };
  const VA_REVIEW_STATUS_LABELS = { needs_review: "Needs review", mixed: "Mixed", reviewed: "Reviewed" };
  function vaReviewBadgeClass(status) {
    if (status === "reviewed") return "badge-approved";
    if (status === "mixed") return "badge-warn";
    return "badge-rejected";
  }
  function vaStatusGroup(status) {
    return VA_OPEN_STATUSES.has(status) ? "open" : "completed";
  }
  function formatPct(pct) {
    return pct == null ? "N/A" : `${pct.toFixed(1)}%`;
  }

  function vaMatchesFilters(item, locationByCode) {
    const territory = getTerritory();
    if (territory) {
      const loc = item.locationCode ? locationByCode[item.locationCode] : null;
      if (!loc || (loc.territory || "Midwest") !== territory) return false;
    }
    if (vaRegionFilter) {
      const loc = item.locationCode ? locationByCode[item.locationCode] : null;
      if (!loc || loc.region !== vaRegionFilter) return false;
    }
    if (vaLocationFilter && item.locationCode !== vaLocationFilter) return false;
    if (vaSubsidiaryFilter && (item.subsidiaryCode || "") !== vaSubsidiaryFilter) return false;
    if (vaStatusFilter && vaStatusGroup(item.status) !== vaStatusFilter) return false;
    return true;
  }

  // Mirrors the vendor-grouping math getWomCostSummary does server-side
  // (unfiltered) so the UI can re-group after the admin narrows the filter
  // bar, without a round trip -- same "group a flat item list client-side"
  // approach renderVendorGroupedTable above already uses.
  function vaAggregateAboveQuote(items) {
    const byVendor = new Map();
    for (const c of items) {
      if (!c.vendorId) continue;
      const cur = byVendor.get(c.vendorId) || { vendorId: c.vendorId, vendorName: c.vendorName, comparable: [], aboveQuote: [] };
      cur.comparable.push(c);
      if (c.aboveQuote) cur.aboveQuote.push(c);
      byVendor.set(c.vendorId, cur);
    }
    return [...byVendor.values()]
      .filter((v) => v.aboveQuote.length > 1)
      .map((v) => {
        const totalAboveQuote = v.aboveQuote.reduce((sum, c) => sum + c.diff, 0);
        const totalComparisonQuote = v.aboveQuote.reduce((sum, c) => sum + c.quote, 0);
        const reviewedCount = v.aboveQuote.filter((c) => c.reviewStatus === "reviewed").length;
        const reviewStatus = reviewedCount === 0 ? "needs_review" : reviewedCount === v.aboveQuote.length ? "reviewed" : "mixed";
        return {
          vendorId: v.vendorId,
          vendorName: v.vendorName,
          comparableWomCount: v.comparable.length,
          aboveQuoteCount: v.aboveQuote.length,
          totalAboveQuote,
          totalComparisonQuote,
          pctAboveQuote: totalComparisonQuote !== 0 ? (totalAboveQuote / totalComparisonQuote) * 100 : null,
          reviewStatus,
          comparableItems: v.comparable,
        };
      });
  }

  function vaAggregateSpend(items) {
    const byVendor = new Map();
    for (const it of items) {
      const cur = byVendor.get(it.vendorId) || { vendorId: it.vendorId, vendorName: it.vendorName, items: [], total: 0 };
      cur.items.push(it);
      cur.total += it.applied;
      byVendor.set(it.vendorId, cur);
    }
    const groups = [...byVendor.values()];
    const grandTotal = groups.reduce((sum, g) => sum + g.total, 0);
    return groups.map((g) => ({
      vendorId: g.vendorId,
      vendorName: g.vendorName,
      womCount: g.items.length,
      totalAppliedContracted: g.total,
      shareOfMatchedCosts: grandTotal !== 0 ? (g.total / grandTotal) * 100 : null,
      items: g.items,
    }));
  }

  function vaSortRows(rows, sortState, getters) {
    const getter = getters[sortState.key];
    if (!getter) return rows;
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return sortState.dir === "asc" ? -1 : 1;
      if (av > bv) return sortState.dir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  const VA_ABOVE_QUOTE_GETTERS = {
    vendorName: (r) => (r.vendorName || "").toLowerCase(),
    comparableWomCount: (r) => r.comparableWomCount,
    aboveQuoteCount: (r) => r.aboveQuoteCount,
    totalAboveQuote: (r) => r.totalAboveQuote,
    pctAboveQuote: (r) => (r.pctAboveQuote == null ? -Infinity : r.pctAboveQuote),
    reviewStatus: (r) => ({ needs_review: 0, mixed: 1, reviewed: 2 }[r.reviewStatus]),
  };
  const VA_SPEND_GETTERS = {
    vendorName: (r) => (r.vendorName || "").toLowerCase(),
    womCount: (r) => r.womCount,
    totalAppliedContracted: (r) => r.totalAppliedContracted,
    shareOfMatchedCosts: (r) => (r.shareOfMatchedCosts == null ? -Infinity : r.shareOfMatchedCosts),
  };

  function vaSortArrow(sortState, key) {
    if (sortState.key !== key) return "";
    return sortState.dir === "asc" ? " ▲" : " ▼";
  }

  function vaReviewReasonSelectHtml(c) {
    return `
      <select class="va-review-reason-select" data-code="${escapeHtml(c.code)}">
        <option value="">Needs review</option>
        ${Object.entries(VA_REVIEW_REASON_LABELS)
          .map(([k, label]) => `<option value="${k}" ${c.reviewReason === k ? "selected" : ""}>${escapeHtml(label)}</option>`)
          .join("")}
      </select>
    `;
  }

  function renderVendorAboveQuoteDetail(v, locationByCode) {
    const items = [...v.comparableItems].sort((a, b) => b.diff - a.diff);
    return `
      <tr class="cost-row-nested-wrap"><td colspan="7">
        <div class="va-detail">
          <button type="button" class="btn-link va-vendor-profile-link" data-vendor-id="${v.vendorId}">View vendor profile &rsaquo;</button>
          <table class="detail-table va-detail-table">
            <thead>
              <tr><th>WOM</th><th>Location</th><th>Status</th><th>Quote</th><th>Applied</th><th>Difference</th><th>% Above</th><th>Review reason</th></tr>
            </thead>
            <tbody>
              ${items
                .map((c) => {
                  const loc = c.locationCode ? locationByCode[c.locationCode] : null;
                  return `
                <tr>
                  <td><button type="button" class="btn-link va-wom-link" data-code="${escapeHtml(c.code)}">${escapeHtml(c.code)}</button><div class="wom-desc">${escapeHtml(c.description || "")}</div></td>
                  <td>${loc ? escapeHtml(loc.name) : "—"}</td>
                  <td>${escapeHtml(WOM_STATUS_LABELS[c.status] || c.status || "—")}</td>
                  <td>$${formatMoney(c.quote)}</td>
                  <td>$${formatMoney(c.applied)}</td>
                  <td class="${c.aboveQuote ? "cost-amount-danger" : "cost-amount-ok"}">$${formatMoney(c.diff)}</td>
                  <td>${formatPct(c.pctAboveQuote)}</td>
                  <td>${c.aboveQuote ? vaReviewReasonSelectHtml(c) : "—"}</td>
                </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </td></tr>
    `;
  }

  function renderVendorAboveQuoteTable(rows, locationByCode) {
    if (rows.length === 0) {
      return `<p class="empty-note">No vendor has come in above quote on more than one comparable WOM matching these filters.</p>`;
    }
    const sorted = vaSortRows(rows, vaAboveQuoteSort, VA_ABOVE_QUOTE_GETTERS);
    return `
      <table class="detail-table cost-table va-table">
        <thead>
          <tr>
            <th class="sortable" data-va-sort="vendorName">Vendor${vaSortArrow(vaAboveQuoteSort, "vendorName")}</th>
            <th class="sortable" data-va-sort="comparableWomCount">Comparable WOMs${vaSortArrow(vaAboveQuoteSort, "comparableWomCount")}</th>
            <th class="sortable" data-va-sort="aboveQuoteCount">WOMs Above Quote${vaSortArrow(vaAboveQuoteSort, "aboveQuoteCount")}</th>
            <th class="sortable" data-va-sort="totalAboveQuote">Total Above Quote${vaSortArrow(vaAboveQuoteSort, "totalAboveQuote")}</th>
            <th class="sortable" data-va-sort="pctAboveQuote" title="Total excess across this vendor's above-quote WOMs, divided by the total quote across those same above-quote WOMs.">% Above Quote${vaSortArrow(vaAboveQuoteSort, "pctAboveQuote")}</th>
            <th class="sortable" data-va-sort="reviewStatus">Review Status${vaSortArrow(vaAboveQuoteSort, "reviewStatus")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sorted
            .map((v) => {
              const expanded = vaAboveQuoteExpanded.has(String(v.vendorId));
              const row = `
              <tr class="cost-vendor-group-row va-above-row" data-vendor-id="${v.vendorId}">
                <td>${escapeHtml(v.vendorName || "Unknown vendor")}</td>
                <td>${v.comparableWomCount}</td>
                <td>${v.aboveQuoteCount} of ${v.comparableWomCount}</td>
                <td class="cost-amount-danger">$${formatMoney(v.totalAboveQuote)}</td>
                <td>${formatPct(v.pctAboveQuote)}</td>
                <td><span class="badge ${vaReviewBadgeClass(v.reviewStatus)}">${VA_REVIEW_STATUS_LABELS[v.reviewStatus]}</span></td>
                <td class="cost-row-chevron">${expanded ? "▼" : "▶"}</td>
              </tr>`;
              return row + (expanded ? renderVendorAboveQuoteDetail(v, locationByCode) : "");
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  function renderVendorSpendDetail(v, locationByCode) {
    const items = [...v.items].sort((a, b) => b.applied - a.applied);
    return `
      <tr class="cost-row-nested-wrap"><td colspan="6">
        <div class="va-detail">
          <button type="button" class="btn-link va-vendor-profile-link" data-vendor-id="${v.vendorId}">View vendor profile &rsaquo;</button>
          <table class="detail-table va-detail-table">
            <thead><tr><th>WOM</th><th>Location</th><th>Status</th><th>Applied</th></tr></thead>
            <tbody>
              ${items
                .map((it) => {
                  const loc = it.locationCode ? locationByCode[it.locationCode] : null;
                  return `
                <tr>
                  <td><button type="button" class="btn-link va-wom-link" data-code="${escapeHtml(it.code)}">${escapeHtml(it.code)}</button><div class="wom-desc">${escapeHtml(it.description || "")}</div></td>
                  <td>${loc ? escapeHtml(loc.name) : "—"}</td>
                  <td>${escapeHtml(WOM_STATUS_LABELS[it.status] || it.status || "—")}</td>
                  <td>$${formatMoney(it.applied)}</td>
                </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </td></tr>
    `;
  }

  function renderVendorSpendTable(rows, locationByCode, vendorGlTotalsById) {
    if (rows.length === 0) {
      return `<p class="empty-note">No WOM matching these filters has both a vendor match and an applied contracted-services cost.</p>`;
    }
    const sorted = vaSortRows(rows, vaSpendSort, VA_SPEND_GETTERS);
    return `
      <table class="detail-table cost-table va-table">
        <thead>
          <tr>
            <th class="sortable" data-va-sort="vendorName">Vendor${vaSortArrow(vaSpendSort, "vendorName")}</th>
            <th class="sortable" data-va-sort="womCount">Linked WOMs${vaSortArrow(vaSpendSort, "womCount")}</th>
            <th class="sortable" data-va-sort="totalAppliedContracted">Reported Applied Cost${vaSortArrow(vaSpendSort, "totalAppliedContracted")}</th>
            <th title="What's actually posted to the GL against this vendor's matched POs -- all periods imported, not scoped to the filters above.">GL Reported Total &#9432;</th>
            <th class="sortable" data-va-sort="shareOfMatchedCosts">Share of Matched Vendor Costs${vaSortArrow(vaSpendSort, "shareOfMatchedCosts")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sorted
            .map((v) => {
              const expanded = vaSpendExpanded.has(String(v.vendorId));
              const gl = vendorGlTotalsById.get(v.vendorId);
              const row = `
              <tr class="cost-vendor-group-row va-spend-row" data-vendor-id="${v.vendorId}">
                <td>${escapeHtml(v.vendorName || "Unknown vendor")}</td>
                <td>${v.womCount}</td>
                <td>$${formatMoney(v.totalAppliedContracted)}</td>
                <td>${gl ? `$${formatMoney(gl.totalGlAmount)}` : "No GL match"}</td>
                <td>${formatPct(v.shareOfMatchedCosts)}</td>
                <td class="cost-row-chevron">${expanded ? "▼" : "▶"}</td>
              </tr>`;
              return row + (expanded ? renderVendorSpendDetail(v, locationByCode) : "");
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  function latestDataRefresh(allWoms) {
    let max = null;
    for (const w of allWoms) {
      if (w.smartsheetSyncedAt && (!max || w.smartsheetSyncedAt > max)) max = w.smartsheetSyncedAt;
    }
    return max;
  }

  // Draws the filter bar + both tables, and re-draws just this section (not
  // the whole Cost Analysis page) on every filter/sort/expand change --
  // same "redraw a sub-tree" pattern GL Reconciliation's own tables use.
  function drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms) {
    const comparisons = summary.contractedComparisons.filter((c) => vaMatchesFilters(c, locationByCode));
    const spendDetail = summary.vendorSpendDetail.filter((it) => vaMatchesFilters(it, locationByCode));
    const aboveQuoteRows = vaAggregateAboveQuote(comparisons);
    const filteredAboveQuoteRows = vaReviewStatusFilter ? aboveQuoteRows.filter((r) => r.reviewStatus === vaReviewStatusFilter) : aboveQuoteRows;
    const spendRows = vaAggregateSpend(spendDetail);
    const vendorGlTotalsById = new Map((summary.vendorGlTotals || []).map((g) => [g.vendorId, g]));

    const allItemsForFilters = [...summary.contractedComparisons, ...summary.vendorSpendDetail];
    const regionsInUse = [
      ...new Set(
        allItemsForFilters.map((it) => (it.locationCode ? (locationByCode[it.locationCode] || {}).region : null)).filter(Boolean)
      ),
    ].sort();
    const locCodesInUse = new Set(allItemsForFilters.map((it) => it.locationCode).filter(Boolean));
    const locationsInUse = locations.filter((l) => locCodesInUse.has(l.code)).sort((a, b) => a.name.localeCompare(b.name));
    const subsidiariesInUse = [...new Set(allItemsForFilters.map((it) => it.subsidiaryCode).filter(Boolean))].sort();
    const refresh = latestDataRefresh(allWoms);
    const unallocated = summary.contractedUnallocated;

    wrap.innerHTML = `
      <p class="overview-hint">
        All imported projects &middot; Project-reported amounts${refresh ? ` &middot; Latest data refresh: ${new Date(refresh).toLocaleString()}` : ""}.
        Not labeled as fiscal-year actuals -- that comparison belongs to GL Reconciliation once GL data supports it.
      </p>
      <div class="wom-filter-bar va-filter-bar">
        <select class="va-region-filter">
          <option value="">All regions</option>
          ${regionsInUse.map((r) => `<option value="${escapeHtml(r)}" ${vaRegionFilter === r ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
        </select>
        <select class="va-location-filter">
          <option value="">All locations</option>
          ${locationsInUse.map((l) => `<option value="${escapeHtml(l.code)}" ${vaLocationFilter === l.code ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")}
        </select>
        <select class="va-subsidiary-filter">
          <option value="">All subsidiaries</option>
          ${subsidiariesInUse.map((s) => `<option value="${escapeHtml(s)}" ${vaSubsidiaryFilter === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
        </select>
        <select class="va-status-filter">
          <option value="">Open + completed</option>
          <option value="open" ${vaStatusFilter === "open" ? "selected" : ""}>Open projects</option>
          <option value="completed" ${vaStatusFilter === "completed" ? "selected" : ""}>Completed projects</option>
        </select>
        <select class="va-review-status-filter">
          <option value="">Any review status</option>
          <option value="needs_review" ${vaReviewStatusFilter === "needs_review" ? "selected" : ""}>Needs review</option>
          <option value="mixed" ${vaReviewStatusFilter === "mixed" ? "selected" : ""}>Mixed</option>
          <option value="reviewed" ${vaReviewStatusFilter === "reviewed" ? "selected" : ""}>Reviewed</option>
        </select>
      </div>

      <h3>Repeated Costs Above Quote</h3>
      <p class="review-checklist-hint">
        Vendors whose reported applied contracted-services costs exceed their quoted amount on multiple WOMs.
        Review the projects for scope changes, approved adjustments, or unexplained differences.
      </p>
      <div class="va-above-quote-wrap"></div>

      <h3>Vendor Spend Overview</h3>
      <p class="review-checklist-hint">
        Reported applied contracted-services costs by vendor across imported WOMs, alongside what's actually posted
        to the GL against that vendor's matched POs (all GL periods imported -- not scoped to the filters above).
      </p>
      <div class="va-spend-wrap"></div>

      ${
        unallocated.count > 0
          ? `<p class="review-checklist-hint">
               <strong>Vendor cost allocation needed:</strong> ${unallocated.count} WOM${unallocated.count === 1 ? "" : "s"} with a reported applied
               contracted-services cost (totaling $${formatMoney(unallocated.total)}) ${unallocated.count === 1 ? "has" : "have"} no confirmed vendor match yet --
               excluded from both tables above until matched. See the Budget PO Tracker / Vendor Directory to resolve.
             </p>`
          : ""
      }
    `;

    wrap.querySelector(".va-above-quote-wrap").innerHTML = renderVendorAboveQuoteTable(filteredAboveQuoteRows, locationByCode);
    wrap.querySelector(".va-spend-wrap").innerHTML = renderVendorSpendTable(spendRows, locationByCode, vendorGlTotalsById);

    wrap.querySelector(".va-region-filter").addEventListener("change", (e) => {
      vaRegionFilter = e.target.value;
      drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
    });
    wrap.querySelector(".va-location-filter").addEventListener("change", (e) => {
      vaLocationFilter = e.target.value;
      drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
    });
    wrap.querySelector(".va-subsidiary-filter").addEventListener("change", (e) => {
      vaSubsidiaryFilter = e.target.value;
      drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
    });
    wrap.querySelector(".va-status-filter").addEventListener("change", (e) => {
      vaStatusFilter = e.target.value;
      drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
    });
    wrap.querySelector(".va-review-status-filter").addEventListener("change", (e) => {
      vaReviewStatusFilter = e.target.value;
      drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
    });

    wrap.querySelectorAll(".va-above-quote-wrap th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.vaSort;
        if (vaAboveQuoteSort.key === key) vaAboveQuoteSort.dir = vaAboveQuoteSort.dir === "asc" ? "desc" : "asc";
        else vaAboveQuoteSort = { key, dir: "desc" };
        drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
      });
    });
    wrap.querySelectorAll(".va-spend-wrap th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.vaSort;
        if (vaSpendSort.key === key) vaSpendSort.dir = vaSpendSort.dir === "asc" ? "desc" : "asc";
        else vaSpendSort = { key, dir: "desc" };
        drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
      });
    });

    wrap.querySelectorAll(".va-above-row").forEach((row) => {
      row.addEventListener("click", () => {
        const key = row.dataset.vendorId;
        if (vaAboveQuoteExpanded.has(key)) vaAboveQuoteExpanded.delete(key);
        else vaAboveQuoteExpanded.add(key);
        drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
      });
    });
    wrap.querySelectorAll(".va-spend-row").forEach((row) => {
      row.addEventListener("click", () => {
        const key = row.dataset.vendorId;
        if (vaSpendExpanded.has(key)) vaSpendExpanded.delete(key);
        else vaSpendExpanded.add(key);
        drawVendorAnalysisSection(wrap, content, summary, locationByCode, locations, allWoms);
      });
    });

    wrap.querySelectorAll(".va-vendor-profile-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openVendorProfile(Number(btn.dataset.vendorId));
      });
    });
    wrap.querySelectorAll(".va-wom-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (allWoms.some((item) => item.code === btn.dataset.code)) openWomProfile(btn.dataset.code);
      });
    });
    wrap.querySelectorAll(".va-review-reason-select").forEach((select) => {
      select.addEventListener("click", (e) => e.stopPropagation());
      select.addEventListener("change", async (e) => {
        e.stopPropagation();
        const code = select.dataset.code;
        const reviewReason = select.value || null;
        try {
          await api.patch(`/api/woms/${encodeURIComponent(code)}/cost-review`, {
            reviewStatus: reviewReason ? "reviewed" : "needs_review",
            reviewReason,
          });
          await drawCostAnalysis(content);
        } catch (err) {
          window.alert(err.message);
        }
      });
    });
  }

  async function drawCostAnalysis(content) {
    const [summary, allWoms, locations, reclassItems] = await Promise.all([
      api.get("/api/woms/cost-summary"),
      api.get("/api/woms"),
      api.get("/api/locations"),
      api.get("/api/admin/reclasses/items"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    // Cross-references the Applied-over-PO category against reclass items by
    // WOM # (either side of the reclass) -- a best-effort signal, not proof:
    // a reclass item with no WOM # on file at all (common when the WOM # was
    // itself the thing being corrected) won't match here. See the note
    // Krista and I worked through on WOM Sync columns that would make this
    // exact, instead of inferred.
    const reclassItemsByWom = {};
    for (const item of reclassItems) {
      for (const wom of [item.fromWomNumber, item.toWomNumber]) {
        if (!wom) continue;
        (reclassItemsByWom[wom] = reclassItemsByWom[wom] || []).push(item);
      }
    }
    const categories = buildCostCategories(summary, reclassItemsByWom);
    if (!costCategoryKey || !categories.some((c) => c.key === costCategoryKey)) {
      costCategoryKey = categories[0].key;
    }

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-header-title">WOM Projects: Estimate vs. Applied</h1>
          <p class="page-header-subtitle">Every WOM's original cost estimate against what's actually been reported applied against it</p>
          <p class="overview-hint">
            Project-reported amounts &middot; all WOMs on file, excluding cancelled. Compares against this
            app's own estimate, not a confirmed GL actual -- see Reconciliation for that.
          </p>
        </div>
        <div class="page-header-actions">
          <select class="cost-location-filter">
            <option value="">All locations</option>
            ${locations
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => `<option value="${escapeHtml(l.code)}" ${costLocationFilter === l.code ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
              .join("")}
          </select>
          <label class="search-field">
            <span class="search-field-icon">&#128269;</span>
            <input type="search" class="cost-search-input" placeholder="Search projects, WOMs..." value="${escapeHtml(costSearchQuery)}" />
          </label>
          <button type="button" class="btn btn-outline cost-export-btn">&#8681; Export</button>
        </div>
      </div>

      <div class="cost-kpi-tiles">
        <div class="cost-kpi-tile">
          <div class="cost-kpi-icon">&#128196;</div>
          <div class="cost-kpi-text">
            <span class="cost-kpi-label">Total estimated</span>
            <span class="cost-kpi-value">$${formatMoney(summary.totalEstimated)}</span>
            <span class="cost-kpi-sub">${summary.estimatedCount} WOMs</span>
          </div>
        </div>
        <div class="cost-kpi-tile">
          <div class="cost-kpi-icon">$</div>
          <div class="cost-kpi-text">
            <span class="cost-kpi-label">Reported applied</span>
            <span class="cost-kpi-value">$${formatMoney(summary.totalApplied)}</span>
            <span class="cost-kpi-sub">${summary.appliedCount} WOMs</span>
          </div>
        </div>
        <div class="cost-kpi-tile">
          <div class="cost-kpi-icon">&#128196;</div>
          <div class="cost-kpi-text">
            <span class="cost-kpi-label">Toyota PO value</span>
            <span class="cost-kpi-value">$${formatMoney(summary.totalToyotaPoValue)}</span>
            <span class="cost-kpi-sub">${summary.toyotaPoValueCount} WOMs</span>
          </div>
        </div>
        <div class="cost-kpi-tile">
          <div class="cost-kpi-icon">&#128202;</div>
          <div class="cost-kpi-text">
            <span class="cost-kpi-label">Estimate less reported applied</span>
            <span class="cost-kpi-value">$${formatMoney(summary.totalDelta)}</span>
            <span class="cost-kpi-sub">Project-reported difference</span>
          </div>
        </div>
      </div>

      <h3>Review categories</h3>
      <div id="cost-body"></div>

      <div class="va-section"></div>
    `;

    redrawCostBody(content, categories, allWoms, locationByCode, locations);

    content.querySelector(".cost-location-filter").addEventListener("change", (e) => {
      costLocationFilter = e.target.value;
      redrawCostBody(content, categories, allWoms, locationByCode, locations);
    });
    content.querySelector(".cost-search-input").addEventListener("input", (e) => {
      costSearchQuery = e.target.value;
      redrawCostBody(content, categories, allWoms, locationByCode, locations);
    });
    content.querySelector(".cost-export-btn").addEventListener("click", () => {
      const cat = categories.find((c) => c.key === costCategoryKey);
      const filtered = filterCostItems(cat.items, costLocationFilter, costSearchQuery, locationByCode);
      const sorted = sortCostItems(filtered, cat.columns, costSortKey, costSortDir);
      const headers = ["Project", "WOM", "Location", ...cat.columns.map((c) => c.label)];
      const rows = sorted.map((w) => [
        w.description || w.code,
        w.code,
        w.locationCode || "",
        ...cat.columns.map((c) => {
          if (c.type === "reclass") return c.get(w) ? `Reclassed (#${c.get(w).id})` : "Unknown";
          return c.isText || c.type === "number" ? c.get(w) : formatMoney(c.get(w));
        }),
      ]);
      downloadCsv(`financials-${cat.key}-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    });

    drawVendorAnalysisSection(content.querySelector(".va-section"), content, summary, locationByCode, locations, allWoms);
  }

  // Re-renders just the category tile strip + selected category's detail
  // table (not the whole tab) -- keeps the location-filter/search controls
  // above it from losing focus/scroll position on every keystroke or sort
  // click, same pattern as refreshWomList for the WOM Projects tab.
  function redrawCostBody(content, categories, allWoms, locationByCode, locations) {
    const body = content.querySelector("#cost-body");
    const cat = categories.find((c) => c.key === costCategoryKey) || categories[0];
    const filtered = filterCostItems(cat.items, costLocationFilter, costSearchQuery, locationByCode);
    const sorted = sortCostItems(filtered, cat.columns, costSortKey, costSortDir);
    const headlineCol = headlineColumnOf(cat);
    const filteredTotal = filtered.reduce((sum, w) => sum + (Number(headlineCol.get(w)) || 0), 0);
    const colCount = 3 + cat.columns.length + 1;

    body.innerHTML = `
      <div class="cost-category-tiles">
        ${categories
          .map((c) => {
            // Tile counts reflect the active location/search filters too --
            // showing "3" on a tile while its own table (once selected) only
            // lists 1 filtered row would read as a bug, not a feature.
            const tileCount = c.key === cat.key ? filtered.length : filterCostItems(c.items, costLocationFilter, costSearchQuery, locationByCode).length;
            return `
          <div class="cost-category-tile ${c.key === costCategoryKey ? "cost-category-tile-selected" : ""}" data-key="${escapeHtml(c.key)}">
            <div class="cost-category-tile-count">${tileCount}</div>
            <div class="cost-category-tile-label">${escapeHtml(c.tileLabel)}</div>
          </div>
        `;
          })
          .join("")}
      </div>

      <div class="cost-detail-header">
        <div>
          <h3>${escapeHtml(cat.sectionTitle)}</h3>
          <p class="review-checklist-hint">${escapeHtml(cat.hint)}</p>
        </div>
        <div class="cost-detail-total">
          <strong>$${formatMoney(filteredTotal)}</strong> ${escapeHtml(cat.totalLabel)} &middot;
          ${filtered.length} project${filtered.length === 1 ? "" : "s"}
        </div>
      </div>

      ${cat.groupByVendor ? renderVendorGroupedTable(cat, sorted) : renderFlatCostTable(cat, sorted, colCount)}
    `;

    body.querySelectorAll(".cost-category-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        costCategoryKey = tile.dataset.key;
        costSortKey = null;
        redrawCostBody(content, categories, allWoms, locationByCode, locations);
      });
    });

    body.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (costSortKey === key) {
          costSortDir = costSortDir === "asc" ? "desc" : "asc";
        } else {
          costSortKey = key;
          costSortDir = key === "project" || key === "wom" || key === "location" ? "asc" : "desc";
        }
        redrawCostBody(content, categories, allWoms, locationByCode, locations);
      });
    });

    body.querySelectorAll("tr.cost-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".cost-reclass-link")) return;
        const w = sorted.find((item) => item.code === row.dataset.code);
        if (w) openCostDetailModal(w, cat, locationByCode);
      });
    });

    body.querySelectorAll(".cost-vendor-group-row").forEach((row) => {
      row.addEventListener("click", () => {
        const key = row.dataset.vendorKey;
        if (expandedCostVendors.has(key)) expandedCostVendors.delete(key);
        else expandedCostVendors.add(key);
        redrawCostBody(content, categories, allWoms, locationByCode, locations);
      });
    });

    body.querySelectorAll(".cost-reclass-link").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        reclassItemToOpen = Number(btn.dataset.reclassId);
        activeTab = "reclasses";
        draw();
      });
    });
  }

  function renderCostColumnCell(c, w) {
    const v = c.get(w);
    if (c.type === "reclass") {
      return v
        ? `<td><button type="button" class="btn-link cost-reclass-link" data-reclass-id="${v.id}">Reclassed</button></td>`
        : `<td><span class="badge badge-draft">Unknown</span></td>`;
    }
    if (c.isText || c.type === "number") return `<td>${escapeHtml(v)}</td>`;
    const toneClass = c.tone === "ok" ? "cost-amount-ok" : c.tone === "danger" ? "cost-amount-danger" : "";
    return `<td class="${toneClass}">$${formatMoney(v)}</td>`;
  }

  function renderFlatCostTable(cat, sorted, colCount) {
    return `
      <table class="detail-table cost-table">
        <thead>
          <tr>
            <th class="sortable" data-sort="project">Project${costSortArrow("project")}</th>
            <th class="sortable" data-sort="wom">WOM${costSortArrow("wom")}</th>
            <th class="sortable" data-sort="location">Location${costSortArrow("location")}</th>
            ${cat.columns.map((c, i) => `<th class="sortable" data-sort="col${i}">${escapeHtml(c.label)}${costSortArrow(`col${i}`)}</th>`).join("")}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${
            sorted.length === 0
              ? `<tr><td colspan="${colCount}"><p class="empty-note">${sorted.length === 0 && cat.items.length === 0 ? escapeHtml(cat.emptyNote) : "No projects match these filters."}</p></td></tr>`
              : sorted
                  .map(
                    (w) => `
            <tr class="cost-row" data-code="${escapeHtml(w.code)}">
              <td>${escapeHtml(w.description || w.code)}</td>
              <td class="wom-code">${escapeHtml(w.code)}</td>
              <td>${w.locationCode ? escapeHtml(w.locationCode) : "—"}</td>
              ${cat.columns.map((c) => renderCostColumnCell(c, w)).join("")}
              <td class="cost-row-chevron">&rsaquo;</td>
            </tr>
          `
                  )
                  .join("")
          }
        </tbody>
      </table>
    `;
  }

  // Groups a category's items by vendor -- vendor name + project count +
  // summed Estimated/Applied/Over amount as the primary row, expanding to
  // the individual projects underneath (Krista: same drill-down idea the
  // Vendor cost analysis section already uses, but inline on this table).
  function renderVendorGroupedTable(cat, sorted) {
    const groups = new Map();
    for (const w of sorted) {
      const key = w.vendorName || "No vendor matched";
      if (!groups.has(key)) groups.set(key, { vendorName: key, items: [] });
      groups.get(key).items.push(w);
    }
    const groupList = [...groups.values()]
      .map((g) => ({
        ...g,
        totals: cat.columns.map((c) => g.items.reduce((sum, w) => sum + (Number(c.get(w)) || 0), 0)),
      }))
      .sort((a, b) => b.totals[cat.columns.length - 1] - a.totals[cat.columns.length - 1]);

    if (groupList.length === 0) {
      return `<table class="detail-table cost-table"><tbody><tr><td><p class="empty-note">${escapeHtml(cat.emptyNote)}</p></td></tr></tbody></table>`;
    }

    return `
      <table class="detail-table cost-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th># Projects</th>
            ${cat.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${groupList
            .map((g) => {
              const expanded = expandedCostVendors.has(g.vendorName);
              const groupRow = `
                <tr class="cost-vendor-group-row" data-vendor-key="${escapeHtml(g.vendorName)}">
                  <td>${escapeHtml(g.vendorName)}</td>
                  <td>${g.items.length}</td>
                  ${cat.columns
                    .map((c, i) => {
                      const toneClass = c.tone === "ok" ? "cost-amount-ok" : c.tone === "danger" ? "cost-amount-danger" : "";
                      return `<td class="${toneClass}">$${formatMoney(g.totals[i])}</td>`;
                    })
                    .join("")}
                  <td class="cost-row-chevron">${expanded ? "▼" : "▶"}</td>
                </tr>
              `;
              const childRows = expanded
                ? g.items
                    .map(
                      (w) => `
                <tr class="cost-row cost-row-nested" data-code="${escapeHtml(w.code)}">
                  <td class="cost-nested-project">${escapeHtml(w.description || w.code)}</td>
                  <td class="wom-code">${escapeHtml(w.code)}</td>
                  ${cat.columns.map((c) => renderCostColumnCell(c, w)).join("")}
                  <td class="cost-row-chevron">&rsaquo;</td>
                </tr>
              `
                    )
                    .join("")
                : "";
              return groupRow + childRows;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  // Financials row click -> a read-only summary (WOM #, location, this
  // category's own estimated/applied/over-or-remaining figures) -- not the
  // full editable "Open Project" form. Krista: Financials should only ever
  // reflect numbers, never double as a place to edit project info.
  function openCostDetailModal(w, cat, locationByCode) {
    const location = w.locationCode ? locationByCode[w.locationCode] : null;
    const rows = cat.columns
      .map((c) => {
        const v = c.get(w);
        if (c.type === "reclass") {
          return `<tr><th>${escapeHtml(c.label)}</th><td>${v ? `Reclassed (#${v.id})` : "Unknown"}</td></tr>`;
        }
        if (c.isText || c.type === "number") return `<tr><th>${escapeHtml(c.label)}</th><td>${escapeHtml(v)}</td></tr>`;
        return `<tr><th>${escapeHtml(c.label)}</th><td>$${formatMoney(v)}</td></tr>`;
      })
      .join("");
    // Remaining Toyota PO is the one category whose row can represent more
    // than one real PO -- list each one's own number/amount/status exactly
    // as tracked, rather than collapsing them into the single summed total
    // above (which is all the main row has room for).
    const poListHtml =
      Array.isArray(w.pos) && w.pos.length > 0
        ? `
        <h4>Toyota POs</h4>
        <table class="detail-table">
          <thead><tr><th>PO #</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            ${w.pos
              .map((p) => `<tr><td>${escapeHtml(p.poNumber || "—")}</td><td>$${formatMoney(p.amount)}</td><td>${escapeHtml(p.status || "—")}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      `
        : "";
    const { body, close } = openModal({
      title: w.description || w.code,
      bodyHtml: `
        <table class="detail-table">
          <tbody>
            <tr><th>WOM #</th><td>${escapeHtml(w.code)}</td></tr>
            <tr><th>Location</th><td>${location ? escapeHtml(location.name) : w.locationCode ? escapeHtml(w.locationCode) : "No location on file"}</td></tr>
            ${rows}
          </tbody>
        </table>
        ${poListHtml}
        <button type="button" class="btn btn-link cost-detail-open-profile">Open full profile &rarr;</button>
      `,
    });
    body.querySelector(".cost-detail-open-profile").addEventListener("click", () => {
      close();
      openWomProfile(w.code);
    });
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
      detail.querySelector(".wom-lookup-open-profile").addEventListener("click", () => openWomProfile(wom.code));
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
          <button type="button" class="btn btn-link wom-lookup-open-profile">View full profile &rarr;</button>
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
