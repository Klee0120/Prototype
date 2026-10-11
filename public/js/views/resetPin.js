import { api } from "../api.js";

// Reached via the link emailed by POST /api/auth/forgot-pin -- a plain
// query param on the site's own root rather than a real route, since this
// app has no server-side router (see app.js's own check for this before
// deciding what to render). Deliberately shown regardless of whether
// someone is already logged in as themselves or someone else: clicking a
// reset link is its own distinct intent, not something that should get
// silently swallowed by an existing session.
export function renderResetPin(token) {
  const wrap = document.createElement("div");
  wrap.className = "login-wrap";
  wrap.innerHTML = `
    <div class="login-card" id="reset-pin-card">
      <form id="reset-pin-form">
        <h1>ServiceWorks</h1>
        <p class="login-sub">Set a new PIN</p>
        <label for="reset-pin-new">New PIN</label>
        <input id="reset-pin-new" name="pin" type="password" autocomplete="new-password" placeholder="8+ characters, 1 special" required />
        <label for="reset-pin-confirm">Confirm new PIN</label>
        <input id="reset-pin-confirm" name="confirmPin" type="password" autocomplete="new-password" placeholder="8+ characters, 1 special" required />
        <button type="submit" class="btn btn-primary">Set new PIN</button>
        <p class="login-error" id="reset-pin-error" hidden></p>
      </form>
      <p class="login-sub" id="reset-pin-success" hidden>Your PIN has been reset. <a href="/">Log in</a></p>
    </div>
  `;

  const form = wrap.querySelector("#reset-pin-form");
  const errorEl = wrap.querySelector("#reset-pin-error");
  const successEl = wrap.querySelector("#reset-pin-success");

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
