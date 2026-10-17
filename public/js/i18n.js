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

  // -- techWeek.js (My Week) --
  Draft: "Borrador",
  "Submitted — awaiting review": "Enviado — esperando revisión",
  "Approved & locked": "Aprobado y bloqueado",
  "Returned — needs changes": "Devuelto — necesita cambios",
  Vacation: "Vacaciones",
  Sick: "Enfermedad",
  Bereavement: "Duelo",
  Holiday: "Día festivo",
  "Floating Holiday": "Día festivo flotante",
  Week: "Semana",
  "Previous week": "Semana anterior",
  "Next week": "Semana siguiente",
  Prev: "Ant.",
  Next: "Sig.",
  "UKG total hours<br>(source of truth)": "Horas totales UKG<br>(fuente oficial)",
  "Allocated hours": "Horas asignadas",
  Remaining: "Restante",
  Status: "Estado",
  "Weekend hours": "Horas de fin de semana",
  "Save weekend hours": "Guardar horas de fin de semana",
  "Weekly Summary": "Resumen Semanal",
  "UKG total hours": "Horas totales UKG",
  "Quick Actions": "Acciones Rápidas",
  "Save draft": "Guardar borrador",
  "I confirm these allocations reflect the work I performed this week.":
    "Confirmo que estas asignaciones reflejan el trabajo que realicé esta semana.",
  "Submit for review": "Enviar para revisión",
  "Print / Export": "Imprimir / Exportar",
  "Notify me by": "Notificarme por",
  "In-app only": "Solo en la app",
  Email: "Correo electrónico",
  "(ask admin to add your email first)": "(pida al administrador que agregue su correo primero)",
  "Weekend entry": "Entrada de fin de semana",
  "UKG ACTUAL:": "UKG REAL:",
  "Add split": "Agregar división",
  "Default to home": "Predeterminar a sede",
  hrs: "hrs",
  Balanced: "Equilibrado",
  "Off by": "Diferencia de",
  "No hours logged.": "No se registraron horas.",
  "Not yet allocated.": "Aún no asignado.",
  "Time off": "Tiempo libre",
  "No approved time off on file for this day.": "No hay tiempo libre aprobado registrado para este día.",
  home: "sede",
  Location: "Ubicación",
  "WOM Project": "Proyecto WOM",
  "No open WOMs at this location": "No hay WOM abiertos en esta ubicación",
  "Remove split": "Eliminar división",
  Undo: "Deshacer",
  "Mark this WOM project complete": "Marcar este proyecto WOM como completo",
  "Weekly Receipt — Reg / OT Breakdown": "Recibo Semanal — Desglose de Regular / Horas Extra",
  "Week Total (Worked)": "Total Semanal (Trabajado)",
  Regular: "Regular",
  Overtime: "Horas Extra",
  "OT on WOM": "Horas Extra en WOM",
  "OT not on WOM": "Horas Extra sin WOM",
  "Time Off": "Tiempo Libre",
  Bucket: "Categoría",
  Type: "Tipo",
  Reg: "Reg",
  OT: "HE",
  Total: "Total",
  "OT rule: hours beyond 40/week are automatic overtime, calculated on the week's total (not day-by-day). WOM-allocated hours are charged to OT before E&amp;F hours. Time off is paid straight time and isn't counted toward the 40-hour threshold. When OT spans more than one WOM, it's split proportionally across them.":
    "Regla de horas extra: las horas que exceden 40/semana son horas extra automáticas, calculadas sobre el total semanal (no día por día). Las horas asignadas a WOM se cargan a horas extra antes que las horas de E&amp;F. El tiempo libre se paga a tarifa regular y no cuenta para el umbral de 40 horas. Cuando las horas extra abarcan más de un WOM, se dividen proporcionalmente entre ellos.",
  "Draft saved.": "Borrador guardado.",
  "Weekend hours saved -- your admin will review, correct if needed, and accept them.":
    "Horas de fin de semana guardadas -- su administrador las revisará, corregirá si es necesario, y las aceptará.",
  "Flag a punch issue": "Reportar un problema de marcación",
  "What happened? (optional)": "¿Qué pasó? (opcional)",
  Submit: "Enviar",
  Cancel: "Cancelar",
  "Admin note:": "Nota del administrador:",
  "This week is locked.": "Esta semana está bloqueada.",
  "Unlock for correction": "Desbloquear para corrección",
  "This week is locked. Contact an admin to make corrections.": "Esta semana está bloqueada. Contacte a un administrador para hacer correcciones.",
  "The window to adjust this week has closed. Contact an admin if it needs correction.":
    "El plazo para ajustar esta semana ha cerrado. Contacte a un administrador si necesita corrección.",
  "This week isn't open for full allocation yet. Any approved time off will show here automatically; everything else opens up closer to the week itself.":
    "Esta semana aún no está abierta para asignación completa. Cualquier tiempo libre aprobado aparecerá aquí automáticamente; todo lo demás se abre más cerca de la semana.",
  "Your hours are in — go ahead and allocate your time below.": "Sus horas ya están registradas — adelante, asigne su tiempo abajo.",
  Attachments: "Archivos Adjuntos",
  "UKG Timesheet Screenshot": "Captura de Pantalla de UKG",
  "Receipt / Invoice": "Recibo / Factura",
  "No UKG screenshots or receipts attached yet.": "Aún no hay capturas de UKG o recibos adjuntos.",
  // Dynamic, status-embedding sentences in techWeek.js (weekend-section
  // hint/addendum note, the OT/short-hours self-check questions, punch-
  // issue messages, the mark-complete confirm dialog) are deliberately
  // still English-only -- pay-related explanatory text, worth a careful
  // translation pass rather than a quick mechanical one.

  // -- timeTracker.js (admin-only widget) --
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
  "Track time": "Registrar tiempo",
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
  "Start tracking:": "Comenzar a registrar:",
  "Quick log": "Registro rápido",
  Logged: "Registrado",
  "Reference # (Request #, Maximo #...)": "# de Referencia (# de Solicitud, # de Maximo...)",
  "PO linked": "PO vinculada",
  Unlink: "Desvincular",
  "Or link a PO (search #, description)...": "O vincule una PO (buscar #, descripción)...",
  Done: "Listo",
  "End of day log": "Registro de fin del día",
  Minutes: "Minutos",
  "Note (optional)": "Nota (opcional)",
  Log: "Registrar",
  "Enter a number of minutes greater than 0.": "Ingrese un número de minutos mayor que 0.",
  "Enter valid start and end times.": "Ingrese horas de inicio y fin válidas.",
  "Still working on this? Started": "¿Sigue trabajando en esto? Comenzó",
  "A forgotten timer auto-stops after 12h.": "Un temporizador olvidado se detiene automáticamente después de 12h.",
  "Tech:": "Técnico:",
  "Assign a tech (search name/ID)...": "Asignar un técnico (buscar nombre/ID)...",
  "Link a PO (search #, description)...": "Vincular una PO (buscar #, descripción)...",
  Stop: "Detener",
  "Pick what you're working on, then confirm Start.": "Elija en qué está trabajando, luego confirme Comenzar.",
  "Recent entries": "Entradas recientes",
  Save: "Guardar",
  "Edit times": "Editar horas",

  // -- adminReview.js (shared nav/chrome) --
  Priorities: "Prioridades",
  Timekeeping: "Control de Horario",
  Roster: "Plantilla",
  Vendors: "Proveedores",
  Locations: "Ubicaciones",
  WOM: "WOM",
  POs: "Órdenes de Compra",
  Financials: "Finanzas",
  Performance: "Desempeño",
  "Audit Trail": "Registro de Auditoría",
  Integrations: "Integraciones",
  "My Work": "Mi Trabajo",
  Checklist: "Lista de Verificación",
  "Tech Allocation": "Asignación de Técnicos",
  Schedule: "Horario",
  Overview: "Resumen",
  "Weekly Review": "Revisión Semanal",
  "Fiscal Calendar": "Calendario Fiscal",
  "Time Off": "Tiempo Libre",
  Invoicing: "Facturación",
  Reclasses: "Reclasificaciones",
  Reconciliation: "Reconciliación",
  "Spend Analysis": "Análisis de Gastos",
  "Budget Review": "Revisión de Presupuesto",
  "Cell Phones": "Teléfonos Celulares",
  Meals: "Comidas",
  Reports: "Informes",
  Technicians: "Técnicos",
  "Vendor Directory": "Directorio de Proveedores",
  Onboarding: "Incorporación",
  "Vendor Compliance": "Cumplimiento de Proveedores",
  "WOM Projects": "Proyectos WOM",
  "WOM Lookup": "Búsqueda de WOM",
  "Budget PO Tracker": "Rastreador de PO Presupuestario",
  "Onboard Requirements Form": "Formulario de Requisitos de Incorporación",
  content: "contenido",

  // -- loadingState.js (shared loading placeholder, used by every admin tab) --
  Loading: "Cargando",
  "This is taking longer than usual. Please wait.": "Esto está tardando más de lo normal. Por favor espere.",
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
