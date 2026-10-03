function currentSessionToken() {
  try {
    const raw = localStorage.getItem("laborapp:user");
    if (!raw) return null;
    return JSON.parse(raw).token;
  } catch {
    return null;
  }
}

// A 401 on a request that *believed* it was authenticated (a token was
// attached) means the session died server-side -- expired, or the server
// restarted and this specific token's row is gone. Left alone, every tab
// that fetches data on load just throws silently and stays blank, while
// the header still shows the logged-in name from cached state, since
// nothing else ever re-checks it. Broadcasting this (rather than each
// call site handling it) means one login page redirect regardless of
// which of the many API calls on a page happened to be the one that hit
// it first, without api.js importing app.js (see app.js's listener).
function reportIfSessionExpired(status, token) {
  if (status === 401 && token) {
    window.dispatchEvent(new CustomEvent("laborapp:session-expired"));
  }
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = currentSessionToken();
  if (token) headers["x-session-token"] = token;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    reportIfSessionExpired(res.status, token);
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function uploadFile(relatedType, relatedId, category, file, extra) {
  const form = new FormData();
  form.append("relatedType", relatedType);
  form.append("relatedId", relatedId);
  form.append("category", category);
  form.append("file", file);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) form.append(key, value);
    }
  }

  const headers = {};
  const token = currentSessionToken();
  if (token) headers["x-session-token"] = token;

  const res = await fetch("/api/files", { method: "POST", headers, body: form });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    reportIfSessionExpired(res.status, token);
    throw new Error((data && data.error) || `Upload failed (${res.status})`);
  }
  return data;
}

// A plain "upload this one file to this one endpoint" helper -- unlike
// uploadFile above, not tied to the /api/files relatedType/relatedId/
// category shape (used by the PO Tracker's Excel import, which posts
// straight to /api/admin/pos/import with just a dryRun flag).
async function uploadRawFile(path, file, fields) {
  const form = new FormData();
  form.append("file", file);
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value != null) form.append(key, value);
    }
  }
  const headers = {};
  const token = currentSessionToken();
  if (token) headers["x-session-token"] = token;

  const res = await fetch(path, { method: "POST", headers, body: form });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    reportIfSessionExpired(res.status, token);
    throw new Error((data && data.error) || `Upload failed (${res.status})`);
  }
  return data;
}

async function fetchFileBlob(id) {
  const headers = {};
  const token = currentSessionToken();
  if (token) headers["x-session-token"] = token;

  const res = await fetch(`/api/files/${encodeURIComponent(id)}/download`, { headers });
  if (!res.ok) {
    reportIfSessionExpired(res.status, token);
    let message = `Could not load file (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.blob();
}

async function downloadFile(id, filename) {
  const blob = await fetchFileBlob(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  patch: (path, body) => request("PATCH", path, body),
  delete: (path, body) => request("DELETE", path, body),
  uploadFile,
  uploadRawFile,
  downloadFile,
  fetchFileBlob,
};
