import { api } from "../api.js";
import { state, escapeHtml } from "../app.js";

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
        const list = section.querySelector(".attachments-list");
        if (catFiles.length === 0) {
          list.innerHTML = `<p class="empty-note">No ${escapeHtml(catLabel.toLowerCase())}s saved for this month yet.</p>`;
        } else {
          catFiles.forEach((f) => list.appendChild(renderFileRow(f)));
        }
        sectionsHost.appendChild(section);
      }
    } else if (!loadError && files.length === 0) {
      host.querySelector(".attachments-list").innerHTML = `<p class="empty-note">${escapeHtml(opts.emptyText || "No files yet.")}</p>`;
    } else {
      const list = host.querySelector(".attachments-list");
      files.forEach((f) => list.appendChild(renderFileRow(f)));
    }

    if (opts.canUpload) wireUploadForm();
  }

  function renderFileRow(f) {
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
        <button type="button" class="btn btn-link download-btn">Download</button>
        ${canDelete ? `<button type="button" class="btn btn-link danger-link delete-btn">Delete</button>` : ""}
      </div>
    `;

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
