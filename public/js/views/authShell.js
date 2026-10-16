import { t, renderLanguageToggle } from "../i18n.js";

// Shared page chrome for every logged-out screen (login, forgot-PIN, and
// the emailed PIN-reset page) -- same top bar / dark brand panel / footer
// around whatever form content the caller renders into the white card.
// Centralized here rather than copy-pasted into each view since all three
// need the exact same structure, just a different card. The language
// toggle needs no local re-render wiring: app.js's own render() already
// handles all three of these screens (it checks the reset-pin URL param
// before the logged-in/out branch), and app.js subscribes to language
// changes by calling that same render() -- so toggling here just works,
// the same way it does for the logged-in shell.
export function renderAuthShell(cardHtml) {
  const wrap = document.createElement("div");
  wrap.className = "auth-page";
  wrap.innerHTML = `
    <header class="auth-topbar">
      <div class="auth-topbar-brand">ServiceWorks</div>
      <div class="auth-topbar-right">
        <div class="auth-lang-tools"></div>
        <a class="auth-topbar-help" href="mailto:serviceworks.noreply@gmail.com">
          <span class="auth-help-icon" aria-hidden="true">?</span> ${escapeHtmlLocal(t("Help & support"))}
        </a>
      </div>
    </header>
    <div class="auth-body">
      <div class="auth-shell">
        <div class="auth-brand-panel">
          <div class="auth-logo-mark" aria-hidden="true">
            <span class="auth-logo-sq auth-logo-sq-1"></span>
            <span class="auth-logo-sq auth-logo-sq-2"></span>
          </div>
          <h1 class="auth-brand-headline">${t("Everything<br />connected.").replace("connected.", 'connected<span class="auth-brand-dot">.</span>')}</h1>
          <p class="auth-brand-tagline">${escapeHtmlLocal(t("Toyota Operations & Financial Management"))}</p>
        </div>
        <div class="auth-form-panel">
          <div class="auth-card">${cardHtml}</div>
        </div>
      </div>
    </div>
    <footer class="auth-footer"><strong>ServiceWorks</strong> <span class="auth-footer-dot" aria-hidden="true">&bull;</span> ${escapeHtmlLocal(t("Toyota Operations & Financial Management"))}</footer>
  `;
  wrap.querySelector(".auth-lang-tools").appendChild(renderLanguageToggle());
  return { wrap, card: wrap.querySelector(".auth-card") };
}

function escapeHtmlLocal(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
