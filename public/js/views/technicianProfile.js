import { api } from "../api.js";
import { state, escapeHtml, setUser, refreshHeader } from "../app.js";
import { renderAttachments } from "./attachments.js";
import { wireDateMaskInput, usFromIso, isoFromUs } from "../dateMask.js";
import { openModal } from "../modal.js";
import { getTerritory } from "../globalFilters.js";

const PROFILE_TABS = [
  { key: "basic", label: "Basic Info" },
  { key: "history", label: "Labor Allocation History" },
  { key: "onboarding", label: "Onboarding" },
  { key: "devices", label: "Devices" },
  { key: "forms", label: "Forms on File" },
  { key: "remarks", label: "Manager Remarks" },
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

/**
 * Manages its own roster-list vs. profile-detail state inside `content`.
 * `openTo`: optional one-shot deep link, e.g. { techId, subTab } to jump
 * straight into a technician's profile on a given sub-tab (used by the
 * Overview tab's expiring-forms banner).
 */
export function renderTechniciansTab(content, openTo) {
  let profileTechId = openTo ? openTo.techId : null;
  let profileSubTab = openTo && openTo.subTab ? openTo.subTab : "basic";
  let showAdminAccounts = false;
  const adminRenaming = new Set(); // admin ids currently showing their rename field
  const revealedAdminPins = new Map(); // admin id -> freshly reset PIN, shown once until dismissed
  const filters = { location: "", status: "active" };

  draw();

  async function draw() {
    if (profileTechId) await drawProfile();
    else await drawRoster();
  }

  async function drawRoster() {
    const [techs, locations] = await Promise.all([api.get("/api/admin/technicians"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const territory = getTerritory();

    const filtered = techs.filter((t) => {
      if (filters.location && t.homeLocationCode !== filters.location) return false;
      if (territory) {
        const loc = locationByCode[t.homeLocationCode];
        if (!loc || (loc.territory || "Midwest") !== territory) return false;
      }
      if (filters.status !== "all" && t.employmentStatus !== filters.status) return false;
      return true;
    });

    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    const statusFilterOptions = STATUS_OPTIONS.map(
      (o) => `<option value="${o.value}" ${filters.status === o.value ? "selected" : ""}>${o.label}</option>`
    ).join("");

    content.innerHTML = `
      <p class="review-checklist-hint">
        Terminating or retiring someone never deletes their record -- allocation history, documents,
        and forms all stay in place. The Status filter below defaults to Active, so switch it to
        Terminated (or All) to find someone who's left.
        ${territory ? ` Showing <strong>${escapeHtml(territory)}</strong> only -- change the territory filter in the top bar to see others.` : ""}
      </p>
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
        <button class="btn btn-secondary add-technician-toggle" type="button">+ Add technician</button>
        <button class="btn btn-secondary add-admin-toggle" type="button">+ Add Admin</button>
        <button class="btn btn-secondary add-rfm-toggle" type="button">+ Add RFM</button>
        <button class="btn btn-secondary terminate-technician-toggle" type="button">Terminate employee</button>
        <button class="btn btn-link admin-accounts-toggle" type="button">${showAdminAccounts ? "Hide admin accounts" : "Manage admin accounts"}</button>
      </div>
      <div id="admin-accounts-host"></div>
      <div class="roster-table-wrap">
        <table class="detail-table roster-table">
          <thead><tr><th>Name</th><th>UKG ID</th><th>Position</th><th>Location</th><th>Territory</th><th>Status</th></tr></thead>
          <tbody>
            ${filtered
              .map(
                (t) => `
              <tr class="roster-row" data-id="${t.id}">
                <td>${escapeHtml(t.name)}</td>
                <td>${escapeHtml(t.ukgId || "—")}</td>
                <td>${escapeHtml(t.position || "—")}</td>
                <td>${escapeHtml((locationByCode[t.homeLocationCode] && locationByCode[t.homeLocationCode].name) || "—")}</td>
                <td>${escapeHtml((locationByCode[t.homeLocationCode] && locationByCode[t.homeLocationCode].territory) || "—")}</td>
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
      openAddModal(locations);
    });
    content.querySelector(".add-admin-toggle").addEventListener("click", () => {
      openAddAdminModal({ makeRfm: false, locations });
    });
    content.querySelector(".add-rfm-toggle").addEventListener("click", () => {
      openAddAdminModal({ makeRfm: true, locations });
    });
    content.querySelector(".terminate-technician-toggle").addEventListener("click", () => {
      openTerminateModal(techs);
    });
    content.querySelector(".admin-accounts-toggle").addEventListener("click", () => {
      showAdminAccounts = !showAdminAccounts;
      renderAdminAccountsPanel(content.querySelector(".admin-accounts-toggle"), content);
    });
    if (showAdminAccounts) await renderAdminAccountsPanel(content.querySelector(".admin-accounts-toggle"), content);
    content.querySelectorAll(".roster-row").forEach((row) => {
      row.addEventListener("click", () => {
        profileTechId = row.dataset.id;
        profileSubTab = "basic";
        draw();
      });
    });
  }

  // A separate, own-PIN login per admin -- not the roster below (that's
  // technicians only) -- so a departing admin's access can be turned off
  // (see the employment-status action below) without anyone sharing
  // credentials or losing the audit trail, which already has each past
  // action's actor name baked into it regardless of the account's current
  // state.
  async function renderAdminAccountsPanel(toggleBtn, contentEl) {
    toggleBtn.textContent = showAdminAccounts ? "Hide admin accounts" : "Manage admin accounts";
    const host = contentEl.querySelector("#admin-accounts-host");
    if (!showAdminAccounts) {
      host.innerHTML = "";
      return;
    }

    const [admins, locations] = await Promise.all([api.get("/api/admin/admins"), api.get("/api/locations")]);
    const locationByCode = Object.fromEntries(locations.map((l) => [l.code, l]));
    const locationOptionsFor = (selected) =>
      `<option value="">No location</option>` +
      locations.map((l) => `<option value="${escapeHtml(l.code)}" ${l.code === selected ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("");
    host.innerHTML = `
      <div class="admin-accounts-panel">
        <div class="admin-accounts-title">Admin Accounts</div>
        <p class="review-checklist-hint">
          Each admin should have their own login rather than sharing one -- create a new one for an
          incoming admin/RFM, then deactivate the outgoing one below once they're off. Deactivating
          only blocks that login; it never touches past audit history, which already records that
          person's name on everything they did.
        </p>
        <p class="review-checklist-hint">
          <strong>RFM</strong> is whichever admin produces PSEs, liaises with Toyota, and reviews
          charges on the WOM lifecycle checklist (Financials tab) -- every other active admin
          handles the rest (issuing the WOM/PO, monitoring charges, invoicing). Only one
          admin can hold it at a time.
        </p>
        <table class="detail-table admin-accounts-table">
          <thead><tr><th>Name</th><th>ID</th><th>Location</th><th>Territory</th><th>UKG ID</th><th>Hire date</th><th>Status</th><th>RFM</th><th></th></tr></thead>
          <tbody>
            ${admins
              .map((a) =>
                adminRenaming.has(a.id)
                  ? `<tr>
                      <td colspan="9">
                        <form class="admin-edit-form" data-id="${escapeHtml(a.id)}">
                          <div class="add-tech-grid">
                            <input name="name" placeholder="Full name" value="${escapeHtml(a.name)}" required />
                            <select name="homeLocationCode">${locationOptionsFor(a.homeLocationCode)}</select>
                            <input name="ukgId" placeholder="UKG ID" value="${escapeHtml(a.ukgId || "")}" />
                            <input name="hireDate" type="text" inputmode="numeric" placeholder="Hire date MM/DD/YYYY" maxlength="10" value="${escapeHtml(usFromIso(a.hireDate))}" />
                          </div>
                          <button type="submit" class="btn btn-link">Save</button>
                          <button type="button" class="btn btn-link admin-rename-cancel" data-id="${escapeHtml(a.id)}">Cancel</button>
                        </form>
                      </td>
                    </tr>`
                  : `<tr>
                      <td>${escapeHtml(a.name)}${a.id === state.user.id ? " (you)" : ""}
                        <button class="btn btn-link admin-rename-btn" data-id="${escapeHtml(a.id)}" type="button">Edit</button>
                        ${
                          revealedAdminPins.has(a.id)
                            ? `<div class="admin-pin-reveal">New PIN: <strong>${escapeHtml(revealedAdminPins.get(a.id))}</strong> (give this to ${escapeHtml(a.name)} now -- it won't be shown again) <button type="button" class="btn btn-link admin-pin-dismiss" data-id="${escapeHtml(a.id)}">Dismiss</button></div>`
                            : ""
                        }
                      </td>
                      <td>${escapeHtml(a.id)}</td>
                      <td>${escapeHtml((locationByCode[a.homeLocationCode] && locationByCode[a.homeLocationCode].name) || "—")}</td>
                      <td>${escapeHtml((locationByCode[a.homeLocationCode] && locationByCode[a.homeLocationCode].territory) || "—")}</td>
                      <td>${escapeHtml(a.ukgId || "—")}</td>
                      <td>${a.hireDate ? escapeHtml(usFromIso(a.hireDate)) : "—"}</td>
                      <td>${statusBadge(a.employmentStatus)}</td>
                      <td>
                        ${
                          a.isPseReviewer
                            ? `<button class="btn btn-link admin-pse-reviewer-btn" data-id="${escapeHtml(a.id)}" data-make="false" type="button">RFM -- remove</button>`
                            : `<button class="btn btn-link admin-pse-reviewer-btn" data-id="${escapeHtml(a.id)}" data-make="true" type="button">Set as RFM</button>`
                        }
                      </td>
                      <td>
                        <button class="btn btn-link admin-reset-pin-btn" data-id="${escapeHtml(a.id)}" type="button">Reset PIN</button>
                        ${
                          a.employmentStatus === "active"
                            ? `<button class="btn btn-link danger-link admin-deactivate-btn" data-id="${escapeHtml(a.id)}" type="button">Deactivate</button>`
                            : `<button class="btn btn-link admin-reactivate-btn" data-id="${escapeHtml(a.id)}" type="button">Reactivate</button>`
                        }
                      </td>
                    </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <form class="add-admin-form">
          <div class="add-tech-grid">
            <input name="id" placeholder="ID (e.g. ADMIN2)" required />
            <input name="name" placeholder="Full name" required />
            <input name="pin" placeholder="PIN" required inputmode="numeric" />
          </div>
          <button type="submit" class="btn btn-secondary">Add admin account</button>
          <span class="save-message add-admin-message"></span>
        </form>
      </div>
    `;

    host.querySelectorAll(".admin-reset-pin-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const admin = admins.find((a) => a.id === id);
        if (!window.confirm(`Reset ${admin.name}'s PIN? Their current PIN will stop working immediately.`)) return;
        btn.disabled = true;
        try {
          const { pin } = await api.post(`/api/admin/admins/${encodeURIComponent(id)}/reset-pin`, {});
          revealedAdminPins.set(id, pin);
          await renderAdminAccountsPanel(toggleBtn, contentEl);
        } catch (err) {
          btn.disabled = false;
          window.alert(err.message);
        }
      });
    });
    host.querySelectorAll(".admin-pin-dismiss").forEach((btn) => {
      btn.addEventListener("click", () => {
        revealedAdminPins.delete(btn.dataset.id);
        renderAdminAccountsPanel(toggleBtn, contentEl);
      });
    });

    host.querySelectorAll(".admin-deactivate-btn, .admin-reactivate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const status = btn.classList.contains("admin-deactivate-btn") ? "inactive" : "active";
        if (status === "inactive" && !window.confirm("Deactivate this admin account? They won't be able to log in until reactivated.")) return;
        btn.disabled = true;
        try {
          await api.patch(`/api/admin/admins/${encodeURIComponent(btn.dataset.id)}/employment-status`, { status });
          await renderAdminAccountsPanel(toggleBtn, contentEl);
        } catch (err) {
          btn.disabled = false;
          window.alert(err.message);
        }
      });
    });

    host.querySelectorAll(".admin-pse-reviewer-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.patch(`/api/admin/admins/${encodeURIComponent(btn.dataset.id)}/pse-reviewer`, { isPseReviewer: btn.dataset.make === "true" });
          await renderAdminAccountsPanel(toggleBtn, contentEl);
        } catch (err) {
          btn.disabled = false;
          window.alert(err.message);
        }
      });
    });

    host.querySelectorAll(".admin-rename-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        adminRenaming.add(btn.dataset.id);
        renderAdminAccountsPanel(toggleBtn, contentEl);
      });
    });
    host.querySelectorAll(".admin-rename-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        adminRenaming.delete(btn.dataset.id);
        renderAdminAccountsPanel(toggleBtn, contentEl);
      });
    });
    host.querySelectorAll(".admin-edit-form").forEach((form) => {
      wireDateMaskInput(form.hireDate);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const hireDateValue = form.hireDate.value.trim();
        if (hireDateValue && isoFromUs(hireDateValue) == null) {
          window.alert("Hire date must be a valid MM/DD/YYYY date.");
          return;
        }
        try {
          const [updated] = await Promise.all([
            api.patch(`/api/admin/admins/${encodeURIComponent(id)}/name`, { name: form.name.value.trim() }),
            api.patch(`/api/admin/admins/${encodeURIComponent(id)}/basic-info`, {
              homeLocationCode: form.homeLocationCode.value || null,
              ukgId: form.ukgId.value.trim(),
              hireDate: hireDateValue ? isoFromUs(hireDateValue) : null,
            }),
          ]);
          // Renaming yourself should show up in the header immediately,
          // not just after logging back in.
          if (id === state.user.id) {
            setUser({ ...state.user, name: updated.name });
            refreshHeader();
          }
          adminRenaming.delete(id);
          await renderAdminAccountsPanel(toggleBtn, contentEl);
        } catch (err) {
          window.alert(err.message);
        }
      });
    });

    const addAdminForm = host.querySelector(".add-admin-form");
    addAdminForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = addAdminForm.querySelector(".add-admin-message");
      try {
        await api.post("/api/admin/admins", {
          id: addAdminForm.id.value.trim(),
          name: addAdminForm.name.value.trim(),
          pin: addAdminForm.pin.value.trim(),
        });
        await renderAdminAccountsPanel(toggleBtn, contentEl);
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  function openAddModal(locations) {
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    const { body, close } = openModal({
      title: "Add Technician",
      bodyHtml: `
        <form class="add-technician-form modal-form">
          <div class="add-tech-grid">
            <input name="id" placeholder="ID (e.g. T1004)" required />
            <input name="name" placeholder="Full name" required />
            <input name="pin" placeholder="PIN" required inputmode="numeric" />
            <input name="position" placeholder="Position" />
            <select name="homeLocationCode"><option value="">No home location</option>${locationOptions}</select>
            <input name="email" placeholder="Email" type="email" />
            <input name="phone" placeholder="Phone" />
            <input name="ukgId" placeholder="UKG ID" />
            <label class="add-tech-date-field">Start date<input name="hireDate" type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" /></label>
          </div>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Create technician</button>
          </div>
          <span class="save-message add-tech-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".add-technician-form");
    wireDateMaskInput(form.hireDate);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".add-tech-message");
      if (form.hireDate.value.trim() && isoFromUs(form.hireDate.value) == null) {
        msg.textContent = "Start date must be a full MM/DD/YYYY date.";
        return;
      }
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
          hireDate: isoFromUs(form.hireDate.value),
        });
        close();
        await draw();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // Same create-admin capability the Manage admin accounts panel already
  // has, just surfaced as a top-level action next to + Add technician
  // instead of requiring that panel to be opened first -- creating an
  // admin login is common enough (a new RFM or a new office admin) to
  // deserve the same visibility as adding a technician. +Add RFM does the
  // same create, then immediately designates the new account as RFM in
  // one step (setPseReviewer already clears whoever held it before, so
  // this doubles as "transfer RFM to a brand-new account" too) -- no
  // separate trip to the admin accounts table required.
  function openAddAdminModal({ makeRfm, locations }) {
    const locationOptions = locations.map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join("");
    const { body, close } = openModal({
      title: makeRfm ? "Add RFM" : "Add Admin",
      bodyHtml: `
        <form class="add-admin-modal-form modal-form">
          <div class="add-tech-grid">
            <input name="id" placeholder="ID (e.g. ADMIN2)" required />
            <input name="name" placeholder="Full name" required />
            <input name="pin" placeholder="PIN" required inputmode="numeric" />
            <select name="homeLocationCode"><option value="">No location</option>${locationOptions}</select>
            <input name="ukgId" placeholder="UKG ID" />
            <label class="add-tech-date-field">Hire date<input name="hireDate" type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" /></label>
          </div>
          ${
            makeRfm
              ? `<p class="review-checklist-hint">This becomes the one admin who sends PSEs to Toyota and reviews charges -- it automatically replaces whoever holds RFM today.</p>`
              : ""
          }
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">${makeRfm ? "Create and set as RFM" : "Create admin"}</button>
          </div>
          <span class="save-message add-admin-modal-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".add-admin-modal-form");
    wireDateMaskInput(form.hireDate);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".add-admin-modal-message");
      if (form.hireDate.value.trim() && isoFromUs(form.hireDate.value) == null) {
        msg.textContent = "Hire date must be a full MM/DD/YYYY date.";
        return;
      }
      try {
        const admin = await api.post("/api/admin/admins", {
          id: form.id.value.trim(),
          name: form.name.value.trim(),
          pin: form.pin.value.trim(),
        });
        await api.patch(`/api/admin/admins/${encodeURIComponent(admin.id)}/basic-info`, {
          homeLocationCode: form.homeLocationCode.value || null,
          ukgId: form.ukgId.value.trim(),
          hireDate: isoFromUs(form.hireDate.value),
        });
        if (makeRfm) {
          await api.patch(`/api/admin/admins/${encodeURIComponent(admin.id)}/pse-reviewer`, { isPseReviewer: true });
        }
        close();
        // Otherwise the new account is invisible -- it only ever shows up
        // inside the (collapsed by default) Manage admin accounts panel,
        // and + Add Admin/+ Add RFM are deliberately surfaced as their own
        // top-level buttons specifically so creating one doesn't require
        // opening that panel first. Force it open now so the account that
        // was just created is actually on screen, not just "created
        // somewhere I can't see."
        showAdminAccounts = true;
        await draw();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }

  // A quick top-level action for the one-off "this person is leaving" case,
  // same pop-up pattern as + Add technician -- rather than requiring admin
  // to open that person's own profile, find Basic Info, and change the
  // status dropdown there (still there too, for changing it back or editing
  // alongside other fields). Sets both the termination date and the
  // employment status together, since terminated without a date on file
  // isn't useful later.
  function openTerminateModal(techs) {
    const eligible = techs.filter((t) => t.employmentStatus !== "terminated").sort((a, b) => a.name.localeCompare(b.name));
    const options = eligible.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
    const { body, close } = openModal({
      title: "Terminate Employee",
      bodyHtml: `
        <form class="terminate-technician-form modal-form">
          <label class="profile-field"><span>Employee</span><select name="techId" required><option value="">Choose one</option>${options}</select></label>
          <label class="profile-field">
            <span>Termination date</span>
            <input type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" name="terminationDate" required />
          </label>
          <div class="modal-form-actions">
            <button type="submit" class="btn btn-primary">Terminate employee</button>
          </div>
          <span class="save-message"></span>
        </form>
      `,
    });
    const form = body.querySelector(".terminate-technician-form");
    wireDateMaskInput(form.terminationDate);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".save-message");
      const tech = eligible.find((t) => t.id === form.techId.value);
      if (!tech) {
        msg.textContent = "Choose an employee.";
        return;
      }
      const terminationDate = isoFromUs(form.terminationDate.value);
      if (!terminationDate) {
        msg.textContent = "Termination date must be a full MM/DD/YYYY date.";
        return;
      }
      try {
        // basic-info replaces the whole set of fields it covers, not just
        // the ones sent -- carry the technician's existing values through
        // unchanged so this doesn't blank out their email/phone/position/
        // hire date/standard hours along with setting the termination date.
        await api.patch(`/api/admin/technicians/${tech.id}/basic-info`, {
          email: tech.email || "",
          phone: tech.phone || "",
          ukgId: tech.ukgId || "",
          position: tech.position || "",
          hireDate: tech.hireDate || "",
          terminationDate,
          standardDailyHours: tech.standardDailyHours ?? "",
        });
        await api.patch(`/api/admin/technicians/${tech.id}/employment-status`, { status: "terminated" });
        close();
        // Terminating doesn't delete anything -- allocation history,
        // documents, forms, everything stays on their record -- but
        // returning to the roster's own default "Active" filter makes
        // whoever was just terminated immediately vanish from view, which
        // reads as data loss even though nothing was actually lost.
        // Opening their profile directly proves the record is still there.
        profileTechId = tech.id;
        profileSubTab = "basic";
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
        <button class="btn btn-link reset-pin-btn" type="button">Reset PIN</button>
        <span class="profile-pin-reveal" hidden></span>
        <button class="btn btn-link danger-link delete-technician-btn" type="button">Delete</button>
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
    // There's no "look the old PIN back up" -- it's hashed one-way, same as
    // any real password -- so this issues a brand-new random one instead,
    // shown once right here (never baked into the profile payload, and
    // dismissed on a second click) for admin to relay to the technician.
    const pinBtn = content.querySelector(".reset-pin-btn");
    const pinReveal = content.querySelector(".profile-pin-reveal");
    pinBtn.addEventListener("click", async () => {
      if (!pinReveal.hidden) {
        pinReveal.hidden = true;
        pinReveal.textContent = "";
        pinBtn.textContent = "Reset PIN";
        return;
      }
      if (!window.confirm(`Reset ${tech.name}'s PIN? Their current PIN will stop working immediately.`)) return;
      try {
        const { pin } = await api.post(`/api/admin/technicians/${encodeURIComponent(tech.id)}/reset-pin`, {});
        pinReveal.textContent = `New PIN: ${pin} (give this to ${tech.name} now -- it won't be shown again)`;
        pinReveal.hidden = false;
        pinBtn.textContent = "Dismiss";
      } catch (err) {
        window.alert(err.message);
      }
    });
    // A technician created by mistake (a test entry, a typo) should just go
    // away. Blocked with a 409 if they have allocated hours on record --
    // ask again, naming that specific consequence, before forcing it.
    content.querySelector(".delete-technician-btn").addEventListener("click", async () => {
      if (!window.confirm(`Delete "${tech.name}" (${tech.id})? This can't be undone.`)) return;
      try {
        await api.delete(`/api/admin/technicians/${encodeURIComponent(tech.id)}`);
        profileTechId = null;
        await draw();
      } catch (err) {
        if (err.status === 409 && err.payload && err.payload.allocatedHours != null) {
          const forceConfirmed = window.confirm(
            `${err.payload.allocatedHours}h already allocated to ${tech.name} across their timesheets. Deleting them removes that history too -- delete anyway?`
          );
          if (!forceConfirmed) return;
          try {
            await api.delete(`/api/admin/technicians/${encodeURIComponent(tech.id)}`, { force: true });
            profileTechId = null;
            await draw();
          } catch (err2) {
            window.alert(`Could not delete ${tech.name}: ${err2.message}`);
          }
        } else {
          window.alert(`Could not delete ${tech.name}: ${err.message}`);
        }
      }
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
    else await drawRemarks(tabContent, tech);
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
        <label class="profile-field"><span>Hire date</span><input type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" name="hireDate" value="${escapeHtml(usFromIso(tech.hireDate))}" /></label>
        <label class="profile-field"><span>Termination date</span><input type="text" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10" name="terminationDate" value="${escapeHtml(usFromIso(tech.terminationDate))}" /></label>
        <label class="profile-field"><span>Standard daily hours (net of break)</span><input type="number" min="0" step="0.25" name="standardDailyHours" value="${tech.standardDailyHours ?? ""}" /></label>
        <p class="profile-field-note">
          Notify-me-by-email is the technician's own setting, not editable here:
          currently <strong>${tech.notificationPref === "email" ? "Email" : "In-app only"}</strong>.
          ${tech.notificationPref !== "email" && !tech.email ? " Add an email above so they can switch to email if they want to." : ""}
        </p>
        <button type="submit" class="btn btn-primary">Save</button>
        <span class="save-message basic-info-message"></span>
      </form>
    `;

    const form = tabContent.querySelector(".basic-info-form");
    wireDateMaskInput(form.hireDate);
    wireDateMaskInput(form.terminationDate);
    const original = {
      homeLocationCode: tech.homeLocationCode || "",
      employmentStatus: tech.employmentStatus,
      hireDate: usFromIso(tech.hireDate),
      terminationDate: usFromIso(tech.terminationDate),
      standardDailyHours: tech.standardDailyHours ?? "",
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = form.querySelector(".basic-info-message");
      msg.textContent = "";
      if (form.hireDate.value.trim() && isoFromUs(form.hireDate.value) == null) {
        msg.textContent = "Hire date must be a full MM/DD/YYYY date.";
        return;
      }
      if (form.terminationDate.value.trim() && isoFromUs(form.terminationDate.value) == null) {
        msg.textContent = "Termination date must be a full MM/DD/YYYY date.";
        return;
      }
      try {
        await api.patch(`/api/admin/technicians/${tech.id}/basic-info`, {
          email: form.email.value.trim(),
          phone: form.phone.value.trim(),
          ukgId: form.ukgId.value.trim(),
          position: form.position.value.trim(),
          hireDate: isoFromUs(form.hireDate.value),
          terminationDate: isoFromUs(form.terminationDate.value),
          standardDailyHours: form.standardDailyHours.value,
        });
        original.hireDate = form.hireDate.value;
        original.terminationDate = form.terminationDate.value;
        original.standardDailyHours = form.standardDailyHours.value;
        // Keep the in-memory tech record current so switching to Devices in
        // this same visit prefills a Phone device from the number just saved,
        // not a stale one from before this edit.
        tech.phone = form.phone.value.trim();
        tech.email = form.email.value.trim();
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
        form.hireDate.value = original.hireDate;
        form.terminationDate.value = original.terminationDate;
        form.standardDailyHours.value = original.standardDailyHours;
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
    // Grouped by section (Setup & Access vs. Forms on File -- see
    // ONBOARDING_TASKS in server/data/db.js) rather than one long flat
    // list, in whatever order each section's tasks come back in (already
    // the fixed checklist order, not re-sorted).
    const sections = [];
    const sectionIndex = {};
    tasks.forEach((t) => {
      const key = t.section || "";
      if (!(key in sectionIndex)) {
        sectionIndex[key] = sections.length;
        sections.push({ section: key, items: [] });
      }
      sections[sectionIndex[key]].items.push(t);
    });

    tabContent.innerHTML = `
      <p class="onboarding-error" hidden></p>
      ${sections
        .map(
          (s) => `
        <h5 class="onboarding-section-heading">${escapeHtml(s.section)}</h5>
        <div class="onboarding-list">
          ${s.items
            .map(
              (t) => `
            <label class="onboarding-item">
              <input type="checkbox" data-key="${t.key}" ${t.completedAt ? "checked" : ""} />
              <span>${escapeHtml(t.label)}</span>
              ${t.completedAt ? `<span class="onboarding-date">${new Date(t.completedAt).toLocaleDateString()}</span>` : ""}
            </label>`
            )
            .join("")}
        </div>`
        )
        .join("")}
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

  const DEVICE_TYPE_LABELS = { phone: "Phone", laptop: "Laptop", ipad: "iPad" };
  const DEVICE_IDENTIFIER_PLACEHOLDER = { phone: "Phone number", laptop: "Asset tag / serial", ipad: "iPad #" };

  const requestEditing = new Set(); // request ids currently showing the edit form

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
          <option value="ipad">iPad</option>
          <option value="laptop">Laptop</option>
        </select>
        <input name="deviceName" placeholder="${DEVICE_IDENTIFIER_PLACEHOLDER.phone}" value="${escapeHtml(tech.phone || "")}" required />
        <input name="notes" placeholder="Notes (optional)" />
        <button type="submit" class="btn btn-secondary">Assign device</button>
      </form>
      ${!tech.phone ? `<p class="empty-note">No phone # on file yet -- add one on Basic Info and it'll prefill here.</p>` : ""}
    `;

    function renderRequestRow(d, r) {
      if (requestEditing.has(r.id)) {
        return `
          <form class="edit-request-form" data-device-id="${d.id}" data-request-id="${r.id}">
            <input name="requestType" value="${escapeHtml(r.requestType)}" required />
            <input name="referenceNumber" placeholder="Reference #" value="${escapeHtml(r.referenceNumber || "")}" />
            <button type="submit" class="btn btn-link">Save</button>
            <button type="button" class="btn btn-link cancel-request-edit" data-request-id="${r.id}">Cancel</button>
          </form>`;
      }
      return `
        <div class="device-request-row">
          <span class="device-request-type">${escapeHtml(r.requestType)}${r.referenceNumber ? ` &mdash; #${escapeHtml(r.referenceNumber)}` : ""}</span>
          <span class="badge ${r.completedAt ? "badge-approved" : "badge-draft"}">${r.completedAt ? "Completed" : "Pending"}</span>
          <button class="btn btn-link edit-request-btn" type="button" data-request-id="${r.id}">Edit</button>
          <button class="btn btn-link toggle-request-btn" type="button" data-device-id="${d.id}" data-request-id="${r.id}" data-completed="${Boolean(r.completedAt)}">
            ${r.completedAt ? "Reopen" : "Mark completed"}
          </button>
        </div>`;
    }

    function renderDeviceRow(d) {
      return `
        <div class="device-row">
          <div class="device-row-main">
            <div>
              <span class="device-type-badge">${escapeHtml(DEVICE_TYPE_LABELS[d.deviceType] || d.deviceType)}</span>
              <span class="device-name">${escapeHtml(d.deviceName)}</span>
              <div class="device-meta">${escapeHtml(d.notes || "")}${d.notes ? " &middot; " : ""}assigned ${new Date(d.assignedAt).toLocaleDateString()}</div>
              <div class="device-upgrade-field">
                <label>Upgrade date
                  <input type="date" class="device-upgrade-input" data-device-id="${d.id}" value="${d.upgradeDate || ""}" />
                </label>
                <button class="btn btn-link device-upgrade-save" type="button" data-device-id="${d.id}">Save</button>
              </div>
            </div>
            <button class="btn btn-link danger-link remove-device" data-id="${d.id}" type="button">Remove</button>
          </div>
          <div class="device-requests">
            <div class="device-requests-title">IT Requests (e.g. Calero)</div>
            ${
              d.requests.length === 0
                ? `<p class="empty-note">No requests logged.</p>`
                : d.requests.map((r) => renderRequestRow(d, r)).join("")
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
      const nameInput = tabContent.querySelector('input[name="deviceName"]');
      nameInput.placeholder = DEVICE_IDENTIFIER_PLACEHOLDER[e.target.value];
      // Phone # on Basic Info is this technician's one real number -- no
      // reason to type it again for a Phone-type device. Switching away
      // clears it since a phone number isn't a sensible default for a
      // laptop/iPad's asset tag.
      nameInput.value = e.target.value === "phone" ? tech.phone || "" : "";
    });

    tabContent.querySelectorAll(".device-upgrade-save").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const input = tabContent.querySelector(`.device-upgrade-input[data-device-id="${btn.dataset.deviceId}"]`);
        try {
          await api.patch(`/api/admin/technicians/${tech.id}/devices/${btn.dataset.deviceId}`, { upgradeDate: input.value || null });
          await drawDevices(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Could not save: ${err.message}`;
          errorEl.hidden = false;
        }
      });
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

    tabContent.querySelectorAll(".edit-request-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        requestEditing.add(Number(btn.dataset.requestId));
        drawDevices(tabContent, tech);
      });
    });

    tabContent.querySelectorAll(".cancel-request-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        requestEditing.delete(Number(btn.dataset.requestId));
        drawDevices(tabContent, tech);
      });
    });

    tabContent.querySelectorAll(".edit-request-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api.patch(
            `/api/admin/technicians/${tech.id}/devices/${form.dataset.deviceId}/requests/${form.dataset.requestId}`,
            { requestType: form.requestType.value.trim(), referenceNumber: form.referenceNumber.value.trim() }
          );
          requestEditing.delete(Number(form.dataset.requestId));
          await drawDevices(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Not saved: ${err.message}`;
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
      trackExpiration: true,
    });
  }

  async function drawRemarks(tabContent, tech) {
    const remarks = await api.get(`/api/admin/technicians/${tech.id}/remarks`);
    tabContent.innerHTML = `
      <p class="review-checklist-hint">Dated notes from an RFM/manager about this technician -- not a file, just a log.</p>
      <p class="remark-error" hidden></p>
      <div class="remark-list">
        ${
          remarks.length === 0
            ? `<p class="empty-note">No remarks yet.</p>`
            : remarks
                .map(
                  (r) => `
              <div class="remark-row">
                <div class="remark-meta">
                  <span class="remark-author">${escapeHtml(r.authorName)}</span>
                  <span>${new Date(r.createdAt).toLocaleString()}</span>
                  <button class="btn btn-link danger-link remark-delete" type="button" data-id="${r.id}">Delete</button>
                </div>
                <div class="remark-body">${escapeHtml(r.body)}</div>
              </div>`
                )
                .join("")
        }
      </div>
      <form class="add-remark-form">
        <textarea name="body" placeholder="Add a remark..." rows="3" required></textarea>
        <button type="submit" class="btn btn-secondary">Add remark</button>
      </form>
    `;

    const errorEl = tabContent.querySelector(".remark-error");

    tabContent.querySelectorAll(".remark-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("Delete this remark? This can't be undone.")) return;
        try {
          await api.delete(`/api/admin/technicians/${tech.id}/remarks/${btn.dataset.id}`);
          await drawRemarks(tabContent, tech);
        } catch (err) {
          errorEl.textContent = `Could not delete: ${err.message}`;
          errorEl.hidden = false;
        }
      });
    });

    tabContent.querySelector(".add-remark-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      try {
        await api.post(`/api/admin/technicians/${tech.id}/remarks`, { body: form.body.value.trim() });
        await drawRemarks(tabContent, tech);
      } catch (err) {
        errorEl.textContent = `Not saved: ${err.message}`;
        errorEl.hidden = false;
      }
    });
  }
}
