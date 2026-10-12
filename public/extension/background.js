import { getSession, getCachedCurrent, setCachedCurrent, apiRequest, formatBadgeElapsed, STALE_WARNING_SECONDS } from "./shared.js";

// MV3 service workers aren't continuously alive, so a live ticking badge
// (like the popup's own second-by-second timer) isn't realistic here --
// this settles for refreshing on a 1-minute alarm (the platform's practical
// minimum for a published extension) plus right after the popup starts,
// stops, or re-polls /current itself (see popup.js's updateBadge calls,
// relayed here via chrome.runtime messages so the badge stays right even
// seconds after a click, not just once a minute behind).
const ALARM_NAME = "serviceworks-badge-tick";

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshBadge();
});

chrome.runtime.onStartup?.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "serviceworks:refresh-badge") refreshBadge();
});

async function refreshBadge() {
  const session = await getSession();
  if (!session || !session.token) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  let current = null;
  try {
    current = await apiRequest("GET", "/api/admin/time-log/current", undefined, session.token);
  } catch {
    // Network hiccup or expired session -- fall back to the last cached
    // value rather than flashing the badge blank every failed poll.
    current = await getCachedCurrent();
  }
  await setCachedCurrent(current);

  if (!current) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const seconds = (Date.now() - new Date(current.startedAt).getTime()) / 1000;
  await chrome.action.setBadgeText({ text: formatBadgeElapsed(seconds) });
  // Past the stale threshold, switch the badge amber so a forgotten timer
  // is visible at a glance without opening the popup -- the GET above also
  // hits the server's 12h hard auto-stop cap (getRunningTimeLogEntry), so
  // a truly abandoned timer self-heals within a minute either way.
  await chrome.action.setBadgeBackgroundColor({ color: seconds > STALE_WARNING_SECONDS ? "#b8590a" : "#a3182a" });
}
