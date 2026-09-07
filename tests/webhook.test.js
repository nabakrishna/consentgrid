// tests/webhook.test.js
// Webhook signing + dispatch + retry/backoff + dead-letter queue, and the
// standardized withdrawal payload shape that client middleware relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Repo } from '../src/db/repo.js';
import { Dispatcher, makeEnqueue } from '../src/webhook/dispatcher.js';
import { signWebhook, verifyWebhook } from '../src/webhook/sign.js';

async function freshRepo() {
  const db = await openDatabase('sqlite://:memory:');
  await migrate(db);
  return new Repo(db);
}

test('signWebhook + verifyWebhook round-trip; tampered body fails', () => {
  const body = JSON.stringify({ hello: 'world' });
  const { header } = signWebhook('secret', body);
  assert.equal(verifyWebhook('secret', body, header), true);
  assert.equal(verifyWebhook('secret', body + 'x', header), false);
  assert.equal(verifyWebhook('wrong-secret', body, header), false);
});

test('verifyWebhook rejects stale timestamps (replay protection)', () => {
  const body = '{}';
  const old = signWebhook('secret', body, Math.floor(Date.now() / 1000) - 10000);
  assert.equal(verifyWebhook('secret', body, old.header), false);
});

test('successful delivery is marked delivered and carries a valid signature', async () => {
  const repo = await freshRepo();
  const orgId = await repo.createOrg({ name: 'A', email: 'a@a.com', passwordHash: 'x' });
  await repo.createWebhookEndpoint(orgId, 'https://ok.example/hook', 'whsec_ok', ['consent.withdrawn']);
  const enqueue = makeEnqueue(repo);
  await enqueue(orgId, 'consent.withdrawn', { action: 'WITHDRAW', purpose_id: 'marketing', user_token: 't', artifact_id: 'a', occurred_at: 'now' });

  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, ...opts }; return { ok: true, status: 200 }; };
  const d = new Dispatcher(repo, { fetchImpl });
  const res = await d.processOnce(10);
  assert.equal(res[0].status, 'delivered');
  // signature present and valid
  const sig = seen.headers['CG-Signature'];
  assert.ok(verifyWebhook('whsec_ok', seen.body, sig));
  // standardized payload shape
  const parsed = JSON.parse(seen.body);
  assert.equal(parsed.type, 'consent.withdrawn');
  assert.equal(parsed.data.action, 'WITHDRAW');
  assert.equal(parsed.data.purpose_id, 'marketing');
});

test('failing endpoint retries with backoff then lands in the dead-letter queue', async () => {
  const repo = await freshRepo();
  const orgId = await repo.createOrg({ name: 'B', email: 'b@b.com', passwordHash: 'x' });
  await repo.createWebhookEndpoint(orgId, 'https://bad.example/hook', 'whsec_bad', ['consent.withdrawn']);
  const enqueue = makeEnqueue(repo);
  await enqueue(orgId, 'consent.withdrawn', { action: 'WITHDRAW', purpose_id: '*', user_token: 't', artifact_id: 'a', occurred_at: 'now' });

  const fetchImpl = async () => ({ ok: false, status: 500 });
  const d = new Dispatcher(repo, { fetchImpl });

  let dead = false;
  for (let i = 0; i < 12 && !dead; i++) {
    // force each pending delivery due immediately
    await repo.db.run("UPDATE webhook_deliveries SET next_attempt_at=? WHERE status='pending'", [new Date(Date.now() - 1000).toISOString()]);
    const res = await d.processOnce(10);
    if (!res.length) break;
    dead = res.some((r) => r.status === 'dead');
  }
  const dl = await repo.listDeadLetters(orgId);
  assert.equal(dl.length, 1);
  assert.equal(dl[0].attempts, 8); // matches max_attempts default
});

test('event filtering: an endpoint only receives its subscribed events', async () => {
  const repo = await freshRepo();
  const orgId = await repo.createOrg({ name: 'C', email: 'c@c.com', passwordHash: 'x' });
  await repo.createWebhookEndpoint(orgId, 'https://only-withdraw.example', 'whsec_c', ['consent.withdrawn']);
  const enqueue = makeEnqueue(repo);
  const grants = await enqueue(orgId, 'consent.granted', { action: 'GRANT' });
  const withdraws = await enqueue(orgId, 'consent.withdrawn', { action: 'WITHDRAW' });
  assert.equal(grants.length, 0); // filtered out
  assert.equal(withdraws.length, 1);
});
