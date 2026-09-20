import { api } from "./api.js";
import { renderLogin } from "./views/login.js";
import { renderTechWeek } from "./views/techWeek.js";
import { renderAdminReview } from "./views/adminReview.js";

export const state = {
  user: loadUser(),
  weekMonday: null,
};

function loadUser() {
  try {
    const raw = localStorage.getItem("laborapp:user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setUser(user) {
  state.user = user;
  if (user) {
    localStorage.setItem("laborapp:user", JSON.stringify(user));
  } else {
    localStorage.removeItem("laborapp:user");
  }
}

export async function logout() {
  try {
    await api.post("/api/auth/logout");
  } catch {
    // Session may already be expired/invalid server-side; clear locally regardless.
  }
  setUser(null);
  render();
}

export function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const root = document.getElementById("app");

export async function render() {
  if (!state.user) {
    root.innerHTML = "";
    root.appendChild(renderLogin());
    return;
  }

  if (!state.weekMonday) {
    const meta = await api.get("/api/meta/current-week");
    state.weekMonday = meta.weekMonday;
  }

  const shell = document.createElement("div");
  shell.className = "shell";
  shell.appendChild(renderHeader());

  const content = document.createElement("div");
  content.className = "content";
  content.id = "view-content";
  shell.appendChild(content);

  root.innerHTML = "";
  root.appendChild(shell);

  if (state.user.role === "admin") {
    await renderAdminReview(content);
  } else {
    await renderTechWeek(content);
  }
}

function renderHeader() {
  const header = document.createElement("header");
  header.className = "app-header";
  header.innerHTML = `
    <div class="app-header-title">
      <span class="app-name">Labor Allocation</span>
      <span class="app-user">${escapeHtml(state.user.name)} &middot; ${state.user.role === "admin" ? "Admin" : "Technician"}</span>
    </div>
    <button class="btn btn-ghost" id="logout-btn">Log out</button>
  `;
  header.querySelector("#logout-btn").addEventListener("click", logout);
  return header;
}

render();
