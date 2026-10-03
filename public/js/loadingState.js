import { escapeHtml } from "./app.js";

// A shared "loading" placeholder for a page-level fetch -- a spinner, a
// title, and a few skeleton rows shaped like the eventual list, with a
// "taking longer than usual" note that only appears if the fetch is
// still running a few seconds in (most loads finish well before that and
// never show it). Used in place of a bare "Loading…" string wherever a
// whole tab's content area is replaced once its data arrives, so every
// page's loading state reads the same rather than each tab inventing its
// own wording/markup.
//
// Shown itself only after SHOW_DELAY_MS -- most navigations resolve well
// under that, and flashing a full spinner+skeleton for every instant load
// read as more janky than reassuring. A caller never has to cooperate with
// that delay: it just calls this once and later does its own unconditional
// `container.innerHTML = realContent` once data arrives, same as before.
const SHOW_DELAY_MS = 250;
const SLOW_LOAD_DELAY_MS = 3000;
const SKELETON_ROWS = 5;

// Lowercases a page title for use in "Loading {title}…", except a word
// that's already all-caps (WOM, PO, GL) -- those are acronyms, not
// sentence-case words, and lowercasing them read as a typo ("wom
// projects").
export function loadingLabelFor(title) {
  return title
    .split(" ")
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()))
    .join(" ");
}

export function renderLoadingState(container, label) {
  // Clears immediately (same as the unconditional `container.innerHTML =`
  // every caller already did before this existed) but doesn't paint
  // anything yet -- an invisible marker instead, so the delayed callback
  // below can tell "is this container still waiting on me" from "did real
  // content already replace it" without the caller ever knowing this delay
  // exists.
  container.innerHTML = "";
  const marker = document.createElement("div");
  marker.hidden = true;
  container.appendChild(marker);

  setTimeout(() => {
    if (!container.contains(marker)) return;
    container.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-title">Loading ${escapeHtml(label)}&hellip;</div>
        <div class="loading-subtext" hidden>This is taking longer than usual. Please wait.</div>
        <div class="loading-skeleton">
          ${Array.from({ length: SKELETON_ROWS })
            .map(
              () => `
                <div class="skeleton-row">
                  <div class="skeleton-avatar"></div>
                  <div class="skeleton-bars"><span></span><span></span><span></span><span></span></div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    `;
    // Identifies "is this still the loading view, or did real content
    // already replace it" by object identity rather than a boolean flag,
    // since container.innerHTML could coincidentally be reset to another
    // loading state (a filter change re-triggering the same fetch) between
    // now and when this timeout fires.
    const root = container.querySelector(".loading-state");
    setTimeout(() => {
      if (container.querySelector(".loading-state") !== root) return;
      const subtext = root.querySelector(".loading-subtext");
      if (subtext) subtext.hidden = false;
    }, SLOW_LOAD_DELAY_MS - SHOW_DELAY_MS);
  }, SHOW_DELAY_MS);
}
