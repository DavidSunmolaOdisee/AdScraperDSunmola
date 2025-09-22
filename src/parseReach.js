// src/parseReach.js
const SEP = /[.,\s \u00A0]/g; // punt, komma, spatie, NBSP

function toIntClean(s) {
  if (!s) return null;
  // verander "1,2" of "1.2" in decimaal (voor K/M), maar strip thousand seps
  const k = s.replace(/\u00A0/g, " ").trim();

  // K / M / mln
  const m = k.match(/^(\d+(?:[.,]\d+)?)(?:\s*)([KkMm]|mln|MLN|Mln)?$/);
  if (m) {
    const num = parseFloat(m[1].replace(",", "."));
    const suf = (m[2] || "").toLowerCase();
    const mult = suf === "k" ? 1_000 : (suf === "m" || suf === "mln" ? 1_000_000 : 1);
    return Math.round(num * mult);
  }

  // 798,689 / 798 689
  return parseInt(k.replace(SEP, ""), 10);
}

/**
 * Parseert een bereiktekst in veel vormen:
 * "798,689" | "1 250" | "1,2 K" | "1.2K–3.5K" | "1,5 M" | "1,2K à 3,5K"
 * Retourneert {min, max, mid} of null.
 */
export function parseReach(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();

  // FR/NL woorden die we kunnen strippen
  const cleaned = t
    .replace(/personnes atteintes|bereik|people reached|portée|bereikte personen/gi, "")
    .replace(/[()]/g, "")
    .trim();

  // Ranges met "–" "-" "à" "to"
  const range = cleaned.split(/\s*(?:–|-|—|–|à|to)\s*/i);
  if (range.length === 2) {
    const min = toIntClean(range[0]);
    const max = toIntClean(range[1]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { min, max, mid: Math.round((min + max) / 2) };
    }
  }

  // Single value met K/M
  const single = toIntClean(cleaned);
  if (Number.isFinite(single)) {
    return { min: single, max: single, mid: single };
  }

  return null;
}
