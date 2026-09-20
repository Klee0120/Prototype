import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderAttachments } from "./attachments.js";

const PROFILE_TABS = [
  { key: "basic", label: "Basic Info" },
  { key: "history", label: "Labor Allocation History" },
  { key: "onboarding", label: "Onboarding" },
  { key: "devices", label: "Devices" },
  { key: "forms", label: "Forms on File" },
  { key: "documents", label: "Documents" },
];

const TIME_OFF_LABELS = { vacation: "Vacation", sick: "Sick", bereavement: "Bereavement", holiday: "Holiday" };

/** Manages its own roster-list vs. profile-detail state inside `content`. */
export function renderTechniciansTab(content) {
  let profileTechId = null;
  let profileSubTab = "basic";
  const filters = { location: "", status: "active" };

  draw();

  async function draw() {
    if (profileTechId) await drawProfile();
    else await drawRoster();
  }

  async function drawRoster() {
    const [techs, locations] = await Promise.all([api.get("/api/admin/technicians"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    const filtered = techs.filter((t) => {
      if (filters.location && t.homeLocationCode !== filters.location) return false;
      if (filters.status === "active" && !t.active) return false;
      if (filters.status === "inactive" && t.active) return false;
      return true;
    });

    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");

    content.innerHTML = `
      <div class="roster-filters">
        <label class="roster-filter-field">
          <span>Location</span>
          <select class="roster-location-filter">
            <option value="">All</option>
            ${locationOptions}
          </select>
        </label>
        <label class="roster-filter-field">
          <span>Status</span>
          <select class="roster-status-filter">
            <option value="active" ${filters.status === "active" ? "selected" : ""}>Active</option>
            <option value="inactive" ${filters.status === "inactive" ? "selected" : ""}>Inactive</option>
            <option value="all" ${filters.status === "all" ? "selected" : ""}>All</option>
          </select>
        </label>
      </div>
      <div class="roster-table-wrap">
        <table class="detail-table roster-table">
          <thead><tr><th>Name</th><th>UKG ID</th><th>Position</th><th>Location</th><th>Status</th></tr></thead>
          <tbody>
            ${filtered
              .map(
                (t) => `
              <tr class="roster-row" data-id="${t.id}">
                <td>${escapeHtml(t.name)}</td>
                <td>${escapeHtml(t.ukgId || "—")}</td>
                <td>${escapeHtml(t.position || "—")}</td>
                <td>${escapeHtml((locationByCode[t.homeLocationCode] && locationByCode[t.homeLocationCode].name) || "—")}</td>
                <td><span class="badge badge-${t.active ? "approved" : "rejected"}">${t.active ? "Active" : "Inactive"}</span></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        ${filtered.length === 0 ? `<p class="empty-note">No technicians match these filters.</p>` : ""}
      </div>
    `;

    content.querySelector(".roster-location-filter").addEventListener("change", (e) => {
      filters.location = e.target.value;
      draw();
    });
    content.querySelector(".roster-status-filter").addEventListener("change", (e) => {
      filters.status = e.target.value;
      draw();
    });
    content.querySelectorAll(".roster-row").forEach((row) => {
      row.addEventListener("click", () => {
        profileTechId = row.dataset.id;
        profileSubTab = "basic";
        draw();
      });
    });
  }

  async function drawProfile() {
    const tech = await api.get(`/api/admin/technicians/${profileTechId}`);

    content.innerHTML = `
      <button class="btn btn-link back-to-roster" type="button">&larr; Back to roster</button>
      <div class="profile-header">
        <div class="profile-name">${escapeHtml(tech.name)}</div>
        <span class="badge badge-draft">${escapeHtml(tech.id)}</span>
        <span class="badge badge-${tech.active ? "approved" : "rejected"}">${tech.active ? "Active" : "Inactive"}</span>
      </div>
      <div class="profile-tabs">
        ${PROFILE_TABS.map((t) => `<button class="profile-tab ${profileSubTab === t.key ? "active" : ""}" data-tab="${t.key}" type="button">${t.label}</button>`).join("")}
      </div>
      <div class="profile-tab-content"></div>
    `;

    content.querySelector(".back-to-roster").addEventListener("click", () => {
      profileTechId = null;
      draw();
    });
    content.querySelectorAll(".profile-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        profileSubTab = btn.dataset.tab;
        draw();
      });
    });

    const tabContent = content.querySelector(".profile-tab-content");
    if (profileSubTab === "basic") await drawBasicInfo(tabContent, tech);
    else if (profileSubTab === "history") await drawHistory(tabContent, tech);
    else if (profileSubTab === "onboarding") await drawOnboarding(tabContent, tech);
    else if (profileSubTab === "devices") await drawDevices(tabContent, tech);
    else if (profileSubTab === "forms") await drawForms(tabContent, tech);
    else await drawDocuments(tabContent, tech);
  }

  async function drawBasicInfo(tabContent, tech) {
    const locations = await api.get("/api/locations");
    const locationOptions = locations
      .map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === tech.homeLocationCode ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");

    tabContent.innerHTML = `
      <form class="basic-info-form">
        <label class="profile-field"><span>Name</span><input value="${escapeHtml(tech.name)}" disabled /></label>
        <label class="profile-field"><span>Email</span><input name="email" value="${escapeHtml(tech.email || "")}" /></label>
        <label class="profile-field"><span>Phone</span><input name="phone" value="${escapeHtml(tech.phone || "")}" /></label>
        <label class="profile-field"><span>UKG ID</span><input name="ukgId" value="${escapeHtml(tech.ukgId || "")}" /></label>
        <label class="profile-field"><span>Position</span><input name="position" value="${escapeHtml(tech.position || "")}" /></label>
        <label class="profile-field">
          <span>Home location</span>
          <select name="homeLocationCode"><option value="">No home location</option>${locationOptions}</select>
        </label>
        <label class="profile-field">
          <span>Status</span>
          <select name="active">
            <option value="true" ${tech.active ? "selected" : ""}>Active</option>
            <option value="false" ${!tech.active ? "selected" : ""}>Inactive</option>
          </select>
        </label>
        <button type="submit" class="btn btn-primary">Save</button>
        <span class="save-message basic-info-message"></span>
      </form>
    `;

    tabContent.querySelector(".basic-info-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = form.querySelector(".basic-info-message");
      try {
        await api.patch(`/api/admin/technicians/${tech.id}/basic-info`, {
          email: form.email.value.trim(),
          phone: form.phone.value.trim(),
          ukgId: form.ukgId.value.trim(),
          position: form.position.value.trim(),
        });
        await api.patch(`/api/admin/technicians/${tech.id}/home-location`, { locationCode: form.homeLocationCode.value || null });
        await api.patch(`/api/admin/technicians/${tech.id}/active`, { active: form.active.value === "true" });
        msg.textContent = "Saved.";
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function describeHistoryRow(row, locationByCode) {
    if (row.type === "timeoff") return `Time off — ${TIME_OFF_LABELS[row.womCode] || row.womCode}`;
    if (row.type === "wom") return row.womCode;
    const loc = locationByCode[row.locationCode];
    return `E&F — ${loc ? loc.name : row.locationCode}`;
  }

  async function drawHistory(tabContent, tech) {
    const [history, locations] = await Promise.all([
      api.get(`/api/admin/technicians/${tech.id}/history`),
      api.get("/api/locations"),
    ]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));

    if (history.length === 0) {
      tabContent.innerHTML = `<p class="empty-note">No allocation history yet.</p>`;
      return;
    }

    tabContent.innerHTML = `
      <div class="roster-table-wrap">
        <table class="detail-table">
          <thead><tr><th>Week</th><th>Day</th><th>Allocation</th><th>Hours</th><th>Week status</th></tr></thead>
          <tbody>
            ${history
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(r.weekMonday)}</td>
                <td>${r.day}</td>
                <td>${escapeHtml(describeHistoryRow(r, locationByCode))}</td>
                <td>${r.hours}h</td>
                <td><span class="badge badge-${r.weekStatus}">${r.weekStatus}</span></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  async function drawOnboarding(tabContent, tech) {
    const tasks = await api.get(`/api/admin/technicians/${tech.id}/onboarding`);
    tabContent.innerHTML = `
      <div class="onboarding-list">
        ${tasks
          .map(
            (t) => `
          <label class="onboarding-item">
            <input type="checkbox" data-key="${t.key}" ${t.completedAt ? "checked" : ""} />
            <span>${escapeHtml(t.label)}</span>
            ${t.completedAt ? `<span class="onboarding-date">${new Date(t.completedAt).toLocaleDateString()}</span>` : ""}
          </label>`
          )
          .join("")}
      </div>
    `;
    tabContent.querySelectorAll("input[data-key]").forEach((input) => {
      input.addEventListener("change", async () => {
        await api.patch(`/api/admin/technicians/${tech.id}/onboarding/${input.dataset.key}`, { completed: input.checked });
        await drawOnboarding(tabContent, tech);
      });
    });
  }

  async function drawDevices(tabContent, tech) {
    const devices = await api.get(`/api/admin/technicians/${tech.id}/devices`);
    tabContent.innerHTML = `
      <div class="device-list">
        ${
          devices.length === 0
            ? `<p class="empty-note">No devices assigned.</p>`
            : devices
                .map(
                  (d) => `
              <div class="device-row">
                <div>
                  <div class="device-name">${escapeHtml(d.deviceName)}</div>
                  <div class="device-meta">${escapeHtml(d.notes || "")} &middot; assigned ${new Date(d.assignedAt).toLocaleDateString()}</div>
                </div>
                <button class="btn btn-link danger-link remove-device" data-id="${d.id}" type="button">Remove</button>
              </div>`
                )
                .join("")
        }
      </div>
      <form class="add-device-form">
        <input name="deviceName" placeholder="Device name" required />
        <input name="notes" placeholder="Notes (optional)" />
        <button type="submit" class="btn btn-secondary">Assign device</button>
      </form>
    `;
    tabContent.querySelectorAll(".remove-device").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api.delete(`/api/admin/technicians/${tech.id}/devices/${btn.dataset.id}`);
        await drawDevices(tabContent, tech);
      });
    });
    tabContent.querySelector(".add-device-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      await api.post(`/api/admin/technicians/${tech.id}/devices`, {
        deviceName: form.deviceName.value.trim(),
        notes: form.notes.value.trim(),
      });
      await drawDevices(tabContent, tech);
    });
  }

  async function drawForms(tabContent, tech) {
    await renderAttachments(tabContent, {
      title: "Forms & Certifications",
      relatedType: "technician",
      relatedId: tech.id,
      categories: [{ value: "tech_form", label: "Form / Certification" }],
      canUpload: true,
      emptyText: "No forms on file.",
    });
  }

  async function drawDocuments(tabContent, tech) {
    await renderAttachments(tabContent, {
      title: "Documents",
      relatedType: "technician",
      relatedId: tech.id,
      categories: [{ value: "document", label: "Document" }],
      canUpload: true,
      emptyText: "No documents on file.",
    });
  }
}
