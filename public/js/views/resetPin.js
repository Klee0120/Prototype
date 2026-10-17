import { api } from "../api.js";
import { renderAuthShell } from "./authShell.js";

const LOCK_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;

// Reached via the link emailed by POST /api/auth/forgot-pin -- a plain
// query param on the site's own root rather than a real route, since this
// app has no server-side router (see app.js's own check for this before
// deciding what to render). Deliberately shown regardless of whether
// someone is already logged in as themselves or someone else: clicking a
// reset link is its own distinct intent, not something that should get
// silently swallowed by an existing session.
export function renderResetPin(token) {
  const { wrap, card } = renderAuthShell(`
    <div class="auth-icon-badge">${LOCK_ICON}</div>
    <p class="auth-eyebrow">Account recovery</p>
    <h2 class="auth-card-title">Set a new PIN</h2>
    <p class="auth-card-sub">Choose a new PIN to finish resetting your account.</p>
    <form id="reset-pin-form">
      <label for="reset-pin-new">New PIN</label>
      <input id="reset-pin-new" name="pin" type="password" autocomplete="new-password" placeholder="8+ characters, 1 special" required />
      <label for="reset-pin-confirm">Confirm new PIN</label>
      <input id="reset-pin-confirm" name="confirmPin" type="password" autocomplete="new-password" placeholder="8+ characters, 1 special" required />
      <button type="submit" class="auth-btn-primary">Set new PIN <span class="auth-btn-arrow" aria-hidden="true">&rarr;</span></button>
      <p class="auth-error" id="reset-pin-error" hidden></p>
    </form>
    <p class="auth-card-hint" id="reset-pin-success" hidden>Your PIN has been reset. <a href="/">Log in</a></p>
  `);

  const form = card.querySelector("#reset-pin-form");
  const errorEl = card.querySelector("#reset-pin-error");
  const successEl = card.querySelector("#reset-pin-success");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const pin = form.pin.value.trim();
    const confirmPin = form.confirmPin.value.trim();
    if (pin !== confirmPin) {
      errorEl.textContent = "Those PINs don't match.";
      errorEl.hidden = false;
      return;
    }
    try {
      await api.post("/api/auth/reset-pin", { token, pin });
      form.hidden = true;
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  return wrap;
}
