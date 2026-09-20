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

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "terminated", label: "Terminated" },
  { value: "retired", label: "Retired" },
];

const STATUS_BADGE_CLASS = { active: "approved", inactive: "draft", terminated: "rejected", retired: "submitted" };

function statusBadge(status) {
  const cls = STATUS_BADGE_CLASS[status] || "draft";
  const label = (STATUS_OPTIONS.find((o) => o.value === status) || {}).label || status;
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

/** Manages its own roster-list vs. profile-detail state inside `content`. */
export function renderTechniciansTab(content) {
  let profileTechId = null;
  let profileSubTab = "basic";
  let showAddForm = false;
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
      if (filters.status !== "all" && t.employmentStatus !== filters.status) return false;
      return true;
    });

    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    const statusFilterOptions = STATUS_OPTIONS.map(
      (o) => `<option value="${o.value}" ${filters.status === o.value ? "selected" : ""}>${o.label}</option>`
    ).join("");

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
            ${statusFilterOptions}
            <option value="all" ${filters.status === "all" ? "selected" : ""}>All</option>
          </select>
        </label>
        <button class="btn btn-secondary add-technician-toggle" type="button">${showAddForm ? "Cancel" : "+ Add technician"}</button>
      </div>
      ${showAddForm ? renderAddForm(locations) : ""}
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
                <td>${statusBadge(t.employmentStatus)}</td>
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
    content.querySelector(".add-technician-toggle").addEventListener("click", () => {
      showAddForm = !showAddForm;
      draw();
    });
    const addForm = content.querySelector(".add-technician-form");
    if (addForm) wireAddForm(addForm);
    content.querySelectorAll(".roster-row").forEach((row) => {
      row.addEventListener("click", () => {
        profileTechId = row.dataset.id;
        profileSubTab = "basic";
        draw();
      });
    });
  }

  function renderAddForm(locations) {
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    return `
      <form class="add-technician-form">
        <div class="add-tech-grid">
          <input name="id" placeholder="ID (e.g. T1004)" required />
          <input name="name" placeholder="Full name" required />
          <input name="pin" placeholder="PIN" required inputmode="numeric" />
          <input name="position" placeholder="Position" />
          <select name="homeLocationCode"><option value="">No home location</option>${locationOptions}</select>
          <input name="email" placeholder="Email" type="email" />
          <input name="phone" placeholder="Phone" />
          <input name="ukgId" placeholder="UKG ID" />
        </div>
        <button type="submit" class="btn btn-primary">Create technician</button>
        <span class="save-message add-tech-message"></span>
      </form>
    `;
  }

  function wireAddForm(form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".add-tech-message");
      try {
        await api.post("/api/admin/technicians", {
          id: form.id.value.trim(),
          name: form.name.value.trim(),
          pin: form.pin.value.trim(),
          homeLocationCode: form.homeLocationCode.value || null,
          email: form.email.value.trim(),
          phone: form.phone.value.trim(),
          ukgId: form.ukgId.value.trim(),
          position: form.position.value.trim(),
        });
        showAddForm = false;
        await draw();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  async function drawProfile() {
    const tech = await api.get(`/api/admin/technicians/${profileTechId}`);

    content.innerHTML = `
      <button class="btn btn-link back-to-roster" type="button">&larr; Back to roster</button>
      <div class="profile-header">
        <div class="profile-name">${escapeHtml(tech.name)}</div>
        <span class="badge badge-draft">${escapeHtml(tech.id)}</span>
        ${statusBadge(tech.employmentStatus)}
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
    const statusOptions = STATUS_OPTIONS.map(
      (o) => `<option value="${o.value}" ${tech.employmentStatus === o.value ? "selected" : ""}>${o.label}</option>`
    ).join("");

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
          <select name="employmentStatus">${statusOptions}</select>
        </label>
        <button type="submit" class="btn btn-primary">Save</button>
        <span class="save-message basic-info-message"></span>
      </form>
    `;

    const form = tabContent.querySelector(".basic-info-form");
    const original = {
      homeLocationCode: tech.homeLocationCode || "",
      employmentStatus: tech.employmentStatus,
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".basic-info-message");
      msg.textContent = "";
      try {
        await api.patch(`/api/admin/technicians/${tech.id}/basic-info`, {
          email: form.email.value.trim(),
          phone: form.phone.value.trim(),
          ukgId: form.ukgId.value.trim(),
          position: form.position.value.trim(),
        });
        if (form.homeLocationCode.value !== original.homeLocationCode) {
          await api.patch(`/api/admin/technicians/${tech.id}/home-location`, { locationCode: form.homeLocationCode.value || null });
          original.homeLocationCode = form.homeLocationCode.value;
        }
        if (form.employmentStatus.value !== original.employmentStatus) {
          await api.patch(`/api/admin/technicians/${tech.id}/employment-status`, { status: form.employmentStatus.value });
          original.employmentStatus = form.employmentStatus.value;
        }
        msg.textContent = "Saved.";
      } catch (err) {
        // Revert the fields we couldn't confirm were saved, so the form
        // never shows a value that isn't actually persisted.
        form.homeLocationCode.value = original.homeLocationCode;
        form.employmentStatus.value = original.employmentStatus;
        msg.textContent = `Not saved: ${err.message}`;
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
      <p class="onboarding-error" hidden></p>
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
    const errorEl = tabContent.querySelector(".onboarding-error");
    tabContent.querySelectorAll("input[data-key]").forEach((input) => {
      input.addEventListener("change", async () => {
        const intended = input.checked;
        errorEl.hidden = true;
        try {
          await api.patch(`/api/admin/technicians/${tech.id}/onboarding/${input.dataset.key}`, { completed: intended });
          await drawOnboarding(tabContent, tech);
        } catch (err) {
          input.checked = !intended; // revert — the save didn't actually go through
          errorEl.textContent = `Not saved: ${err.message}`;
          errorEl.hidden = false;
        }
      });
    });
  }

  const DEVICE_TYPE_LABELS = { phone: "Phone", laptop: "Laptop" };
  const DEVICE_IDENTIFIER_PLACEHOLDER = { phone: "Phone number", laptop: "Asset tag / serial" };

  async function drawDevices(tabContent, tech) {
    const devices = await api.get(`/api/admin/technicians/${tech.id}/devices`);
    tabContent.innerHTML = `
      <p class="device-error" hidden></p>
      <div class="device-list">
        ${
          devices.length === 0
            ? `<p class="empty-note">No devices assigned.</p>`
            : devices.map((d) => renderDeviceRow(d)).join("")
        }
      </div>
      <form class="add-device-form">
        <select name="deviceType">
          <option value="phone">Phone</option>
          <option value="laptop">Laptop</option>
        </select>
        <input name="deviceName" placeholder="${DEVICE_IDENTIFIER_PLACEHOLDER.phone}" required />
        <input name="notes" placeholder="Notes (optional)" />
        <button type="submit" class="btn btn-secondary">Assign device</button>
      </form>
    `;

    function renderDeviceRow(d) {
      return `
        <div class="device-row">
          <div class="device-row-main">
            <div>
              <span class="device-type-badge">${escapeHtml(DEVICE_TYPE_LABELS[d.deviceType] || d.deviceType)}</span>
              <span class="device-name">${escapeHtml(d.deviceName)}</span>
              <div class="device-meta">${escapeHtml(d.notes || "")}${d.notes ? " &middot; " : ""}assigned ${new Date(d.assignedAt).toLocaleDateString()}</div>
            </div>
            <button class="btn btn-link danger-link remove-device" data-id="${d.id}" type="button">Remove</button>
          </div>
          <div class="device-requests">
            <div class="device-requests-title">IT Requests (e.g. Calero)</div>
            ${
              d.requests.length === 0
                ? `<p class="empty-note">No requests logged.</p>`
                : d.requests
                    .map(
                      (r) => `
                  <div class="device-request-row">
                    <span class="device-request-type">${escapeHtml(r.requestType)}${r.referenceNumber ? ` &mdash; #${escapeHtml(r.referenceNumber)}` : ""}</span>
                    <span class="badge ${r.completedAt ? "badge-approved" : "badge-draft"}">${r.completedAt ? "Completed" : "Pending"}</span>
                    <button class="btn btn-link toggle-request-btn" type="button" data-device-id="${d.id}" data-request-id="${r.id}" data-completed="${Boolean(r.completedAt)}">
                      ${r.completedAt ? "Reopen" : "Mark completed"}
                    </button>
                  </div>`
                    )
                    .join("")
            }
            <form class="add-request-form" data-device-id="${d.id}">
              <input name="requestType" placeholder="Request type (e.g. Cancellation)" required />
              <input name="referenceNumber" placeholder="Reference #" />
              <button type="submit" class="btn btn-link">+ Add request</button>
            </form>
          </div>
        </div>`;
    }

    const errorEl = tabContent.querySelector(".device-error");

    tabContent.querySelector('select[name="deviceType"]').addEventListener("change", (e) => {
      tabContent.querySelector('input[name="deviceName"]').placeholder = DEVICE_IDENTIFIER_PLACEHOLDER[e.target.value];
    });

    tabContent.querySelectorAll(".remove-device").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.delete(`/api/admin/technicians/${tech.id}/devices/${btn.dataset.id}`);
          await drawDevices(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Could not remove: ${err.message}`;
          errorEl.hidden = false;
        }
      });
    });

    tabContent.querySelectorAll(".toggle-request-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.patch(
            `/api/admin/technicians/${tech.id}/devices/${btn.dataset.deviceId}/requests/${btn.dataset.requestId}`,
            { completed: btn.dataset.completed !== "true" }
          );
          await drawDevices(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Could not update: ${err.message}`;
          errorEl.hidden = false;
        }
      });
    });

    tabContent.querySelectorAll(".add-request-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api.post(`/api/admin/technicians/${tech.id}/devices/${form.dataset.deviceId}/requests`, {
            requestType: form.requestType.value.trim(),
            referenceNumber: form.referenceNumber.value.trim(),
          });
          await drawDevices(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Not saved: ${err.message}`;
          errorEl.hidden = false;
        }
      });
    });

    tabContent.querySelector(".add-device-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await api.post(`/api/admin/technicians/${tech.id}/devices`, {
          deviceType: form.deviceType.value,
          deviceName: form.deviceName.value.trim(),
          notes: form.notes.value.trim(),
        });
        await drawDevices(tabContent, tech);
      } catch (err) {
        errorEl.textContent = `Not saved: ${err.message}`;
        errorEl.hidden = false;
      }
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
