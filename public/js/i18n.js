// App-wide language toggle (EN/ES) -- same pub-sub + localStorage pattern
// as globalFilters.js's territory selector, so it works the same way
// everywhere and survives a refresh. `t(str)` takes the English string
// itself as its key (not a separate key namespace): when a translation
// exists for the current language it's returned, otherwise the English
// string passes through unchanged. That lets translation coverage grow
// incrementally across the app -- a view nobody's gotten to yet just
// renders in English even with Spanish selected, instead of breaking.
const LANG_KEY = "sw-language";

function loadLanguage() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

let language = loadLanguage();
const listeners = new Set();

export function getLanguage() {
  return language;
}

export function setLanguage(value) {
  language = value === "es" ? "es" : "en";
  try {
    localStorage.setItem(LANG_KEY, language);
  } catch {
    // Private-browsing/storage-blocked -- still works for the rest of this visit.
  }
  listeners.forEach((fn) => fn(language));
}

// Returns an unsubscribe function, same convention as DOM event cleanup.
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Machine-translated initially -- flagged for a native/fluent speaker to
// review before techs rely on it for anything pay- or compliance-related
// (see README). New entries get added here as more of the app is covered;
// nothing elsewhere needs to change when a string gets added.
const es = {
  // -- app.js shell (sidebar, topbar, logout) --
  "Log out": "Cerrar sesión",
  Admin: "Administrador",
  Technician: "Técnico",
  "Your session expired -- please log in again.": "Su sesión expiró -- inicie sesión de nuevo.",
  "Toyota Operations & Financial Management": "Operaciones y Gestión Financiera de Toyota",

  // -- authShell.js / login.js --
  "Help & support": "Ayuda y soporte",
  "Everything<br />connected.": "Todo<br />conectado.",
  "Sign in": "Iniciar sesión",
  "Welcome back": "Bienvenido de nuevo",
  "Sign in with your technician ID or admin code.": "Inicie sesión con su ID de técnico o código de administrador.",
  "Employee ID": "ID de empleado",
  PIN: "PIN",
  "e.g. T1001": "ej. T1001",
  "Enter your PIN": "Ingrese su PIN",
  "Log in": "Iniciar sesión",
  "Forgot your PIN?": "¿Olvidó su PIN?",
  "Account recovery": "Recuperación de cuenta",
  "Enter your ID and, if there's an email on file for it, we'll send a link to set a new PIN.":
    "Ingrese su ID y, si hay un correo electrónico registrado, le enviaremos un enlace para establecer un nuevo PIN.",
  "Send reset link": "Enviar enlace de restablecimiento",
  "A reset link will be sent if your ID has an email on file.":
    "Se enviará un enlace de restablecimiento si su ID tiene un correo electrónico registrado.",
  "Back to log in": "Volver a iniciar sesión",

  // -- techHome.js nav (sidebar tabs) --
  "My Work": "Mi Trabajo",
  "My Week": "Mi Semana",
  "Time Off": "Tiempo Libre",
  Schedule: "Horario",
  "Locations &amp; WOM": "Ubicaciones y WOM",
  Vendors: "Proveedores",
  "My Documents": "Mis Documentos",
  // The rest of techHome.js (vendor list, locations/WOM list, the WOM
  // classification reference content, PO-request modal) is deliberately
  // still English-only -- see the README note on translation coverage.
};

const translations = { es };

export function t(str) {
  if (language !== "es") return str;
  return translations.es[str] || str;
}

// Shared EN/ES switcher -- used in the topbar (post-login, both roles) and
// in the logged-out auth shell (login/forgot-PIN/reset-PIN), so a tech can
// switch before ever signing in. Reuses the app's existing pill-tab look
// (.tab/.tab.active) rather than introducing a new control style. Toggling
// just updates the stored language and lets onLanguageChange's
// subscribers (app.js re-renders the whole shell) handle redrawing
// everything in the new language -- this function doesn't re-render
// itself, so the caller doesn't need to track/replace this specific node.
export function renderLanguageToggle() {
  const el = document.createElement("div");
  el.className = "lang-toggle";
  el.innerHTML = `
    <button type="button" class="tab lang-toggle-btn ${language === "en" ? "active" : ""}" data-lang="en">EN</button>
    <button type="button" class="tab lang-toggle-btn ${language === "es" ? "active" : ""}" data-lang="es">ES</button>
  `;
  el.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
  });
  return el;
}
