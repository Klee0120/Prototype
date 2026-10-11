// Shared page chrome for every logged-out screen (login, forgot-PIN, and
// the emailed PIN-reset page) -- same top bar / dark brand panel / footer
// around whatever form content the caller renders into the white card.
// Centralized here rather than copy-pasted into each view since all three
// need the exact same structure, just a different card.
export function renderAuthShell(cardHtml) {
  const wrap = document.createElement("div");
  wrap.className = "auth-page";
  wrap.innerHTML = `
    <header class="auth-topbar">
      <div class="auth-topbar-brand">ServiceWorks</div>
      <a class="auth-topbar-help" href="mailto:serviceworks.noreply@gmail.com">
        <span class="auth-help-icon" aria-hidden="true">?</span> Help &amp; support
      </a>
    </header>
    <div class="auth-body">
      <div class="auth-shell">
        <div class="auth-brand-panel">
          <div class="auth-logo-mark" aria-hidden="true">
            <span class="auth-logo-sq auth-logo-sq-1"></span>
            <span class="auth-logo-sq auth-logo-sq-2"></span>
          </div>
          <h1 class="auth-brand-headline">Everything<br />connected<span class="auth-brand-dot">.</span></h1>
          <p class="auth-brand-tagline">Toyota Operations &amp; Financial Management</p>
        </div>
        <div class="auth-form-panel">
          <div class="auth-card">${cardHtml}</div>
        </div>
      </div>
    </div>
    <footer class="auth-footer"><strong>ServiceWorks</strong> <span class="auth-footer-dot" aria-hidden="true">&bull;</span> Toyota Operations &amp; Financial Management</footer>
  `;
  return { wrap, card: wrap.querySelector(".auth-card") };
}
