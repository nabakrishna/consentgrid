// src/lib/ratelimit.js
// [MUST-V1] Token-bucket rate limiting + basic bot heuristics for the public
// consent-submission endpoint. In production the gateway (API GW / Cloudflare)
// does the heavy lifting; this is defense-in-depth at the app layer.

export class TokenBucket {
  #buckets = new Map(); // key -> { tokens, last }
  constructor({ rps = 20, burst = 40 } = {}) {
    this.rps = rps; this.burst = burst;
  }
  take(key, n = 1) {
    const now = Date.now();
    let b = this.#buckets.get(key);
    if (!b) { b = { tokens: this.burst, last: now }; this.#buckets.set(key, b); }
    // refill
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.burst, b.tokens + elapsed * this.rps);
    b.last = now;
    if (b.tokens >= n) { b.tokens -= n; return true; }
    return false;
  }
  // periodic cleanup to bound memory
  sweep() {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of this.#buckets) if (v.last < cutoff && v.tokens >= this.burst) this.#buckets.delete(k);
  }
}

/**
 * Very lightweight bot scoring for consent submissions. Fabricated consent is a
 * legal liability, so we reject the obviously-automated. This is NOT a captcha
 * replacement; the widget also carries a proof-of-interaction (client events),
 * which the server independently validates (see routes/consent.js).
 * @returns {{bot:boolean, reasons:string[]}}
 */
export function botScore({ userAgent = '', interactionEvents = [], timingMs = null }) {
  const reasons = [];
  const ua = String(userAgent).toLowerCase();
  if (!ua) reasons.push('missing_user_agent');
  if (/(bot|crawler|spider|headless|python-requests|curl|wget|scrapy)/.test(ua)) reasons.push('automation_ua');
  // No human interaction events at all => almost certainly fabricated.
  if (!Array.isArray(interactionEvents) || interactionEvents.length === 0) reasons.push('no_interaction_events');
  // Submitted impossibly fast after notice shown (< 400ms of reading).
  if (typeof timingMs === 'number' && timingMs >= 0 && timingMs < 400) reasons.push('too_fast');
  return { bot: reasons.length > 0 && (reasons.includes('automation_ua') || reasons.includes('no_interaction_events')), reasons };
}
