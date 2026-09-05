// src/lib/language.js
// ─────────────────────────────────────────────────────────────────────────
// [MUST-V1] Language candidate-list resolution.
//
// Produces a 3–4 language SHORTLIST per user — never all 22. IP geolocation is
// deliberately excluded (unreliable on Indian mobile networks; Jio/Airtel
// backhaul routing frequently misattributes region).
//
// Priority order:
//   1. host page <html lang="x">        (deliberate site declaration — highest)
//   2. stored per-visitor preference     (promoted to position 1 if present)
//   3. navigator.languages ∩ approved    (ordered, not single-value)
//   4. English                           (guaranteed fallback, always included)
//
// The output is a SUGGESTION list. Selection still requires one explicit user
// confirmation on the client before a notice counts as "shown" (see widget +
// no-silent-auto-selection rule). This module does not auto-select.
// ─────────────────────────────────────────────────────────────────────────

export const EIGHTH_SCHEDULE = [
  // 22 Eighth Schedule languages (BCP-47-ish codes) + English fallback.
  'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks', 'kok', 'mai',
  'ml', 'mni', 'mr', 'ne', 'or', 'pa', 'sa', 'sat', 'sd', 'ta', 'te', 'ur',
];
export const ENGLISH = 'en';

// Perso-Arabic / RTL scripts among the schedule. [MUST-V1 RTL rendering test]
export const RTL_LOCALES = new Set(['ur', 'ks', 'sd']);

function normalize(tag) {
  if (!tag) return null;
  // 'hi-IN' -> 'hi'; lowercase; strip whitespace.
  return String(tag).trim().toLowerCase().split('-')[0] || null;
}

/**
 * @param {Object} input
 * @param {?string} input.htmlLang            host page <html lang>
 * @param {?string} input.storedPreference    returning-visitor stored locale
 * @param {string[]} input.navigatorLanguages ordered navigator.languages
 * @param {string[]} input.approved           org's approved (legally reviewed) locales
 * @param {number} [input.cap=4]
 * @returns {{candidates:string[], english_included:boolean}}
 */
export function resolveCandidates({ htmlLang, storedPreference, navigatorLanguages = [], approved = [], cap = 4 }) {
  const approvedSet = new Set(approved.map(normalize).filter(Boolean));
  const ordered = [];
  const push = (code) => {
    const c = normalize(code);
    if (!c) return;
    if (!ordered.includes(c)) ordered.push(c);
  };

  // 1. host page declaration (highest priority)
  if (htmlLang) push(htmlLang);

  // 2. stored preference -> promote to position 1
  if (storedPreference) {
    const c = normalize(storedPreference);
    if (c) {
      const existing = ordered.indexOf(c);
      if (existing !== -1) ordered.splice(existing, 1);
      ordered.unshift(c);
    }
  }

  // 3. navigator.languages ∩ approved (ordered)
  for (const nl of navigatorLanguages) {
    const c = normalize(nl);
    if (c && approvedSet.has(c)) push(c);
  }

  // 4. English always included as guaranteed fallback
  push(ENGLISH);

  // dedupe already handled; cap at 3–4
  const candidates = ordered.slice(0, Math.max(3, Math.min(cap, 4)));
  if (!candidates.includes(ENGLISH)) candidates.push(ENGLISH); // guarantee survives the cap
  return { candidates: candidates.slice(0, cap), english_included: candidates.includes(ENGLISH) };
}

export function isRtl(locale) {
  return RTL_LOCALES.has(normalize(locale));
}
