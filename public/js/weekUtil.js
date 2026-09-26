export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function datesForWeek(mondayIso) {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const monday = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(monday.getTime());
    dt.setDate(monday.getDate() + i);
    out.push(formatISO(dt));
  }
  return out;
}

export function shiftWeek(mondayIso, deltaWeeks) {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaWeeks * 7);
  return formatISO(dt);
}

export function formatDateShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function weekRangeLabel(mondayIso) {
  const dates = datesForWeek(mondayIso);
  return `${formatDateShort(dates[0])} – ${formatDateShort(dates[6])}`;
}
