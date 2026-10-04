import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { renderTechWeek } from "./techWeek.js";
import { renderAttachments } from "./attachments.js";
import { renderSchedule } from "./schedule.js";
import { renderTaskBoard } from "./tasks.js";
import { WOM_REQUEST_FORM_URL, CW_PO_REQUEST_FORM_URL } from "../constants.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { openModal, closeModal } from "../modal.js";

const WOM_STATUS_LABELS = { open: "Open", invoiced: "Invoiced", closed: "Closed" };
const WOM_STATUS_BADGE_CLASS = { open: "approved", invoiced: "submitted", closed: "rejected" };

function formatMoney(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Technician's own view: their weekly allocation, plus read-only tabs for
 * Locations & WOM (so they can see what's out there and what they've worked
 * on historically, without being able to add/edit/close anything) and their
 * own Forms/Documents (view only -- they can't upload or delete here; an
 * admin manages those from the Technicians tab).
 */
export async function renderTechHome(container, navHost, topbarHost, subtabHost) {
  let activeTab = "week";
  const TECH_TABS = [
    ["mywork", "My Work"],
    ["week", "My Week"],
    ["schedule", "Schedule"],
    ["locations", "Locations &amp; WOM"],
    ["vendors", "Vendors"],
    ["documents", "My Documents"],
  ];

  draw();

  async function draw() {
    navHost.innerHTML = TECH_TABS.map(
      ([key, label]) => `<button class="sidebar-nav-item ${activeTab === key ? "active" : ""}" data-tab="${key}"><span>${label}</span></button>`
    ).join("");
    navHost.querySelectorAll(".sidebar-nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        draw();
      });
    });

    container.innerHTML = `<div id="tab-content" class="tab-content"></div>`;
    // Only My Week has its own page-context picker (the week nav) -- see
    // the matching reset in adminReview.js's draw(). The tech view's top-
    // level tabs are already the sidebar nav, so there's never a sub-tab
    // row for the gray band here.
    topbarHost.innerHTML = "";
    subtabHost.innerHTML = "";

    const content = container.querySelector("#tab-content");
    // Same shared loading state as the admin view's draw() -- every tab
    // here fetches before rendering, so this covers all of them for free.
    const loadingLabels = { mywork: "My Work", week: "My Week", schedule: "Schedule", locations: "Locations & WOM", vendors: "Vendors", documents: "My Documents" };
    renderLoadingState(content, loadingLabelFor(loadingLabels[activeTab] || "content"));
    if (activeTab === "mywork") await renderTaskBoard(content);
    else if (activeTab === "schedule") await renderSchedule(content);
    else if (activeTab === "locations") await drawLocationsAndWoms(content);
    else if (activeTab === "vendors") await drawApprovedVendors(content);
    else if (activeTab === "documents") await drawMyDocuments(content);
    else await renderTechWeek(content, undefined, topbarHost);
  }

  // Deliberately not the same list the admin Vendors tab shows: this is
  // only vendors cleared to actually use (server-side filtered in
  // server/routes/vendorLookup.js on cwStatus/toyotaStatus/formsStatus,
  // plus excluding a vendor actively denied in a case recheck) -- a
  // vendor that isn't active/approved, has outdated forms, or was just
  // denied is left off entirely rather than shown with a different badge,
  // since a vendor just *appearing* here reads as "this is fine to use."
  function splitServices(raw) {
    return (raw || "").split("|").map((s) => s.trim()).filter(Boolean);
  }

  async function drawApprovedVendors(content) {
    const vendors = await api.get("/api/vendors");
    content.innerHTML = `
      <p class="review-checklist-hint">
        Vendors cleared to use right now. One still being onboarded, or one with a compliance issue
        to sort out, won't show up here yet -- ask an admin if you don't see one you're expecting.
      </p>
      <input class="tech-vendor-search" type="text" placeholder="Vendor name or service" />
      <p class="vendor-count"></p>
      <div class="review-list" id="tech-vendor-list"></div>
    `;
    const countEl = content.querySelector(".vendor-count");
    const listEl = content.querySelector("#tech-vendor-list");

    // Other approved vendors sharing at least one service with this one --
    // a quick "who else could I call for this" list, right next to the
    // vendor itself instead of a separate search.
    function similarVendors(v) {
      const myServices = new Set(splitServices(v.services));
      if (myServices.size === 0) return [];
      return vendors
        .filter((other) => other.id !== v.id && splitServices(other.services).some((s) => myServices.has(s)))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    function renderList(query) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? vendors.filter((v) => v.name.toLowerCase().includes(q) || (v.services || "").toLowerCase().includes(q))
        : vendors;
      countEl.textContent = `${matches.length} vendor${matches.length === 1 ? "" : "s"}.`;
      if (matches.length === 0) {
        listEl.innerHTML = `<p class="empty-note">No approved vendors match.</p>`;
        return;
      }
      listEl.innerHTML = "";
      matches
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((v) => {
          const similar = similarVendors(v);
          const row = document.createElement("div");
          row.className = "review-row";
          row.innerHTML = `
            <div class="review-row-summary">
              <span class="review-row-name">${escapeHtml(v.name)}</span>
              ${v.services ? `<span class="wom-desc">${escapeHtml(splitServices(v.services).join(", "))}</span>` : ""}
              ${v.phone ? `<span class="vendor-jde">${escapeHtml(v.phone)}</span>` : ""}
              ${v.email ? `<span class="vendor-jde">${escapeHtml(v.email)}</span>` : ""}
              <span class="wom-desc">Last invoiced: ${v.lastInvoicedAt ? new Date(v.lastInvoicedAt).toLocaleDateString() : "not yet"}</span>
              <button type="button" class="btn btn-link tech-vendor-schedule-btn">Schedule work &rarr;</button>
            </div>
            ${
              similar.length > 0
                ? `<div class="attachment-subtext">Other vendors for similar work: ${similar.map((s) => escapeHtml(s.name)).join(", ")}</div>`
                : ""
            }
          `;
          row.querySelector(".tech-vendor-schedule-btn").addEventListener("click", () => {
            activeTab = "schedule";
            draw();
          });
          listEl.appendChild(row);
        });
    }

    renderList("");
    content.querySelector(".tech-vendor-search").addEventListener("input", (e) => renderList(e.target.value));
  }

  async function drawLocationsAndWoms(content) {
    const [locations, allWoms] = await Promise.all([api.get("/api/locations"), api.get("/api/woms")]);
    // Pending/requested WOMs have no real WOM # yet -- nothing to look up
    // or charge time to, so they're left out of this reference list.
    const woms = allWoms.filter((w) => w.status !== "pending" && w.status !== "requested");
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    content.innerHTML = `
      <div class="review-actions">
        <a class="btn btn-secondary" href="${WOM_REQUEST_FORM_URL}" target="_blank" rel="noopener">Request a new WOM ↗</a>
        <button type="button" class="btn btn-secondary tech-request-po-btn">Request a C&amp;W PO ↗</button>
      </div>
      <p class="review-checklist-hint">
        The lists below are view only -- for anything else (a location, or changing an existing WOM), ask an admin.
      </p>
      <h3>Locations</h3>
      <div class="review-list" id="tech-location-list"></div>
      <h3>WOM Projects (including past/closed)</h3>
      <div class="review-list" id="tech-wom-list"></div>
    `;

    content.querySelector(".tech-request-po-btn").addEventListener("click", openRequestCwPoModal);

    const locationList = content.querySelector("#tech-location-list");
    if (locations.length === 0) {
      locationList.innerHTML = `<p class="empty-note">No locations on file.</p>`;
    } else {
      locations.forEach((l) => {
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(l.name)}</span>
            ${l.region ? `<span class="wom-desc">${escapeHtml(l.region)}</span>` : ""}
          </div>
        `;
        locationList.appendChild(row);
      });
    }

    const womList = content.querySelector("#tech-wom-list");
    if (woms.length === 0) {
      womList.innerHTML = `<p class="empty-note">No WOM projects on file.</p>`;
    } else {
      woms.forEach((w) => {
        const loc = locationByCode[w.locationCode];
        const budgetLabel = w.budgetHours == null ? "" : ` &middot; ${w.remainingHours}h left of ${w.budgetHours}h`;
        const row = document.createElement("div");
        row.className = "review-row";
        row.innerHTML = `
          <div class="review-row-summary">
            <span class="review-row-name">${escapeHtml(w.code)} <span class="wom-desc">${escapeHtml(w.description)}${loc ? ` &middot; ${escapeHtml(loc.name)}` : ""}${budgetLabel}</span></span>
            <span class="badge badge-${WOM_STATUS_BADGE_CLASS[w.status] || "draft"}">${escapeHtml(WOM_STATUS_LABELS[w.status] || w.status)}</span>
            <button class="btn btn-link wom-lookup-toggle" type="button">Details</button>
          </div>
          <div class="review-row-detail tech-wom-detail" hidden></div>
        `;
        // Lazy-loaded (and cached per row) rather than fetched for every WOM
        // up front -- who's logged hours against a project and its pricing
        // is only worth a round trip once someone actually wants to see it.
        const toggleBtn = row.querySelector(".wom-lookup-toggle");
        const detail = row.querySelector(".tech-wom-detail");
        let loaded = false;
        toggleBtn.addEventListener("click", async () => {
          detail.hidden = !detail.hidden;
          toggleBtn.textContent = detail.hidden ? "Details" : "Hide";
          if (!detail.hidden && !loaded) {
            loaded = true;
            detail.innerHTML = `<p class="review-checklist-hint">Loading…</p>`;
            const lookup = await api.get(`/api/woms/${encodeURIComponent(w.code)}/lookup`);
            detail.innerHTML = renderWomLookupDetail(lookup);
          }
        });
        womList.appendChild(row);
      });
    }
  }

  // The "Request a C&W PO" button used to just open the Smartsheet form
  // with nothing tracked on this end -- this asks the one question that
  // actually matters (which admin should generate it) so there's a real
  // task to chase, then still opens the same external form right after,
  // same as before. No WOM to pick -- a PO request doesn't have to tie to
  // one.
  async function openRequestCwPoModal() {
    let admins;
    try {
      admins = await api.get("/api/tasks/assignable-admins");
    } catch (err) {
      alert(err.message || "Couldn't load the admin list.");
      return;
    }
    const { body } = openModal({
      title: "Request a C&W PO",
      bodyHtml: `
        <form class="modal-form request-po-form">
          <label class="profile-field">
            <span>Which admin should generate it?</span>
            <select name="assignedTo" required>
              <option value="">Select an admin...</option>
              ${admins.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("")}
            </select>
          </label>
          <label class="profile-field">
            <span>Note (optional)</span>
            <textarea name="note" rows="3" placeholder="What's this PO for?"></textarea>
          </label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Submit Task</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".request-po-form");
    // This form's only fields are a <select> and a <textarea> -- neither
    // one implicitly submits a form on Enter the way a text <input> does
    // (confirmed: Chromium just leaves the dropdown sitting there), so
    // without this a user who picks the admin and hits Enter sees nothing
    // happen and no task gets created. Skip it inside the textarea, where
    // Enter should still just add a line break.
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      try {
        const created = await api.post("/api/tasks/request-po", {
          assignedTo: form.assignedTo.value,
          note: form.note.value.trim(),
        });
        renderRequestPoConfirmation(body, created);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // Swapping straight to Smartsheet the instant the task was created made
  // the whole thing feel like it hadn't done anything -- no visible
  // confirmation the task actually exists before the tab changes out from
  // under you. This pauses on an explicit confirmation step instead, with
  // a reference # to hand to whoever fills out the Smartsheet form (put it
  // in that form's Description field) so the real PO can be matched back
  // to this task later -- there's no automatic link between the two, this
  // is the only thread connecting them.
  function renderRequestPoConfirmation(body, task) {
    const reference = `PO Request Task #${task.id}`;
    body.innerHTML = `
      <div class="request-po-confirmation">
        <p class="review-checklist-hint">✓ Task submitted successfully.</p>
        <div class="request-po-reference-callout">
          <p class="request-po-reference-instruction">COPY AND PASTE THIS NUMBER INTO THE DESCRIPTION OF THE PO REQUEST FORM:</p>
          <div class="request-po-reference-row">
            <span class="request-po-reference-number">${escapeHtml(reference)}</span>
            <button type="button" class="btn btn-secondary request-po-copy-btn">Copy</button>
          </div>
        </div>
        <div class="modal-form-actions">
          <button type="button" class="btn btn-primary request-po-continue-btn">Continue to the PO form ↗</button>
          <button type="button" class="btn btn-secondary request-po-done-btn">Done</button>
        </div>
      </div>
    `;
    const copyBtn = body.querySelector(".request-po-copy-btn");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(reference);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      } catch {
        window.prompt("Copy this reference:", reference);
      }
    });
    body.querySelector(".request-po-continue-btn").addEventListener("click", () => {
      window.open(CW_PO_REQUEST_FORM_URL, "_blank", "noopener");
    });
    body.querySelector(".request-po-done-btn").addEventListener("click", closeModal);
  }

  // Total hours worked and posted pricing for a WOM, all-time -- same data
  // and endpoint the admin's own WOM Lookup sub-tab uses, just presented
  // inline here since a technician's Locations & WOM list already has each
  // WOM's row to expand rather than a separate lookup screen of its own.
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
      <div class="wom-lookup-stats">
        <div><span class="wom-lookup-stat-label">Hours</span>${hoursLine}</div>
        <div><span class="wom-lookup-stat-label">Estimated</span>$${formatMoney(wom.estimatedPrice)}</div>
        <div><span class="wom-lookup-stat-label">Applied (posted)</span>$${formatMoney(wom.appliedPrice)}</div>
      </div>
      ${byTech}
    `;
  }

  async function drawMyDocuments(content) {
    content.innerHTML = `<div id="tech-forms-host"></div><div id="tech-docs-host"></div>`;
    await renderAttachments(content.querySelector("#tech-forms-host"), {
      title: "My Forms & Certifications",
      relatedType: "technician",
      relatedId: state.user.id,
      categories: [{ value: "tech_form", label: "Form / Certification" }],
      canUpload: false,
      emptyText: "No forms on file.",
      trackExpiration: true,
    });
    await renderAttachments(content.querySelector("#tech-docs-host"), {
      title: "My Documents",
      relatedType: "technician",
      relatedId: state.user.id,
      categories: [{ value: "document", label: "Document" }],
      canUpload: false,
      emptyText: "No documents on file.",
    });
  }
}
