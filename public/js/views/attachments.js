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

/**
 * Renders a self-contained attachments list + upload form into `host`.
 * options: { title, relatedType, relatedId, categories: [{value,label}], canUpload, emptyText,
 *            trackExpiration: true adds Type + Expiration date fields to the upload form and
 *            shows them (with an Expired/Expires badge) on each file row -- used for Forms on File.
 *            groupByCategory: true splits the list into one section per category (in `categories`
 *            order) instead of one combined list -- used for Reports, where WOM/Labor/Financial/GL
 *            need to each stay together and in order rather than interleaved by upload date. }
 */
export async function renderAttachments(host, opts) {
  await refresh();

  async function refresh() {
    let files = [];
    let loadError = "";
    try {
      files = await api.get(
        `/api/files?relatedType=${encodeURIComponent(opts.relatedType)}&relatedId=${encodeURIComponent(opts.relatedId)}`
      );
      // The API returns every file for this relatedType/relatedId, not just
      // this panel's own categories -- a technician's Forms on File and
      // Documents tabs share one relatedType ("technician"), so without
      // this filter each tab would also show the other's files.
      const ownCategories = new Set(opts.categories.map((c) => c.value));
      files = files.filter((f) => ownCategories.has(f.category));
    } catch (err) {
      loadError = err.message;
    }

    host.innerHTML = `
      <div class="attachments-panel">
        <div class="attachments-title">${escapeHtml(opts.title)}</div>
        ${opts.groupByCategory ? `<div class="attachments-sections"></div>` : `<div class="attachments-list"></div>`}
        ${loadError ? `<p class="attachments-error">${escapeHtml(loadError)}</p>` : ""}
        ${opts.canUpload ? renderUploadForm() : ""}
      </div>
    `;

    if (opts.groupByCategory) {
      const sectionsHost = host.querySelector(".attachments-sections");
      const byCategory = new Map(opts.categories.map((c) => [c.value, []]));
      for (const f of files) {
        if (!byCategory.has(f.category)) byCategory.set(f.category, []);
        byCategory.get(f.category).push(f);
      }
      for (const [catValue, catFiles] of byCategory) {
        const catLabel = (opts.categories.find((c) => c.value === catValue) || {}).label || catValue;
        const section = document.createElement("div");
        section.className = "attachments-section";
        section.innerHTML = `<div class="attachments-section-title">${escapeHtml(catLabel)}</div><div class="attachments-list"></div>`;
        const listEl = section.querySelector(".attachments-list");
        if (catFiles.length === 0) {
          listEl.innerHTML = `<p class="empty-note">No ${escapeHtml(catLabel.toLowerCase())}s saved for this month yet.</p>`;
        } else {
          catFiles.forEach((f, i) => listEl.appendChild(renderFileRow(f, catFiles, i)));
        }
        sectionsHost.appendChild(section);
      }
    } else if (!loadError && files.length === 0) {
      host.querySelector(".attachments-list").innerHTML = `<p class="empty-note">${escapeHtml(opts.emptyText || "No files yet.")}</p>`;
    } else {
      const listEl = host.querySelector(".attachments-list");
      files.forEach((f, i) => listEl.appendChild(renderFileRow(f, files, i)));
    }

    if (opts.canUpload) wireUploadForm();
  }

  function renderFileRow(f, list, index) {
    const row = document.createElement("div");
    row.className = "attachment-row";
    const label = CATEGORY_LABELS[f.category] || f.category;
    // Delete is admin-only everywhere -- a technician can view (and, where
    // allowed, upload) but never remove anything, even their own upload.
    const canDelete = state.user.role === "admin";

    row.innerHTML = `
      <div class="attachment-info">
        <span class="attachment-name">${escapeHtml(f.originalName)}</span>
        <span class="attachment-meta">
          ${opts.trackExpiration && f.formType ? `${escapeHtml(f.formType)} &middot; ` : ""}${escapeHtml(label)} &middot; ${formatSize(f.size)} &middot; ${escapeHtml(f.uploadedBy)} &middot; ${new Date(f.uploadedAt).toLocaleDateString()}
        </span>
        ${opts.trackExpiration ? expiryBadge(f.expiresAt) : ""}
      </div>
      <div class="attachment-actions">
        <button type="button" class="btn btn-link view-btn">View</button>
        <button type="button" class="btn btn-link download-btn">Download</button>
        ${canDelete ? `<button type="button" class="btn btn-link danger-link delete-btn">Delete</button>` : ""}
      </div>
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

  // A document's own pop-up: metadata + Download/Delete on one side, a
  // large inline preview on the other, Previous/Next to move through the
  // same list this was opened from -- instead of a bare "Download" link
  // being the only way to see what a file actually is.
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

      previewHost.innerHTML = `<p class="doc-viewer-no-preview">Loading preview…</p>`;
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

  function renderUploadForm() {
    const categorySelect =
      opts.categories.length > 1
        ? `<select name="category">${opts.categories
            .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
            .join("")}</select>`
        : `<input type="hidden" name="category" value="${escapeHtml(opts.categories[0].value)}" />`;

    return `
      <form class="attachment-upload-form">
        ${categorySelect}
        ${opts.trackExpiration ? `<input name="formType" placeholder="Type (e.g. Certification)" />` : ""}
        ${opts.trackExpiration ? `<label class="attachment-expiry-field"><span>Expires</span><input type="date" name="expiresAt" /></label>` : ""}
        <input type="file" name="file" required />
        <button type="submit" class="btn btn-secondary">Upload</button>
        <span class="save-message upload-message"></span>
      </form>
    `;
  }

  function wireUploadForm() {
    const form = host.querySelector(".attachment-upload-form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const category = form.category.value;
      const file = form.file.files[0];
      if (!file) return;
      const msg = form.querySelector(".upload-message");
      try {
        await api.uploadFile(opts.relatedType, opts.relatedId, category, file, {
          formType: opts.trackExpiration ? form.formType.value.trim() : undefined,
          expiresAt: opts.trackExpiration ? form.expiresAt.value : undefined,
        });
        await refresh();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  }
}
