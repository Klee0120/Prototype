import { escapeHtml } from "./app.js";

// A shared "loading" placeholder for a page-level fetch -- a spinner, a
// title, and a few skeleton rows shaped like the eventual list, with a
// "taking longer than usual" note that only appears if the fetch is
// still running a few seconds in (most loads finish well before that and
// never show it). Used in place of a bare "Loading…" string wherever a
// whole tab's content area is replaced once its data arrives, so every
// page's loading state reads the same rather than each tab inventing its
// own wording/markup.
const SLOW_LOAD_DELAY_MS = 3000;
const SKELETON_ROWS = 5;

export function renderLoadingState(container, label) {
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
  }, SLOW_LOAD_DELAY_MS);
}
