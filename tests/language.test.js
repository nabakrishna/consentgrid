// tests/language.test.js
// [MUST-V1] Candidate-list language resolution: shortlist not full list,
// English always included, stored preference wins, RTL detection, no IP input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCandidates, isRtl, EIGHTH_SCHEDULE, RTL_LOCALES } from '../src/lib/language.js';

test('produces a shortlist (<=4), never the full 22', () => {
  const approved = [...EIGHTH_SCHEDULE, 'en'];
  const r = resolveCandidates({ htmlLang: 'hi', navigatorLanguages: ['bn', 'ta', 'te', 'mr', 'gu'], approved });
  assert.ok(r.candidates.length <= 4, `got ${r.candidates.length}`);
});

test('English is always included as guaranteed fallback', () => {
  const r = resolveCandidates({ htmlLang: 'hi', navigatorLanguages: ['bn'], approved: ['hi', 'bn', 'en'] });
  assert.ok(r.candidates.includes('en'));
  assert.equal(r.english_included, true);
});

test('host page <html lang> takes priority position', () => {
  const r = resolveCandidates({ htmlLang: 'ta', navigatorLanguages: ['hi'], approved: ['hi', 'ta', 'en'] });
  assert.equal(r.candidates[0], 'ta');
});

test('stored preference is promoted ahead of html lang', () => {
  const r = resolveCandidates({ htmlLang: 'ta', storedPreference: 'bn', navigatorLanguages: ['hi'], approved: ['hi', 'ta', 'bn', 'en'] });
  assert.equal(r.candidates[0], 'bn');
});

test('navigator languages only count when intersect approved set', () => {
  // 'fr' is not approved and not in schedule; must be dropped.
  const r = resolveCandidates({ htmlLang: null, navigatorLanguages: ['fr', 'hi'], approved: ['hi', 'en'] });
  assert.ok(!r.candidates.includes('fr'));
  assert.ok(r.candidates.includes('hi'));
});

test('locale tags are normalized (hi-IN -> hi)', () => {
  const r = resolveCandidates({ htmlLang: 'hi-IN', navigatorLanguages: ['bn-IN'], approved: ['hi', 'bn', 'en'] });
  assert.ok(r.candidates.includes('hi'));
  assert.ok(r.candidates.includes('bn'));
});

test('RTL detection covers Urdu, Kashmiri, Sindhi only', () => {
  assert.equal(isRtl('ur'), true);
  assert.equal(isRtl('ks'), true);
  assert.equal(isRtl('sd'), true);
  assert.equal(isRtl('hi'), false);
  assert.equal(isRtl('en'), false);
  assert.deepEqual([...RTL_LOCALES].sort(), ['ks', 'sd', 'ur']);
});

test('no IP / geolocation parameter is consulted', () => {
  // The function signature deliberately has no ip/geo input; passing junk is ignored.
  const r = resolveCandidates({ htmlLang: 'hi', navigatorLanguages: [], approved: ['hi', 'en'], ip: '1.2.3.4', country: 'US' });
  assert.ok(r.candidates.includes('hi'));
  assert.ok(r.candidates.includes('en'));
});
