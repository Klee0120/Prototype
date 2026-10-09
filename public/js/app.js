import { api } from "./api.js";
import { renderLogin } from "./views/login.js";
import { renderTechHome } from "./views/techHome.js";
import { renderAdminReview } from "./views/adminReview.js";
import { mountTimeTracker } from "./views/timeTracker.js";

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

// Mobile sidebar drawer: the sidebar/backdrop elements get recreated on
// every full render() (login, logout, session-expiry), so these just look
// them up live rather than holding stale references -- closed is simply
// "the class isn't there," which is already true on every fresh render.
function openMobileNav() {
  document.querySelector(".app-sidebar")?.classList.add("mobile-nav-open");
  document.querySelector(".sidebar-backdrop")?.classList.add("visible");
}
function closeMobileNav() {
  document.querySelector(".app-sidebar")?.classList.remove("mobile-nav-open");
  document.querySelector(".sidebar-backdrop")?.classList.remove("visible");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMobileNav();
});

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

  const backdrop = document.createElement("div");
  backdrop.className = "sidebar-backdrop";
  backdrop.addEventListener("click", closeMobileNav);
  shell.appendChild(backdrop);

  const main = document.createElement("main");
  main.className = "app-main";
  main.appendChild(renderTopBar());
  const subtabBand = document.createElement("div");
  subtabBand.className = "subtab-band";
  subtabBand.id = "subtab-band";
  main.appendChild(subtabBand);
  const content = document.createElement("div");
  content.className = "content";
  content.id = "view-content";
  main.appendChild(content);
  shell.appendChild(main);

  root.innerHTML = "";
  root.appendChild(shell);

  const timeTrackerEl = mountTimeTracker();
  if (timeTrackerEl) shell.appendChild(timeTrackerEl);

  const navHost = shell.querySelector("#sidebar-nav");
  const topbarHost = main.querySelector("#topbar-context");
  const globalToolsHost = main.querySelector("#topbar-global-tools");
  if (state.user.role === "admin") {
    await renderAdminReview(content, navHost, topbarHost, subtabBand, globalToolsHost);
  } else {
    await renderTechHome(content, navHost, topbarHost, subtabBand);
  }
}

// The dark info bar at the top of the main pane (NOT spanning the sidebar
// -- the sidebar carries the real brand mark in its own corner) -- just a
// page title plus an empty #topbar-context slot the active view fills
// with whatever page-specific picker it needs (which technician, which
// week), left empty otherwise.
function renderTopBar() {
  const bar = document.createElement("div");
  bar.className = "app-topbar";
  bar.innerHTML = `
    <button type="button" class="mobile-nav-toggle" id="mobile-nav-toggle" aria-label="Open navigation">&#9776;</button>
    <div class="topbar-brand-text">
      <span class="topbar-brand-name">ServiceWorks</span>
      <span class="topbar-brand-sub">Toyota Operations &amp; Financial Management</span>
    </div>
    <div class="topbar-context" id="topbar-context"></div>
    <div class="topbar-global-tools" id="topbar-global-tools"></div>
  `;
  bar.querySelector("#mobile-nav-toggle").addEventListener("click", openMobileNav);
  return bar;
}

// A fixed left column, full height from the very top-left corner -- the
// real C&W Services logo up top, the active view's own nav in the middle
// via #sidebar-nav (filled in by renderAdminReview/renderTechHome, not
// here, since which sections/tabs exist is each view's own concern), user
// block pinned to the bottom. One persistent shell the whole app sits
// inside, rather than each page redrawing its own nav alongside its
// content on every tab switch.
function renderSidebar() {
  const sidebar = document.createElement("aside");
  sidebar.className = "app-sidebar";
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img class="sidebar-brand-logo" src="/img/cw-logo.webp" alt="Cushman &amp; Wakefield | C&amp;W Services" />
    </div>
    <nav class="sidebar-nav" id="sidebar-nav"></nav>
  `;
  sidebar.appendChild(renderSidebarUser());
  // Delegated rather than bound to individual nav items: adminReview.js/
  // techHome.js own #sidebar-nav's actual content and redraw it on every
  // tab switch, so a direct listener on an item would be gone the moment
  // its innerHTML is replaced. Listening on the sidebar itself survives
  // that, since the click still bubbles up through whatever's currently
  // sitting inside it.
  sidebar.addEventListener("click", (e) => {
    if (e.target.closest(".sidebar-nav-item")) closeMobileNav();
  });
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
