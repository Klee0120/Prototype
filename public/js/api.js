function currentSessionToken() {
  try {
    const raw = localStorage.getItem("laborapp:user");
    if (!raw) return null;
    return JSON.parse(raw).token;
  } catch {
    return null;
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
  downloadFile,
  fetchFileBlob,
};
