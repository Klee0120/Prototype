// A native <input type="date"> forces typing month, day, and year as three
// separate segments and can't take a pasted or fully-typed date in one go
// -- the exact complaint that prompted this. These give a plain text input
// with a placeholder of "MM/DD/YYYY" the same typed-friendliness instead:
// digits only, slashes inserted automatically as you type, and a full
// 8-digit string (typed in one go or pasted, with or without slashes)
// still lands correctly. The input's own .value stays MM/DD/YYYY for
// display; convert at the API boundary with isoFromUs/usFromIso.

export function wireDateMaskInput(input) {
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 8);
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += "/" + digits.slice(2, 4);
    if (digits.length > 4) out += "/" + digits.slice(4, 8);
    input.value = out;
  });
}

// "2026-03-02" -> "03/02/2026"
export function usFromIso(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  if (!y || !m || !d) return "";
  return `${m}/${d}/${y}`;
}

// "03/02/2026" -> "2026-03-02", or null if empty/incomplete/invalid
export function isoFromUs(us) {
  const trimmed = String(us || "").trim();
  if (!trimmed) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (!match) return null;
  const [, m, d, y] = match;
  return `${y}-${m}-${d}`;
}
