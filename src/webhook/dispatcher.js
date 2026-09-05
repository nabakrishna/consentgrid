// src/webhook/dispatcher.js
// [MUST-V1] Webhook dispatch with retry + dead-letter queue.
//
// enqueueFor(orgId, eventType, payload) fans a standardized payload out to all
// active endpoints for the org. processOnce() claims due deliveries, POSTs them
// with an HMAC signature, and on failure reschedules with exponential backoff
// until max_attempts, after which the delivery is moved to the dead-letter
// state ('dead') so failures are never silent.

import { signWebhook } from './sign.js';
import { nowIso } from '../lib/ids.js';
import { asJson } from '../lib/ids.js';

const BACKOFF_SEC = [10, 30, 120, 300, 900, 3600, 7200]; // per-attempt backoff

export function makeEnqueue(repo) {
  return async function enqueueFor(orgId, eventType, payload) {
    const endpoints = await repo.listWebhookEndpoints(orgId);
    const ids = [];
    for (const ep of endpoints) {
      const events = asJson(ep.events, []);
      if (Array.isArray(events) && events.length && !events.includes(eventType)) continue;
      ids.push(await repo.enqueueDelivery(ep.endpoint_id, orgId, eventType, payload));
    }
    return ids;
  };
}

export class Dispatcher {
  constructor(repo, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.repo = repo;
    this.fetch = fetchImpl;
    this.now = now;
  }

  async processOnce(limit = 20) {
    const due = await this.repo.claimDueDeliveries(limit);
    const results = [];
    for (const d of due) {
      results.push(await this.#deliver(d));
    }
    return results;
  }

  async #deliver(d) {
    const bodyObj = {
      id: d.delivery_id,
      type: d.event_type,
      created_at: nowIso(),
      data: asJson(d.payload, {}),
    };
    const body = JSON.stringify(bodyObj);
    const { header } = signWebhook(d.endpoint_secret, body);
    try {
      const res = await this.fetch(d.endpoint_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CG-Signature': header, 'CG-Event': d.event_type },
        body,
        signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
      });
      if (res.ok) {
        await this.repo.markDelivered(d.delivery_id);
        return { delivery_id: d.delivery_id, status: 'delivered' };
      }
      return await this.#fail(d, `HTTP ${res.status}`);
    } catch (e) {
      return await this.#fail(d, e.message || String(e));
    }
  }

  async #fail(d, error) {
    const attempt = d.attempts + 1;
    if (attempt >= d.max_attempts) {
      await this.repo.rescheduleDelivery(d.delivery_id, nowIso(), error, /*dead*/ true);
      return { delivery_id: d.delivery_id, status: 'dead', error };
    }
    const backoff = BACKOFF_SEC[Math.min(attempt - 1, BACKOFF_SEC.length - 1)];
    const next = new Date(this.now() + backoff * 1000).toISOString();
    await this.repo.rescheduleDelivery(d.delivery_id, next, error, false);
    return { delivery_id: d.delivery_id, status: 'retry', next, error };
  }
}
