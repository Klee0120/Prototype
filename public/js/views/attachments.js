import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";
import { openModal } from "../modal.js";

const CATEGORY_LABELS = {
  receipt: "Receipt / Invoice",
  ukg_screenshot: "UKG Timesheet Screenshot",
  wom_doc: "Document / Photo",
  tech_form: "Form / Certification",
  document: "Document",
  labor_report: "Labor Report",
  wom_report: "WOM Report",
  financial_report: "Financial Report",
  gl_report: "GL Report",
  coi: "COI (Certificate of Insurance)",
  w9: "W-9",
  ach: "ACH / Bank Letter",
  vpo_waiver: "VPO Waiver",
  vendor_other: "Other Vendor Document",
  po_doc: "PO Document",
  quote: "Vendor Quote",
  quote_revision: "Approved Quote Revision",
  invoice: "Invoice Document",
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function expiryBadge(expiresAt) {
  if (!expiresAt) return "";
  const expired = expiresAt < todayISO();
  return `<span class="badge ${expired ? "badge-rejected" : "badge-draft"}">${expired ? "Expired" : "Expires"} ${escapeHtml(expiresAt)}</span>`;
}

function accessBadge(f) {
  if (f.accessLevel === "restricted") {
    return `<span class="badge badge-warn" title="Admins only -- hidden from technicians entirely.">&#128274; Restricted access</span>`;
  }
  return `<span class="badge badge-draft" title="Visible to anyone who can open this record, technicians included.">Standard access</span>`;
}

/**
 * Renders a self-contained document manager (compliance cards, search +
 * category filter, a unified table, and a drag-and-drop upload zone) into
 * `host`. options: { title, relatedType, relatedId, categories: [{value,label}], canUpload, emptyText,
 *            trackExpiration: true adds Type + Expiration date fields to the upload form and
 *            shows them (with an Expired/Expires badge) on each file row -- used for Forms on File.
 *            requiredCategories: [value, ...] -- categories that should always have at least one
 *            file on file; each gets a compliance card up top with a "Missing" badge when it
 *            doesn't (e.g. a vendor's COI/W-9/ACH/VPO waiver). Omit where there's no fixed
 *            compliance set to check against.
 *            groupByCategory was the old grouped-sections layout; the unified table + category
 *            filter below replaces it, so this option is no longer read. }
 */
export async function renderAttachments(host, opts) {
  let searchTerm = "";
  let categoryFilter = "";
  let allFiles = [];

  await refresh();

  async function refresh() {
    let loadError = "";
    try {
      const files = await api.get(
        `/api/files?relatedType=${encodeURIComponent(opts.relatedType)}&relatedId=${encodeURIComponent(opts.relatedId)}`
      );
      // The API returns every file for this relatedType/relatedId, not just
      // this panel's own categories -- a technician's Forms on File and
      // Documents tabs share one relatedType ("technician"), so without
      // this filter each tab would also show the other's files.
      const ownCategories = new Set(opts.categories.map((c) => c.value));
      allFiles = files.filter((f) => ownCategories.has(f.category));
    } catch (err) {
      allFiles = [];
      loadError = err.message;
    }
    render(loadError);
  }

  function render(loadError) {
    const isAdmin = state.user.role === "admin";
    const showCategoryFilter = opts.categories.length > 1;

    host.innerHTML = `
      <div class="attachments-panel">
        <div class="attachments-title">${escapeHtml(opts.title)}</div>
        ${opts.requiredCategories ? `<div class="attachments-compliance-cards"></div>` : ""}
        <div class="attachments-toolbar">
          <div class="search-field attachments-search">
            <span class="search-field-icon">&#128269;</span>
            <input type="text" placeholder="Search documents..." />
          </div>
          ${
            showCategoryFilter
              ? `<select class="attachments-category-filter">
                  <option value="">All categories</option>
                  ${opts.categories
                    .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
                    .join("")}
                </select>`
              : ""
          }
        </div>
        <div class="attachments-table-wrap"></div>
        ${loadError ? `<p class="attachments-error">${escapeHtml(loadError)}</p>` : ""}
        ${opts.canUpload ? renderUploadZone(isAdmin) : ""}
      </div>
    `;

    if (opts.requiredCategories) renderComplianceCards();
    renderTable();
    wireToolbar();
    if (opts.canUpload) wireUploadZone();
  }

  function renderComplianceCards() {
    const cardsHost = host.querySelector(".attachments-compliance-cards");
    if (!cardsHost) return;
    cardsHost.innerHTML = opts.requiredCategories
      .map((catValue) => {
        const label = (opts.categories.find((c) => c.value === catValue) || {}).label || CATEGORY_LABELS[catValue] || catValue;
        const count = allFiles.filter((f) => f.category === catValue).length;
        return `
          <div class="compliance-card${count === 0 ? " compliance-card-missing" : ""}">
            <span class="compliance-card-label">${escapeHtml(label)}</span>
            ${count === 0 ? `<span class="badge badge-rejected">Missing</span>` : `<span class="badge badge-approved">${count} on file</span>`}
          </div>`;
      })
      .join("");
  }

  function filteredFiles() {
    return allFiles.filter((f) => {
      if (categoryFilter && f.category !== categoryFilter) return false;
      if (searchTerm) {
        const label = (CATEGORY_LABELS[f.category] || f.category).toLowerCase();
        const haystack = `${f.originalName} ${label} ${f.formType || ""}`.toLowerCase();
        if (!haystack.includes(searchTerm.toLowerCase())) return false;
      }
      return true;
    });
  }

  function renderTable() {
    const wrap = host.querySelector(".attachments-table-wrap");
    const files = filteredFiles();
    const isAdmin = state.user.role === "admin";

    if (allFiles.length === 0) {
      wrap.innerHTML = `<p class="empty-note">${escapeHtml(opts.emptyText || "No files yet.")}</p>`;
      return;
    }
    if (files.length === 0) {
      wrap.innerHTML = `<p class="empty-note">No documents match your search.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table class="attachments-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Category</th>
            <th>Uploaded</th>
            <th>Access</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    const tbody = wrap.querySelector("tbody");
    files.forEach((f, i) => tbody.appendChild(renderFileRow(f, files, i, isAdmin)));

    if (isAdmin && !host.dataset.rowMenuBound) {
      host.dataset.rowMenuBound = "1";
      host.addEventListener("click", (e) => {
        if (!e.target.closest(".row-menu")) {
          host.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
        }
      });
    }
  }

  function renderFileRow(f, list, index, isAdmin) {
    const row = document.createElement("tr");
    row.className = "attachment-row";
    const label = CATEGORY_LABELS[f.category] || f.category;

    row.innerHTML = `
      <td class="attachment-doc-cell">
        <div class="attachment-name">${escapeHtml(f.originalName)}</div>
        ${opts.trackExpiration && f.formType ? `<div class="attachment-subtext">${escapeHtml(f.formType)}</div>` : ""}
        ${opts.trackExpiration ? expiryBadge(f.expiresAt) : ""}
      </td>
      <td><span class="badge badge-draft">${escapeHtml(label)}</span></td>
      <td>
        <div>${new Date(f.uploadedAt).toLocaleDateString()}</div>
        <div class="attachment-subtext">${escapeHtml(f.uploadedBy)} &middot; ${formatSize(f.size)}</div>
      </td>
      <td>${accessBadge(f)}</td>
      <td class="attachment-actions-cell">
        <button type="button" class="attachment-icon-btn view-btn" title="View" aria-label="View">&#128065;</button>
        <button type="button" class="attachment-icon-btn download-btn" title="Download" aria-label="Download">&#11015;&#65039;</button>
        ${
          isAdmin
            ? `<div class="row-menu">
                <button type="button" class="btn btn-ghost row-menu-toggle" type="button" aria-label="More actions">&#8943;</button>
                <div class="row-menu-panel" hidden>
                  <button type="button" class="row-menu-item toggle-access-btn">${
                    f.accessLevel === "restricted" ? "Mark standard access" : "Mark restricted access"
                  }</button>
                  <button type="button" class="row-menu-item row-menu-item-danger delete-btn">Delete</button>
                </div>
              </div>`
            : ""
        }
      </td>
    `;

    row.querySelector(".view-btn").addEventListener("click", () => {
      openDocViewer(list, index);
    });

    row.querySelector(".download-btn").addEventListener("click", async () => {
      try {
        await api.downloadFile(f.id, f.originalName);
      } catch (err) {
        window.alert(err.message);
      }
    });

    const menuToggle = row.querySelector(".row-menu-toggle");
    if (menuToggle) {
      menuToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const panel = row.querySelector(".row-menu-panel");
        const isHidden = panel.hasAttribute("hidden");
        host.querySelectorAll(".row-menu-panel").forEach((p) => p.setAttribute("hidden", ""));
        if (isHidden) panel.removeAttribute("hidden");
      });
    }

    const toggleAccess = row.querySelector(".toggle-access-btn");
    if (toggleAccess) {
      toggleAccess.addEventListener("click", async () => {
        const nextLevel = f.accessLevel === "restricted" ? "standard" : "restricted";
        try {
          await api.patch(`/api/files/${f.id}/access`, { accessLevel: nextLevel });
          await refresh();
        } catch (err) {
          window.alert(`Could not update access: ${err.message}`);
        }
      });
    }

    const del = row.querySelector(".delete-btn");
    if (del) {
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete "${f.originalName}"?`)) return;
        try {
          await api.delete(`/api/files/${f.id}`);
          await refresh();
        } catch (err) {
          window.alert(`Could not delete: ${err.message}`);
        }
      });
    }

    return row;
  }

  function wireToolbar() {
    const searchInput = host.querySelector(".attachments-search input");
    if (searchInput) {
      searchInput.value = searchTerm;
      searchInput.addEventListener("input", (e) => {
        searchTerm = e.target.value;
        renderTable();
      });
    }
    const categorySelect = host.querySelector(".attachments-category-filter");
    if (categorySelect) {
      categorySelect.value = categoryFilter;
      categorySelect.addEventListener("change", (e) => {
        categoryFilter = e.target.value;
        renderTable();
      });
    }
  }

  // A document's own pop-up: metadata + Download/Delete on one side, a
  // large inline preview on the other, Previous/Next to move through the
  // same (filtered) list this was opened from -- instead of a bare
  // "Download" link being the only way to see what a file actually is.
  function openDocViewer(list, startIndex) {
    let index = startIndex;
    let objectUrl = null;

    function revoke() {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    }

    const { body, close } = openModal({
      title: "Document",
      size: "large",
      bodyHtml: `
        <div class="doc-viewer">
          <div class="doc-viewer-info"></div>
          <div class="doc-viewer-preview-pane">
            <div class="doc-viewer-preview-nav"></div>
            <div class="doc-viewer-preview-body"></div>
          </div>
        </div>
      `,
      onClose: revoke,
    });

    const infoHost = body.querySelector(".doc-viewer-info");
    const navHost = body.querySelector(".doc-viewer-preview-nav");
    const previewHost = body.querySelector(".doc-viewer-preview-body");

    async function renderCurrent() {
      revoke();
      const f = list[index];
      const label = CATEGORY_LABELS[f.category] || f.category;

      infoHost.innerHTML = `
        <div class="doc-viewer-name">${escapeHtml(f.originalName)}</div>
        <div class="doc-viewer-field">
          <span class="doc-viewer-field-label">Type</span>
          ${opts.trackExpiration && f.formType ? escapeHtml(f.formType) : escapeHtml(label)}
        </div>
        <div class="doc-viewer-field">
          <span class="doc-viewer-field-label">Uploaded</span>
          ${escapeHtml(f.uploadedBy)} &middot; ${new Date(f.uploadedAt).toLocaleDateString()}
        </div>
        <div class="doc-viewer-field">
          <span class="doc-viewer-field-label">Size</span>
          ${formatSize(f.size)}
        </div>
        <div class="doc-viewer-field">
          <span class="doc-viewer-field-label">Access</span>
          ${accessBadge(f)}
        </div>
        ${
          opts.trackExpiration && f.expiresAt
            ? `<div class="doc-viewer-field"><span class="doc-viewer-field-label">Expiration</span>${expiryBadge(f.expiresAt)}</div>`
            : ""
        }
        <div class="doc-viewer-actions">
          <button type="button" class="btn btn-secondary doc-viewer-download">Download</button>
          ${state.user.role === "admin" ? `<button type="button" class="btn btn-link danger-link doc-viewer-delete">Delete</button>` : ""}
        </div>
      `;
      infoHost.querySelector(".doc-viewer-download").addEventListener("click", async () => {
        try {
          await api.downloadFile(f.id, f.originalName);
        } catch (err) {
          window.alert(err.message);
        }
      });
      const deleteBtn = infoHost.querySelector(".doc-viewer-delete");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
          if (!window.confirm(`Delete "${f.originalName}"?`)) return;
          try {
            await api.delete(`/api/files/${f.id}`);
            list.splice(index, 1);
            await refresh();
            if (list.length === 0) {
              close();
              return;
            }
            if (index >= list.length) index = list.length - 1;
            await renderCurrent();
          } catch (err) {
            window.alert(`Could not delete: ${err.message}`);
          }
        });
      }

      navHost.innerHTML = `
        <button type="button" class="btn btn-link doc-viewer-prev" ${index === 0 ? "disabled" : ""}>&larr; Previous</button>
        <span>${index + 1} of ${list.length}</span>
        <button type="button" class="btn btn-link doc-viewer-next" ${index === list.length - 1 ? "disabled" : ""}>Next &rarr;</button>
      `;
      navHost.querySelector(".doc-viewer-prev").addEventListener("click", () => {
        if (index > 0) {
          index -= 1;
          renderCurrent();
        }
      });
      navHost.querySelector(".doc-viewer-next").addEventListener("click", () => {
        if (index < list.length - 1) {
          index += 1;
          renderCurrent();
        }
      });

      previewHost.innerHTML = `<p class="doc-viewer-no-preview">Loading…</p>`;
      try {
        const blob = await api.fetchFileBlob(f.id);
        objectUrl = URL.createObjectURL(blob);
        if ((f.mimeType || "").startsWith("image/")) {
          previewHost.innerHTML = `<img src="${objectUrl}" alt="${escapeHtml(f.originalName)}" />`;
        } else if (f.mimeType === "application/pdf") {
          previewHost.innerHTML = `<iframe src="${objectUrl}" title="${escapeHtml(f.originalName)}"></iframe>`;
        } else {
          previewHost.innerHTML = `<p class="doc-viewer-no-preview">No inline preview for this file type (${escapeHtml(
            f.mimeType || "unknown"
          )}) -- use Download to open it.</p>`;
        }
      } catch (err) {
        previewHost.innerHTML = `<p class="doc-viewer-no-preview">Could not load preview: ${escapeHtml(err.message)}</p>`;
      }
    }

    renderCurrent();
  }

  function renderUploadZone(isAdmin) {
    const categorySelect =
      opts.categories.length > 1
        ? `<select class="attachments-upload-category">${opts.categories
            .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
            .join("")}</select>`
        : "";
    return `
      <div class="attachments-upload">
        <div class="attachments-upload-settings">
          ${categorySelect}
          ${opts.trackExpiration ? `<input class="attachments-upload-formtype" placeholder="Type (e.g. Certification)" />` : ""}
          ${
            opts.trackExpiration
              ? `<label class="attachment-expiry-field"><span>Expires</span><input type="date" class="attachments-upload-expires" /></label>`
              : ""
          }
          ${
            isAdmin
              ? `<select class="attachments-upload-access" title="Standard access: visible to anyone who can open this record, technicians included. Restricted access: admins only -- hidden from technicians entirely.">
                  <option value="standard">Standard access</option>
                  <option value="restricted">Restricted access</option>
                </select>`
              : ""
          }
        </div>
        ${
          isAdmin
            ? `<p class="review-checklist-hint">
                 <strong>Standard access</strong> -- visible to anyone who can open this record (technicians included).
                 <strong>Restricted access</strong> &#128274; -- admins only; hidden from technicians entirely.
               </p>`
            : ""
        }
        <div class="attachments-dropzone">
          <input type="file" class="attachments-dropzone-input" hidden />
          <div class="attachments-dropzone-icon">&#128228;</div>
          <div class="attachments-dropzone-text">Drop files here or <span class="attachments-dropzone-browse">browse</span></div>
        </div>
        <span class="save-message upload-message"></span>
      </div>
    `;
  }

  function wireUploadZone() {
    const zone = host.querySelector(".attachments-dropzone");
    if (!zone) return;
    const fileInput = zone.querySelector(".attachments-dropzone-input");
    const msg = host.querySelector(".upload-message");

    async function handleFiles(fileList) {
      const file = fileList && fileList[0];
      if (!file) return;
      const categorySelect = host.querySelector(".attachments-upload-category");
      const category = categorySelect ? categorySelect.value : opts.categories[0].value;
      const formTypeInput = host.querySelector(".attachments-upload-formtype");
      const expiresInput = host.querySelector(".attachments-upload-expires");
      const accessSelect = host.querySelector(".attachments-upload-access");

      msg.textContent = "Uploading…";
      try {
        await api.uploadFile(opts.relatedType, opts.relatedId, category, file, {
          formType: opts.trackExpiration && formTypeInput ? formTypeInput.value.trim() : undefined,
          expiresAt: opts.trackExpiration && expiresInput ? expiresInput.value : undefined,
          accessLevel: accessSelect ? accessSelect.value : undefined,
        });
        msg.textContent = "";
        await refresh();
      } catch (err) {
        msg.textContent = err.message;
      }
    }

    zone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => handleFiles(fileInput.files));
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("attachments-dropzone-active");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("attachments-dropzone-active"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("attachments-dropzone-active");
      handleFiles(e.dataTransfer.files);
    });
  }
}
