// Self-contained EN/ES toggle for the extension popup -- the extension is
// a separate bundle from the main app (Chrome loads only the files listed
// under public/extension/, not the rest of public/js/), so this can't
// import public/js/i18n.js the way the main app's views do. Same t(str)
// shape and the same "English string is the key" approach, just backed by
// chrome.storage.local (async) instead of localStorage (sync), since
// that's already this extension's own persistence (see shared.js).

const LANG_KEY = "serviceworks_language";

let language = "en"; // real value loaded by loadLanguage() before first render

export async function loadLanguage() {
  try {
    const stored = await chrome.storage.local.get(LANG_KEY);
    language = stored[LANG_KEY] === "es" ? "es" : "en";
  } catch {
    language = "en";
  }
  return language;
}

export function getLanguage() {
  return language;
}

// onChange is called after the new value is persisted -- the caller (popup.js)
// passes its own re-render function, since this module has no render loop
// of its own to drive.
export async function setLanguage(value, onChange) {
  language = value === "es" ? "es" : "en";
  try {
    await chrome.storage.local.set({ [LANG_KEY]: language });
  } catch {
    // Still works for the rest of this popup session even if storage is blocked.
  }
  if (onChange) onChange();
}

export function t(str) {
  if (language !== "es") return str;
  return es[str] || str;
}

export function renderLanguageToggle(onChange) {
  const el = document.createElement("div");
  el.className = "lang-toggle";
  el.innerHTML = `
    <button type="button" class="link-btn lang-toggle-btn ${language === "en" ? "lang-toggle-btn-active" : ""}" data-lang="en">EN</button>
    <button type="button" class="link-btn lang-toggle-btn ${language === "es" ? "lang-toggle-btn-active" : ""}" data-lang="es">ES</button>
  `;
  el.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLanguage(btn.dataset.lang, onChange));
  });
  return el;
}

// Machine-translated -- same caveat as the main app's i18n.js: needs a
// native/fluent speaker to review before anyone relies on it for anything
// pay-related.
const es = {
  "Log out": "Cerrar sesión",
  "Employee ID": "ID de empleado",
  PIN: "PIN",
  "e.g. T1001": "ej. T1001",
  "Enter your PIN": "Ingrese su PIN",
  "Log in": "Iniciar sesión",
  "This widget is for admin accounts only.": "Este widget es solo para cuentas de administrador.",
  "Admin accounts only -- this widget tracks your own time against ServiceWorks.":
    "Solo cuentas de administrador -- este widget registra su propio tiempo en ServiceWorks.",
  "Signed in as": "Sesión iniciada como",
  "Link before stopping": "Vincular antes de detener",
  "Before stopping": "Antes de detener",
  "link it to": "vincúlelo a",
  "a vendor": "un proveedor",
  "a PO": "una PO",
  "to sync it.": "para sincronizarlo.",
  "Search vendor name...": "Buscar nombre de proveedor...",
  "Search PO # or description...": "Buscar # de PO o descripción...",
  "No matching PO? Describe it instead:": "¿No hay una PO coincidente? Descríbala en su lugar:",
  "PO description or code...": "Descripción o código de la PO...",
  "Stop & save": "Detener y guardar",
  Cancel: "Cancelar",
  "Still working on this? Started": "¿Sigue trabajando en esto? Comenzó",
  "Auto-stops after 12h.": "Se detiene automáticamente después de 12h.",
  "Note (optional)": "Nota (opcional)",
  "Tech:": "Técnico:",
  Unlink: "Desvincular",
  "Assign a tech (search name/ID)...": "Asignar un técnico (buscar nombre/ID)...",
  "PO linked": "PO vinculada",
  "Link a PO (search #, description)...": "Vincular una PO (buscar #, descripción)...",
  Stop: "Detener",
  "Pick what you're working on": "Elija en qué está trabajando",
  "Start tracking:": "Comenzar a registrar:",
  "Pick a category, then confirm Start.": "Elija una categoría, luego confirme Comenzar.",
  "Switch to": "Cambiar a",
  "Quick log": "Registro rápido",
  Logged: "Registrado",
  "Reference # (Request #, Maximo #...)": "# de Referencia (# de Solicitud, # de Maximo...)",
  "Or link a PO (search #, description)...": "O vincule una PO (buscar #, descripción)...",
  Done: "Listo",
  "End of day log": "Registro de fin del día",
  Minutes: "Minutos",
  Log: "Registrar",
  "Enter a number of minutes greater than 0.": "Ingrese un número de minutos mayor que 0.",
  "Enter valid start and end times.": "Ingrese horas de inicio y fin válidas.",
  "Recent entries": "Entradas recientes",
  Save: "Guardar",
  "Edit times": "Editar horas",
  "PO / Invoice (unplanned)": "PO / Factura (no planificado)",
  "Vendor Onboarding": "Incorporación de Proveedores",
  "Timekeeping (Review of Tech)": "Control de Horario (Revisión de Técnico)",
  "Timekeeping - Enter UKG": "Control de Horario - Ingresar UKG",
  "Project Status Review": "Revisión de Estado del Proyecto",
  "Operations Meeting": "Reunión de Operaciones",
  "Safety Meeting": "Reunión de Seguridad",
  Reclasses: "Reclasificaciones",
  "COI Renewals": "Renovaciones de COI",
  "Employee Support": "Apoyo a Empleados",
  Invoicing: "Facturación",
  "Document Management": "Gestión de Documentos",
  "Order Supplies/Parts": "Pedir Suministros/Repuestos",
  "Uniform Ordering": "Pedido de Uniformes",
  "General / Other": "General / Otro",
  "PO Entered (Tech Ordered)": "PO Ingresada (Pedido por Técnico)",
  "Attach PO to Tracker": "Adjuntar PO al Rastreador",
  "Enter WOM": "Ingresar WOM",
  "Enter PO (Invoice Found, Missed Order)": "Ingresar PO (Factura Encontrada, Pedido Omitido)",
  "Vendor Correspondence": "Correspondencia con Proveedores",
};
