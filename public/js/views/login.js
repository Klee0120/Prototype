import { api } from "../api.js";
import { setUser, render } from "../app.js";

export function renderLogin() {
  const wrap = document.createElement("div");
  wrap.className = "login-wrap";
  wrap.innerHTML = `
    <form class="login-card" id="login-form">
      <h1>Labor Allocation</h1>
      <p class="login-sub">Sign in with your technician ID or admin code.</p>
      <label for="login-id">ID</label>
      <input id="login-id" name="id" type="text" autocomplete="username" placeholder="e.g. T1001" required />
      <label for="login-pin">PIN</label>
      <input id="login-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="****" required />
      <button type="submit" class="btn btn-primary">Log in</button>
      <p class="login-error" id="login-error" hidden></p>
      <p class="login-hint">Demo logins: T1001 / 1234, T1002 / 1234, T1003 / 2345, ADMIN / 9999</p>
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

  return wrap;
}
