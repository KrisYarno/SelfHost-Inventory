//
// Phase 0a — order-reference normalization for evidence class (c).
//
// FROZEN (spec §D1, evidence class (c)): "EXACT normalized equality only (trim,
// strip leading '#')". NO fuzzy parsing — the From-Order path auto-fills the
// exact orderNumber, so free text is junk-or-exact with nothing in between.
// Anything cleverer than this manufactures matches that cannot be defended.
//

/**
 * Normalize a raw reference / orderNumber for exact comparison.
 * Trim -> strip leading '#' characters -> trim again. Case is PRESERVED:
 * equality is exact, and case-only near-misses are reported as a disclosure,
 * never silently matched.
 *
 * @param {unknown} raw
 * @returns {string|null} the normalized token, or null when unnormalizable
 */
function normalizeOrderNumber(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  while (s.startsWith("#")) s = s.slice(1);
  s = s.trim();
  return s.length > 0 ? s : null;
}

/**
 * Case-folded form of an already-normalized token. Used ONLY to count
 * case-insensitive near-misses as a disclosure alongside the exact-match
 * figures — never to classify.
 *
 * @param {string|null} normalized
 * @returns {string|null}
 */
function foldReferenceCase(normalized) {
  return typeof normalized === "string" ? normalized.toLowerCase() : null;
}

module.exports = { normalizeOrderNumber, foldReferenceCase };
