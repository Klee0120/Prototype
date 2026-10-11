import { api } from "../api.js";
import { setUser, render } from "../app.js";

function renderForgotPin(wrap) {
  wrap.innerHTML = `
    <form class="login-card" id="forgot-pin-form">
      <h1>ServiceWorks</h1>
      <p class="login-sub">Forgot your PIN?</p>
      <p class="login-sub">Enter your ID and, if there's an email on file for it, we'll send a link to set a new PIN.</p>
      <label for="forgot-id">ID</label>
      <input id="forgot-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <button type="submit" class="btn btn-primary">Send reset link</button>
      <p class="login-sub" id="forgot-result" hidden></p>
      <button type="button" class="btn btn-link" id="forgot-back">&larr; Back to log in</button>
    </form>
  `;

  const form = wrap.querySelector("#forgot-pin-form");
  const resultEl = wrap.querySelector("#forgot-result");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = form.id.value.trim();
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const res = await api.post("/api/auth/forgot-pin", { id });
      resultEl.textContent = res.message;
      resultEl.hidden = false;
      form.id.value = "";
    } catch (err) {
      resultEl.textContent = err.message;
      resultEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  wrap.querySelector("#forgot-back").addEventListener("click", () => {
    wrap.replaceWith(renderLogin());
  });
}

export function renderLogin(initialMessage) {
  const wrap = document.createElement("div");
  wrap.className = "login-wrap";
  wrap.innerHTML = `
    <form class="login-card" id="login-form">
      <h1>ServiceWorks</h1>
      <p class="login-sub">Toyota Operations &amp; Financial Management</p>
      <p class="login-sub">Sign in with your technician ID or admin code.</p>
      <label for="login-id">ID</label>
      <input id="login-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <label for="login-pin">PIN</label>
      <input id="login-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="****" required />
      <button type="submit" class="btn btn-primary">Log in</button>
      <button type="button" class="btn btn-link" id="login-forgot-pin">Forgot your PIN?</button>
      <p class="login-error" id="login-error" ${initialMessage ? "" : "hidden"}>${initialMessage || ""}</p>
    </form>
  `;

  const form = wrap.querySelector("#login-form");
  const errorEl = wrap.querySelector("#login-error");

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

  wrap.querySelector("#login-forgot-pin").addEventListener("click", () => renderForgotPin(wrap));

  return wrap;
}
