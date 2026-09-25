// A small shared modal/dialog helper -- so "add a new X" across the app
// (vendor, technician, task, scheduling a WOM, etc.) opens as an actual
// pop-up dialog instead of an inline form expanding into the page, per
// feedback that the inline pattern didn't feel like a real application.
// Deliberately minimal: one at a time, closes on Escape/backdrop click/its
// own close button, and the caller owns everything inside `.modal-body`.

let activeOverlay = null;

export function closeModal() {
  if (!activeOverlay) return;
  activeOverlay.remove();
  document.removeEventListener("keydown", handleKeydown);
  activeOverlay = null;
}

function handleKeydown(e) {
  if (e.key === "Escape") closeModal();
}

/**
 * @param {string} title - plain text (not HTML) shown as the dialog heading
 * @param {string} bodyHtml - raw HTML for the dialog body; caller is
 *   responsible for escaping any dynamic values it includes
 * @returns {{ body: HTMLElement, close: () => void }}
 */
export function openModal({ title, bodyHtml }) {
  closeModal();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <h3 class="modal-title"></h3>
        <button type="button" class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `;
  overlay.querySelector(".modal-title").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHtml;

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector(".modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", handleKeydown);

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const firstField = overlay.querySelector(".modal-body input, .modal-body select, .modal-body textarea");
  if (firstField) firstField.focus();

  return { body: overlay.querySelector(".modal-body"), close: closeModal };
}
