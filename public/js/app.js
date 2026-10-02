import { api } from "./api.js";
import { renderLogin } from "./views/login.js";
import { renderTechHome } from "./views/techHome.js";
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

// The header is built once per render() call and never reactive on its
// own -- renaming yourself (Roster -> Manage admin accounts -> Edit) used
// to update state.user/localStorage via setUser above but leave the
// header's own DOM showing the old name until the next full page load,
// which read as "the rename didn't actually work." Call this right after
// setUser whenever the change could affect what the header displays (your
// own name).
export function refreshHeader() {
  const existing = document.querySelector(".sidebar-user");
  if (existing) existing.replaceWith(renderSidebarUser());
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

// A session dying server-side (expired, or a restart that lost it) used to
// leave every tab that fetches data silently blank -- the header still
// showed the logged-in name from cached state, and nothing ever
// re-checked it until this stopped being silent. api.js can't import from
// here (this module already imports api.js), so it broadcasts a plain
// window event on any 401 from a request that believed it had a token;
// this is the one place that reacts, however many of a page's parallel
// API calls happened to hit it first (the loggedOutMessage guard below
// keeps a second/third simultaneous 401 from re-triggering the redirect).
let loggedOutMessage = null;
window.addEventListener("laborapp:session-expired", () => {
  if (!state.user) return;
  setUser(null);
  loggedOutMessage = "Your session expired -- please log in again.";
  render();
});

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
    root.appendChild(renderLogin(loggedOutMessage));
    loggedOutMessage = null;
    return;
  }

  if (!state.weekMonday) {
    if (state.user.role === "admin") {
      const meta = await api.get("/api/meta/current-week");
      state.weekMonday = meta.weekMonday;
    } else {
      const meta = await api.get(`/api/technicians/${state.user.id}/open-week`);
      state.weekMonday = meta.weekMonday;
    }
  }

  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.appendChild(renderSidebar());

  const main = document.createElement("main");
  main.className = "app-main";
  const content = document.createElement("div");
  content.className = "content";
  content.id = "view-content";
  main.appendChild(content);
  shell.appendChild(main);

  root.innerHTML = "";
  root.appendChild(shell);

  const navHost = shell.querySelector("#sidebar-nav");
  if (state.user.role === "admin") {
    await renderAdminReview(content, navHost);
  } else {
    await renderTechHome(content, navHost);
  }
}

// A fixed left column (brand up top, the active view's own nav in the
// middle via #sidebar-nav -- filled in by renderAdminReview/renderTechHome,
// not here, since which sections/tabs exist is each view's own concern,
// user block pinned to the bottom) replaces the old full-width header +
// horizontal nav-sections row. One persistent shell the whole app sits
// inside, rather than each page redrawing its own nav alongside its
// content on every tab switch.
function renderSidebar() {
  const sidebar = document.createElement("aside");
  sidebar.className = "app-sidebar";
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <div class="app-logo-mark">LA</div>
      <span class="sidebar-brand-name">Labor Allocation</span>
    </div>
    <nav class="sidebar-nav" id="sidebar-nav"></nav>
  `;
  sidebar.appendChild(renderSidebarUser());
  return sidebar;
}

function renderSidebarUser() {
  const el = document.createElement("div");
  el.className = "sidebar-user";
  const initials = state.user.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  el.innerHTML = `
    <div class="sidebar-user-row">
      <div class="sidebar-user-avatar">${escapeHtml(initials)}</div>
      <div class="sidebar-user-text">
        <span class="sidebar-user-name">${escapeHtml(state.user.name)}</span>
        <span class="sidebar-user-role">${state.user.role === "admin" ? "Admin" : "Technician"}</span>
      </div>
    </div>
    <button class="btn btn-ghost sidebar-logout-btn" id="logout-btn">Log out</button>
  `;
  el.querySelector("#logout-btn").addEventListener("click", logout);
  return el;
}

render();
