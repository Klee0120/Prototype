// A small shared modal/dialog helper -- so "add a new X" across the app
// (vendor, technician, task, scheduling a WOM, etc.) opens as an actual
// pop-up dialog instead of an inline form expanding into the page, per
// feedback that the inline pattern didn't feel like a real application.
// Deliberately minimal: one at a time, closes on Escape/backdrop click/its
// own close button, and the caller owns everything inside `.modal-body`.

let activeOverlay = null;
let activeOnClose = null;

export function closeModal() {
  if (!activeOverlay) return;
  activeOverlay.remove();
  document.removeEventListener("keydown", handleKeydown);
  const onClose = activeOnClose;
  activeOverlay = null;
  activeOnClose = null;
  if (onClose) onClose();
}

function handleKeydown(e) {
  if (e.key === "Escape") closeModal();
}

/**
 * @param {string} title - plain text (not HTML) shown as the dialog heading
 * @param {string} bodyHtml - raw HTML for the dialog body; caller is
 *   responsible for escaping any dynamic values it includes
 * @param {"normal"|"large"} [size] - "large" for content that needs real
 *   room (a document viewer's two-pane layout); "normal" (default) matches
 *   every other pop-up form in the app
 * @param {() => void} [onClose] - called once, however the dialog closes
 *   (X, Escape, backdrop, or the caller's own `close()`) -- for cleanup
 *   like revoking an object URL a preview created
 * @returns {{ body: HTMLElement, close: () => void }}
 */
export function openModal({ title, bodyHtml, size, onClose }) {
  closeModal();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box ${size === "large" ? "modal-box-large" : ""}" role="dialog" aria-modal="true" aria-label="${title}">
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
  activeOnClose = onClose || null;

  const firstField = overlay.querySelector(".modal-body input, .modal-body select, .modal-body textarea");
  if (firstField) firstField.focus();

  return { body: overlay.querySelector(".modal-body"), close: closeModal };
}
