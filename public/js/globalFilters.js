// The topbar's "All territories" selector -- one filter shared by every
// admin view (WOM Projects, Locations, Budget PO Tracker, Financials)
// instead of each page carrying its own separate territory dropdown.
// Persisted so it survives a refresh, and broadcast via a tiny pub-sub so
// whichever tab is currently drawn can re-render when it changes.
const TERRITORY_KEY = "sw-territory-filter";

function loadTerritory() {
  try {
    return localStorage.getItem(TERRITORY_KEY) || "";
  } catch {
    return "";
  }
}

let territory = loadTerritory();
const listeners = new Set();

export function getTerritory() {
  return territory;
}

export function setTerritory(value) {
  territory = value || "";
  try {
    localStorage.setItem(TERRITORY_KEY, territory);
  } catch {
    // Private-browsing/storage-blocked -- the in-memory value still works
    // for the rest of this visit, it just won't survive a refresh.
  }
  listeners.forEach((fn) => fn(territory));
}

// Returns an unsubscribe function, same convention as DOM event cleanup.
export function onTerritoryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
