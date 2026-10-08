import { api } from "../api.js";
import { escapeHtml } from "../app.js";
import { renderLoadingState, loadingLabelFor } from "../loadingState.js";
import { openModal } from "../modal.js";

const AUTH_TYPE_LABELS = {
  bearer: "Bearer Token",
  api_key: "API Key (custom header)",
  basic: "Basic Auth (username + password)",
};

function formatDateTime(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Admin-managed credentials for outside systems (UKG, Vroozi, JDE, Hubble,
// or anything else) -- just the connection/credential piece. Pulling or
// pushing real data for any given system is separate integration work,
// built once there's a real API spec and real credentials to test against
// (see server/utils/smartsheet.js for the one working example today).
// This page exists so that work has somewhere to read a credential from
// instead of a hardcoded env var, and so adding/rotating one doesn't need
// a developer.
export async function renderIntegrations(container) {
  renderLoadingState(container, loadingLabelFor("Integrations"));
  let connections;
  try {
    connections = await api.get("/api/admin/integrations");
  } catch (err) {
    container.innerHTML = `<p class="attachments-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-header-title">Integrations</h2>
        <p class="page-header-subtitle">
          Store a connection's URL and credential here, and test that it actually reaches the real API.
          This doesn't pull or push any data on its own yet -- that's built per system, once there's a
          real integration to wire up to a saved connection.
        </p>
      </div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-primary integration-add-btn">+ Add Connection</button>
      </div>
    </div>
    <div class="integrations-list"></div>
  `;

  container.querySelector(".integration-add-btn").addEventListener("click", () => openConnectionForm(container));

  renderList(container.querySelector(".integrations-list"), connections, container);
}

function statusBadge(connection) {
  if (!connection.lastTestStatus) return `<span class="badge badge-draft">Untested</span>`;
  if (connection.lastTestStatus === "ok") return `<span class="badge badge-approved">Reachable</span>`;
  return `<span class="badge badge-rejected">Failed</span>`;
}

function renderList(host, connections, container) {
  if (connections.length === 0) {
    host.innerHTML = `<p class="empty-note">No connections saved yet -- add one to start.</p>`;
    return;
  }
  host.innerHTML = `
    <table class="detail-table">
      <thead>
        <tr><th>Name</th><th>Base URL</th><th>Auth</th><th>Secret</th><th>Last tested</th><th></th></tr>
      </thead>
      <tbody>
        ${connections
          .map(
            (c) => `
          <tr data-id="${c.id}">
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.baseUrl)}</td>
            <td>${escapeHtml(AUTH_TYPE_LABELS[c.authType] || c.authType)}</td>
            <td><code>${escapeHtml(c.credentialPreview)}</code></td>
            <td>
              ${statusBadge(c)}
              <div class="review-checklist-hint" style="margin:0">${formatDateTime(c.lastTestedAt)}${c.lastTestDetail ? ` &mdash; ${escapeHtml(c.lastTestDetail)}` : ""}</div>
            </td>
            <td class="integration-row-actions">
              <button type="button" class="btn btn-secondary integration-test-btn" data-id="${c.id}">Test</button>
              <button type="button" class="btn btn-secondary integration-edit-btn" data-id="${c.id}">Edit</button>
              <button type="button" class="btn btn-link danger-link integration-delete-btn" data-id="${c.id}">Delete</button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  host.querySelectorAll(".integration-test-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        await api.post(`/api/admin/integrations/${btn.dataset.id}/test`, {});
      } catch (err) {
        window.alert(err.message);
      }
      await renderIntegrations(container);
    });
  });
  host.querySelectorAll(".integration-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const connection = connections.find((c) => String(c.id) === btn.dataset.id);
      openConnectionForm(container, connection);
    });
  });
  host.querySelectorAll(".integration-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const connection = connections.find((c) => String(c.id) === btn.dataset.id);
      if (!window.confirm(`Delete the "${connection.name}" connection? This can't be undone.`)) return;
      try {
        await api.delete(`/api/admin/integrations/${connection.id}`);
        await renderIntegrations(container);
      } catch (err) {
        window.alert(err.message);
      }
    });
  });
}

function openConnectionForm(container, existing) {
  const isEdit = Boolean(existing);
  const { body, close } = openModal({
    title: isEdit ? `Edit "${existing.name}"` : "Add Connection",
    bodyHtml: `
      <form class="modal-form integration-form">
        <label class="profile-field">
          <span>Name</span>
          <input name="name" value="${escapeHtml(existing?.name || "")}" placeholder="e.g. UKG, Vroozi, JDE, Hubble" required />
        </label>
        <label class="profile-field">
          <span>Base URL</span>
          <input name="baseUrl" value="${escapeHtml(existing?.baseUrl || "")}" placeholder="https://api.example.com" required />
        </label>
        <label class="profile-field">
          <span>Auth type</span>
          <select name="authType">
            ${Object.entries(AUTH_TYPE_LABELS)
              .map(([value, label]) => `<option value="${value}" ${existing?.authType === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
              .join("")}
          </select>
        </label>
        <label class="profile-field integration-field-api-key-header">
          <span>Header name</span>
          <input name="apiKeyHeader" value="${escapeHtml(existing?.apiKeyHeader || "")}" placeholder="e.g. X-API-Key" />
        </label>
        <label class="profile-field integration-field-username">
          <span>Username</span>
          <input name="username" value="${escapeHtml(existing?.username || "")}" />
        </label>
        <label class="profile-field">
          <span>${isEdit ? "New secret (leave blank to keep the current one)" : "Secret (token, key, or password)"}</span>
          <input name="credential" type="password" placeholder="${isEdit ? existing.credentialPreview : ""}" ${isEdit ? "" : "required"} />
        </label>
        <label class="profile-field">
          <span>Test path (optional)</span>
          <input name="testPath" value="${escapeHtml(existing?.testPath || "")}" placeholder="e.g. health or v1/ping -- appended to Base URL when you click Test" />
        </label>
        <label class="profile-field">
          <span>Notes</span>
          <textarea name="notes" placeholder="What this connection is for, who set it up, anything to remember">${escapeHtml(existing?.notes || "")}</textarea>
        </label>
        <div class="modal-form-actions">
          <button type="submit" class="btn btn-primary">${isEdit ? "Save" : "Add Connection"}</button>
        </div>
        <span class="save-message"></span>
      </form>
    `,
  });

  const form = body.querySelector(".integration-form");
  const authSelect = form.authType;
  function syncAuthFields() {
    form.querySelector(".integration-field-api-key-header").hidden = authSelect.value !== "api_key";
    form.querySelector(".integration-field-username").hidden = authSelect.value !== "basic";
  }
  authSelect.addEventListener("change", syncAuthFields);
  syncAuthFields();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".save-message");
    const payload = {
      name: form.name.value.trim(),
      baseUrl: form.baseUrl.value.trim(),
      authType: form.authType.value,
      apiKeyHeader: form.apiKeyHeader.value.trim(),
      username: form.username.value.trim(),
      testPath: form.testPath.value.trim(),
      notes: form.notes.value.trim(),
    };
    if (form.credential.value) payload.credential = form.credential.value;
    try {
      if (isEdit) await api.patch(`/api/admin/integrations/${existing.id}`, payload);
      else await api.post("/api/admin/integrations", payload);
      close();
      await renderIntegrations(container);
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}
