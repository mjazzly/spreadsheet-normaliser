// Type parsing, in code. Every value is parsed against its field's type after mapping; a value
// that fails is returned as a failure with the reason, never coerced. Each parser also says what
// it had to clean (a currency prefix, thousands separators, the date style), so the decision log
// can carry it.
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// The date styles the parser knows. A column is read under one style for every value.
export const DATE_STYLES = {
  "YYYY-MM-DD": (s) => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); return m && validYmd(+m[1], +m[2], +m[3]); },
  "DD/MM/YYYY": (s) => { const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s); return m && validYmd(+m[3], +m[2], +m[1]); },
  "MM/DD/YYYY": (s) => { const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s); return m && validYmd(+m[3], +m[1], +m[2]); },
  "D MMM YYYY": (s) => { const m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s); return m && MON[m[2].slice(0, 3).toLowerCase()] ? validYmd(+m[3], MON[m[2].slice(0, 3).toLowerCase()], +m[1]) : null; },
  "MMM D, YYYY": (s) => { const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s); return m && MON[m[1].slice(0, 3).toLowerCase()] ? validYmd(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2]) : null; },
};

// Decide the style of a whole column: the styles under which every non-blank value parses.
// One style: use it. Two styles that give the same date for every value: either, no harm.
// Two styles that disagree on any value (DD/MM against MM/DD with every day at 12 or under):
// ambiguous, and the caller must stop and ask. Date cells (true Excel dates) arrive as ISO text.
export function dateStyleFor(values, proposed) {
  const texts = values.filter((v) => v !== "");
  if (!texts.length) return { style: "YYYY-MM-DD", note: "no values" };
  const candidates = proposed && DATE_STYLES[proposed] ? [proposed] : Object.keys(DATE_STYLES);
  const fits = candidates.filter((st) => texts.every((t) => DATE_STYLES[st](t)));
  if (!fits.length) return { style: null, note: proposed ? `no value set parses as ${proposed}` : "no known date style fits every value" };
  if (fits.length === 1) return { style: fits[0], note: `every value parses as ${fits[0]}` };
  const disagree = texts.find((t) => new Set(fits.map((st) => DATE_STYLES[st](t))).size > 1);
  if (!disagree) return { style: fits[0], note: `reads the same under ${fits.join(" and ")}` };
  return { style: null, ambiguous: fits, note: `"${disagree}" reads differently under ${fits.join(" and ")}` };
}

export function parseDate(text, style) {
  if (text === "") return { ok: true, value: "" };
  const v = DATE_STYLES[style] ? DATE_STYLES[style](text) : null;
  return v ? { ok: true, value: v } : { ok: false, reason: `"${text}" does not read as a date in ${style}` };
}

const CURRENCY = /^(RM|MYR|USD|SGD|\$|£|€)\s*/i;
export function parseDecimal(text) {
  if (text === "") return { ok: false, reason: "blank" };
  let s = text.trim(), cleaned = [];
  if (CURRENCY.test(s)) { cleaned.push(`currency prefix "${CURRENCY.exec(s)[1]}"`); s = s.replace(CURRENCY, ""); }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) { cleaned.push("thousands separators"); s = s.replace(/,/g, ""); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: `"${text}" is not a number` };
  return { ok: true, value: Number(s).toFixed(2), cleaned };
}
export function parseInteger(text, min) {
  if (text === "") return { ok: false, reason: "blank" };
  let s = text.trim(), cleaned = [];
  if (/^-?\d{1,3}(,\d{3})+$/.test(s)) { cleaned.push("thousands separators"); s = s.replace(/,/g, ""); }
  if (!/^-?\d+$/.test(s)) return { ok: false, reason: `"${text}" is not a whole number` };
  const n = Number(s);
  if (min !== undefined && n < min) return { ok: false, reason: `${n} is below the minimum of ${min}` };
  return { ok: true, value: String(n), cleaned };
}
export function parseEnum(text, values) {
  if (text === "") return { ok: false, reason: "blank" };
  const hit = values.find((v) => v.toLowerCase() === text.trim().toLowerCase());
  return hit ? { ok: true, value: hit } : { ok: false, reason: `"${text}" is not one of ${values.join(", ")}` };
}
export function parseId(text, pattern) {
  if (text === "") return { ok: false, reason: "blank" };
  const s = text.trim().toUpperCase();
  return new RegExp(pattern).test(s) ? { ok: true, value: s } : { ok: false, reason: `"${text}" does not match the id pattern ${pattern}` };
}
export function parseText(text) {
  const s = text.replace(/\s+/g, " ").trim();
  return s ? { ok: true, value: s } : { ok: false, reason: "blank" };
}

// header normalisation for the synonym match: lower case, punctuation to spaces, one space
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
