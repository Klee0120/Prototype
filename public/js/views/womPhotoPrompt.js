import { renderAttachments } from "./attachments.js";
import { escapeHtml } from "../app.js";

// Shown right after a submit (technician) or a "marked entered in UKG"
// confirmation (admin) that involved WOM hours -- an optional, dismissible
// nudge to attach a work photo, reusing the same WOM documents store the
// WOM Status tab already has (relatedType "wom", category "wom_doc").
export function renderWomPhotoPrompt(womCodes, onDismiss) {
  const wrap = document.createElement("div");
  wrap.className = "wom-photo-prompt";
  const openFor = new Set();

  draw();
  return wrap;

  function draw() {
    wrap.innerHTML = `
      <div class="wom-photo-prompt-header">
        <span>You worked WOM hours this week — add a photo of the work?</span>
        <button type="button" class="btn btn-link wom-photo-dismiss">No thanks</button>
      </div>
      <div class="wom-photo-prompt-list"></div>
    `;

    wrap.querySelector(".wom-photo-dismiss").addEventListener("click", () => {
      if (onDismiss) onDismiss();
    });

    const list = wrap.querySelector(".wom-photo-prompt-list");
    womCodes.forEach((code) => {
      const row = document.createElement("div");
      row.className = "wom-photo-prompt-row";
      row.innerHTML = `
        <span class="wom-photo-code">${escapeHtml(code)}</span>
        <button type="button" class="btn btn-link wom-photo-toggle">${openFor.has(code) ? "Hide" : "+ Add photo"}</button>
        <div class="wom-photo-attachments"></div>
      `;
      row.querySelector(".wom-photo-toggle").addEventListener("click", async () => {
        if (openFor.has(code)) openFor.delete(code);
        else openFor.add(code);
        draw();
      });
      list.appendChild(row);

      if (openFor.has(code)) {
        renderAttachments(row.querySelector(".wom-photo-attachments"), {
          title: "",
          relatedType: "wom",
          relatedId: code,
          categories: [{ value: "wom_doc", label: "Document / Photo" }],
          canUpload: true,
          emptyText: "No documents attached yet.",
        });
      }
    });
  }
}
