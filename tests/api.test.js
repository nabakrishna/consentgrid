// tests/api.test.js
// End-to-end HTTP surface: auth, notice lifecycle, public verification with no
// PII leak, export, and append-only ledger enforcement at the storage layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedApprovedOrg } from './helpers.js';

let h;
before(async () => { h = await startTestServer(); });
after(async () => { await h.close(); });

test('health check', async () => {
  const r = await h.req('GET', '/health', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('signup issues a one-time API key and a session', async () => {
  const r = await h.req('POST', '/v1/orgs', { body: { name: 'Acme', email: `acme${Math.random().toString(36).slice(2)}@x.com`, password: 'password123' } });
  assert.equal(r.status, 201);
  assert.ok(r.json.api_key.startsWith('cg_live_'));
  assert.ok(r.json.session);
});

test('duplicate email is rejected', async () => {
  const email = `dup${Math.random().toString(36).slice(2)}@x.com`;
  await h.req('POST', '/v1/orgs', { body: { name: 'A', email, password: 'password123' } });
  const dup = await h.req('POST', '/v1/orgs', { body: { name: 'B', email, password: 'password123' } });
  assert.equal(dup.status, 409);
});

test('login rejects a bad password', async () => {
  const email = `login${Math.random().toString(36).slice(2)}@x.com`;
  await h.req('POST', '/v1/orgs', { body: { name: 'A', email, password: 'password123' } });
  const bad = await h.req('POST', '/v1/sessions', { body: { email, password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('consent endpoints require an API key', async () => {
  const r = await h.req('POST', '/v1/consent', { body: { user_token: 'x', action: 'GRANT', locale: 'hi' } });
  assert.equal(r.status, 401);
});

test('dashboard endpoints require a session', async () => {
  const fresh = await startTestServer();
  const r = await fresh.req('GET', '/v1/api-keys', {});
  assert.equal(r.status, 401);
  await fresh.close();
});

test('notice honest-fallback returns 409 for an unapproved locale', async () => {
  const { orgId } = await seedApprovedOrg(h);
  const r = await h.req('GET', `/v1/notice?org_id=${orgId}&locale=bn`, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.available, false);
});

test('language resolution returns a shortlist including English', async () => {
  const { orgId } = await seedApprovedOrg(h);
  const r = await h.req('GET', `/v1/languages/resolve?org_id=${orgId}&nav=hi-IN,en-US&html_lang=hi`, {});
  assert.equal(r.status, 200);
  assert.ok(r.json.candidates.includes('en'));
  assert.ok(r.json.candidates.length <= 4);
});

test('public verification reveals proof surface but no purposes/PII', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const c = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'pub-verify-user', action: 'GRANT', locale: 'hi', purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  const id = c.json.artifact_id;
  const v = await h.req('GET', `/v1/verify/${id}`, {});
  assert.equal(v.status, 200);
  assert.equal(v.json.found, true);
  assert.equal(v.json.signature_valid, true);
  assert.equal(v.json.content_hash_intact, true);
  assert.equal(v.json.purposes, undefined); // purposes never exposed publicly
  assert.equal(v.json.id_hash, undefined);
});

test('CSV + JSON export are downloadable', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'export-user', action: 'GRANT', locale: 'hi', purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  const csv = await h.req('GET', '/v1/export?format=csv', { raw: true });
  assert.equal(csv.status, 200);
  assert.ok(csv.text.split('\n').length >= 2);
  const json = await h.req('GET', '/v1/export?format=json', { raw: true });
  assert.ok(JSON.parse(json.text).schema.startsWith('consentgrid'));
});

test('append-only ledger: direct UPDATE/DELETE on an artifact is refused by the DB', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const c = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'immutable-user', action: 'GRANT', locale: 'hi', purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  const id = c.json.artifact_id;
  const db = h.built.db;
  // async thunk: converts the sqlite adapter's synchronous throw into a promise
  // rejection, so the same assertion works against async Postgres too.
  await assert.rejects(
    async () => db.run('UPDATE consent_artifacts SET action=? WHERE artifact_id=?', ['WITHDRAW', id]),
    /append-only|immutable|cannot|abort/i,
  );
  await assert.rejects(
    async () => db.run('DELETE FROM consent_artifacts WHERE artifact_id=?', [id]),
    /append-only|immutable|cannot|abort/i,
  );
});
