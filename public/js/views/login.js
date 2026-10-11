import { api } from "../api.js";
import { setUser, render } from "../app.js";
import { renderAuthShell } from "./authShell.js";

const LOCK_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;

function loginCardHtml(initialMessage) {
  return `
    <p class="auth-eyebrow">Sign in</p>
    <h2 class="auth-card-title">Welcome back</h2>
    <p class="auth-card-sub">Sign in with your technician ID or admin code.</p>
    <form id="login-form">
      <label for="login-id">Employee ID</label>
      <input id="login-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <label for="login-pin">PIN</label>
      <input id="login-pin" name="pin" type="password" autocomplete="current-password" placeholder="Enter your PIN" required />
      <button type="submit" class="auth-btn-primary">Log in <span class="auth-btn-arrow" aria-hidden="true">&rarr;</span></button>
      <p class="auth-error" id="login-error" ${initialMessage ? "" : "hidden"}>${initialMessage || ""}</p>
    </form>
    <button type="button" class="auth-link-btn" id="login-forgot-pin">Forgot your PIN?</button>
  `;
}

function forgotPinCardHtml() {
  return `
    <div class="auth-icon-badge">${LOCK_ICON}</div>
    <p class="auth-eyebrow">Account recovery</p>
    <h2 class="auth-card-title">Forgot your PIN?</h2>
    <p class="auth-card-sub">Enter your ID and, if there's an email on file for it, we'll send a link to set a new PIN.</p>
    <form id="forgot-pin-form">
      <label for="forgot-id">Employee ID</label>
      <input id="forgot-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <button type="submit" class="auth-btn-primary">Send reset link <span class="auth-btn-arrow" aria-hidden="true">&rarr;</span></button>
    </form>
    <p class="auth-card-hint" id="forgot-result">A reset link will be sent if your ID has an email on file.</p>
    <button type="button" class="auth-link-btn" id="forgot-back">&larr; Back to log in</button>
  `;
}

function wireLoginCard(card) {
  const form = card.querySelector("#login-form");
  const errorEl = card.querySelector("#login-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const id = form.id.value.trim();
    const pin = form.pin.value.trim();
    try {
      const user = await api.post("/api/auth/login", { id, pin });
      setUser(user);
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  card.querySelector("#login-forgot-pin").addEventListener("click", () => {
    card.innerHTML = forgotPinCardHtml();
    wireForgotPinCard(card);
  });
}

function wireForgotPinCard(card) {
  const form = card.querySelector("#forgot-pin-form");
  const resultEl = card.querySelector("#forgot-result");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = form.id.value.trim();
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const res = await api.post("/api/auth/forgot-pin", { id });
      resultEl.textContent = res.message;
      form.id.value = "";
    } catch (err) {
      resultEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  card.querySelector("#forgot-back").addEventListener("click", () => {
    card.innerHTML = loginCardHtml();
    wireLoginCard(card);
  });
}

export function renderLogin(initialMessage) {
  const { wrap, card } = renderAuthShell(loginCardHtml(initialMessage));
  wireLoginCard(card);
  return wrap;
}
