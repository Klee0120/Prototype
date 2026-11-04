import { escapeHtml } from "./app.js";
import { COI_MATRIX } from "./data/coiMatrix.js";

// A type-to-filter combobox for picking from COI_MATRIX's ~160 Toyota-
// account service labels. A native <select>/<optgroup> makes you scroll
// a 160-row list to find "HVAC Services"; this filters live as you type
// instead, same idea as the topbar's WOM/vendor/PO search (see
// renderGlobalTopbarTools in adminReview.js). Built once here since two
// places need it: the vendor profile's multi-select Services field, and
// the Onboard Requirements Form's single-pick Type of service.
//
// Options:
//   multiple      -- true for a tag-style multi-pick (chips + an always-
//                     open list), false for a single pick that fills the
//                     input and closes the dropdown.
//   initialValue  -- array of COI_MATRIX labels already selected
//                     (multiple), or a single label string (single).
//                     A label not found in COI_MATRIX is kept as-is
//                     (a vendor onboarded before this was matrix-backed,
//                     or a free-text value outside the matrix) rather
//                     than silently dropped.
//   onChange(value) -- called with the new array (multiple) or string
//                     (single) every time the selection changes.
//   hiddenSelectName -- when set, a real (visually hidden)
//                     <select multiple name="...">  is kept in the
//                     returned root element and its selected options
//                     kept in sync, so existing `form.<name>` /
//                     `select.selectedOptions` read-back code (see
//                     selectedServicesValue in adminReview.js) keeps
//                     working unchanged. Multiple-mode only.
//
// Returns the root <div> to insert into the DOM.
export function renderServiceCombo({ multiple, initialValue, onChange, hiddenSelectName }) {
  const matchedLabels = new Set(COI_MATRIX.map((e) => e.label));
  let selected = multiple ? [...(initialValue || [])] : initialValue ? [initialValue] : [];
  let filterText = "";
  let open = false;

  const root = document.createElement("div");
  root.className = `service-combo ${multiple ? "service-combo-multiple" : "service-combo-single"}`;
  root.innerHTML = `
    ${multiple ? '<div class="service-combo-chips"></div>' : ""}
    <div class="service-combo-input-wrap">
      <input type="text" class="service-combo-input" placeholder="Type to search services..." autocomplete="off" />
      <div class="service-combo-dropdown" hidden></div>
    </div>
    ${hiddenSelectName ? `<select multiple hidden name="${escapeHtml(hiddenSelectName)}"></select>` : ""}
  `;

  const input = root.querySelector(".service-combo-input");
  const dropdown = root.querySelector(".service-combo-dropdown");
  const chipsHost = root.querySelector(".service-combo-chips");
  const hiddenSelect = hiddenSelectName ? root.querySelector("select") : null;

  if (!multiple && selected[0]) input.value = selected[0];

  function groupedMatches() {
    const q = filterText.trim().toLowerCase();
    const groups = new Map();
    for (const entry of COI_MATRIX) {
      if (q && !entry.label.toLowerCase().includes(q)) continue;
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    return [...groups.entries()];
  }

  function syncHiddenSelect() {
    if (!hiddenSelect) return;
    hiddenSelect.innerHTML = selected
      .map((label) => `<option value="${escapeHtml(label)}" selected>${escapeHtml(label)}</option>`)
      .join("");
  }

  function renderChips() {
    if (!chipsHost) return;
    chipsHost.innerHTML = selected
      .map(
        (label) => `
          <span class="service-combo-chip ${matchedLabels.has(label) ? "" : "service-combo-chip-unmatched"}">
            ${escapeHtml(label)}${matchedLabels.has(label) ? "" : " (not in matrix)"}
            <button type="button" class="service-combo-chip-remove" data-label="${escapeHtml(label)}" aria-label="Remove">&times;</button>
          </span>
        `
      )
      .join("");
    chipsHost.querySelectorAll(".service-combo-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selected = selected.filter((l) => l !== btn.dataset.label);
        renderChips();
        syncHiddenSelect();
        renderDropdown();
        onChange(selected);
      });
    });
  }

  function renderDropdown() {
    const groups = groupedMatches();
    if (groups.length === 0) {
      dropdown.innerHTML = `<p class="service-combo-empty">No matching services.</p>`;
    } else {
      dropdown.innerHTML = groups
        .map(
          ([group, entries]) => `
            <div class="service-combo-group">
              <div class="service-combo-group-label">${escapeHtml(group)}</div>
              ${entries
                .map((e) => {
                  const isSelected = multiple && selected.includes(e.label);
                  return `<button type="button" class="service-combo-option ${isSelected ? "service-combo-option-selected" : ""}" data-label="${escapeHtml(
                    e.label
                  )}">${isSelected ? "✓ " : ""}${escapeHtml(e.label)}</button>`;
                })
                .join("")}
            </div>
          `
        )
        .join("");
    }
    dropdown.querySelectorAll(".service-combo-option").forEach((btn) => {
      // mousedown + preventDefault stops the input from ever blurring in
      // the first place, so clicking an option can't race the blur
      // handler below (which would otherwise close/revert the combo out
      // from under the click).
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(btn.dataset.label);
      });
    });
  }

  function pick(label) {
    if (multiple) {
      if (!selected.includes(label)) selected.push(label);
      else selected = selected.filter((l) => l !== label);
      renderChips();
      syncHiddenSelect();
      filterText = "";
      input.value = "";
      renderDropdown();
      input.focus();
    } else {
      selected = [label];
      input.value = label;
      closeDropdown();
    }
    onChange(multiple ? selected : label);
  }

  function openDropdown() {
    open = true;
    dropdown.hidden = false;
    renderDropdown();
  }
  function closeDropdown() {
    open = false;
    dropdown.hidden = true;
    // Typed text that was never turned into a pick (tabbed/clicked away
    // mid-search) shouldn't linger as if it were the value -- fall back
    // to whatever's actually selected, same as a browser address bar
    // reverting on blur.
    if (!multiple) input.value = selected[0] || "";
  }

  input.addEventListener("focus", () => {
    // A single-pick combo starts with its current selection filled in
    // (e.g. a long "Category / Sub-category / Service" label) --
    // select it all so the first keystroke replaces it, the way a
    // browser address bar or any other editable combobox behaves,
    // instead of the user having to clear it by hand first.
    if (!multiple) input.select();
    openDropdown();
  });
  input.addEventListener("input", () => {
    filterText = input.value;
    if (!multiple) {
      // Typing after a single pick means the vendor is searching again,
      // not keeping the old selection -- same as clearing a normal
      // search box.
      selected = [];
    }
    if (!open) openDropdown();
    else renderDropdown();
  });
  input.addEventListener("blur", () => {
    // Deferred -- an option's mousedown handler calls preventDefault()
    // specifically so clicking it doesn't blur the input first; letting
    // this run on the next tick means a real option pick (which also
    // closes via pick() -> closeDropdown()) always wins the race against
    // a plain tab-away blur closing on stale/empty state.
    setTimeout(() => {
      if (!root.contains(document.activeElement)) closeDropdown();
    }, 0);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDropdown();
      input.blur();
    }
  });
  renderChips();
  syncHiddenSelect();

  return root;
}
