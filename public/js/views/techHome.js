import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { renderTechWeek } from "./techWeek.js";
import { renderAttachments } from "./attachments.js";
import { renderSchedule } from "./schedule.js";

const WOM_STATUS_LABELS = { open: "Open", invoiced: "Invoiced", closed: "Closed" };
const WOM_STATUS_BADGE_CLASS = { open: "approved", invoiced: "submitted", closed: "rejected" };

/**
 * Technician's own view: their weekly allocation, plus read-only tabs for
 * Locations & WOM (so they can see what's out there and what they've worked
 * on historically, without being able to add/edit/close anything) and their
 * own Forms/Documents (view only -- they can't upload or delete here; an
 * admin manages those from the Technicians tab).
 */
export async function renderTechHome(container) {
  let activeTab = "week";

  draw();

  async function draw() {
    container.innerHTML = `
      <div class="tabs">
        <button class="tab ${activeTab === "week" ? "active" : ""}" data-tab="week">My Week</button>
        <button class="tab ${activeTab === "schedule" ? "active" : ""}" data-tab="schedule">Schedule</button>
        <button class="tab ${activeTab === "locations" ? "active" : ""}" data-tab="locations">Locations &amp; WOM</button>
        <button class="tab ${activeTab === "documents" ? "active" : ""}" data-tab="documents">My Documents</button>
      </div>
      <div id="tab-content" class="tab-content"></div>
    `;

    container.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        draw();
      });
    });

    const content = container.querySelector("#tab-content");
    if (activeTab === "schedule") await renderSchedule(content);
    else if (activeTab === "locations") await drawLocationsAndWoms(content);
    else if (activeTab === "documents") await drawMyDocuments(content);
    else await renderTechWeek(content);
  }

  async function drawLocationsAndWoms(content) {
    const [locations, woms] = await Promise.all([api.get("/api/locations"), api.get("/api/woms")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    content.innerHTML = `
      <p class="review-checklist-hint">View only -- for adding or changing a location or WOM project, ask an admin.</p>
      <h3>Locations</h3>
      <div class="review-list" id="tech-location-list"></div>
      <h3>WOM Projects (including past/closed)</h3>
      <div class="review-list" id="tech-wom-list"></div>
    `;

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
          </div>
        `;
        womList.appendChild(row);
      });
    }
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
