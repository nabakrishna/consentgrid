// tests/consent-guards.test.js
// [MUST-V1] The legal guards that make a consent artifact defensible:
//   no pre-ticked consent, explicit language confirmation, honest fallback,
//   minor/guardian requirement, opaque-token identity, crypto-shred erasure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedApprovedOrg } from './helpers.js';

let h;
before(async () => { h = await startTestServer(); });
after(async () => { await h.close(); });

test('rejects pre-ticked consent (purpose true with no interaction event)', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const r = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-pretick', action: 'GRANT', locale: 'hi',
      purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }], // no toggle for marketing
    },
  });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'pre_ticked_rejected');
});

test('rejects consent without an explicit language_confirmed event', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const r = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-nolang', action: 'GRANT', locale: 'hi',
      purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'language_not_confirmed');
});

test('honest fallback: minting is blocked when locale has no approved notice', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const r = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-ta', action: 'GRANT', locale: 'ta', // Tamil not approved
      purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'ta' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'no_approved_notice');
});

test('accepts a well-formed grant and returns a signed artifact (no raw PII)', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const r = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'raw-identity-should-never-appear', action: 'GRANT', locale: 'hi',
      purposes: { marketing: true, analytics: false },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.artifact_id && r.json.signature && r.json.content_hash);
  // The response exposes only the keyed hash, never the raw token.
  assert.ok(r.json.id_hash && r.json.id_hash.length === 64);
  assert.ok(!JSON.stringify(r.json).includes('raw-identity-should-never-appear'));
});

test('minor consent requires a verified guardian verification', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const r = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-minor', action: 'GRANT', locale: 'hi', is_minor: true,
      purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(r.status, 428);
  assert.equal(r.json.error, 'guardian_verification_required');
});

test('full minor flow: guardian OTP -> verified -> consent accepted; OTP/phone never echoed', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  const start = await h.req('POST', '/v1/guardian/start', { apiKey, body: { user_token: 'u-minor2', guardian_phone: '+919999999999' } });
  assert.equal(start.status, 201);
  const gvId = start.json.guardian_verification_id;
  assert.ok(gvId);
  // The dev OTP is surfaced only via the out-of-band sink, never the HTTP response.
  assert.ok(!('otp' in start.json));
  assert.ok(!('dev_otp' in start.json));
  assert.ok(!JSON.stringify(start.json).includes('+919999999999'));

  // Capture the OTP the way an SMS provider would (test sink), not from the API body.
  const otp = h.lastOtp() && h.lastOtp().otp;
  assert.ok(otp, 'test sink must capture the OTP to complete the flow');

  const verify = await h.req('POST', '/v1/guardian/verify', { apiKey, body: { guardian_verification_id: gvId, guardian_phone: '+919999999999', otp } });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.verified, true);

  const consent = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-minor2', action: 'GRANT', locale: 'hi', is_minor: true, guardian_verification_id: gvId,
      purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(consent.status, 201);
  assert.equal(consent.json.is_minor, true);
});

test('erasure crypto-shreds the identity and blocks re-consent under the same token', async () => {
  const { apiKey, noticeVersionHash } = await seedApprovedOrg(h);
  // record then erase
  await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-erase', action: 'GRANT', locale: 'hi', purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  const erase = await h.req('POST', '/v1/erase', { apiKey, body: { user_token: 'u-erase', reason: 'user_request' } });
  assert.equal(erase.status, 200);
  assert.equal(erase.json.erased, true);

  // history is now empty (salt gone)
  const hist = await h.req('GET', '/v1/consent/history?user_token=u-erase', { apiKey });
  assert.equal(hist.json.artifacts.length, 0);

  // re-consent under the shredded token is refused
  const re = await h.req('POST', '/v1/consent', {
    apiKey,
    body: {
      user_token: 'u-erase', action: 'GRANT', locale: 'hi', purposes: { marketing: true },
      notice_version_hash: noticeVersionHash,
      interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
    },
  });
  assert.equal(re.status, 410);
  assert.equal(re.json.error, 'identity_shredded');
});

test('the ledger hash-chain stays intact after an erasure', async () => {
  const seeded = await seedApprovedOrg(h);
  const { apiKey, noticeVersionHash } = seeded;
  for (const u of ['c1', 'c2', 'c3']) {
    await h.req('POST', '/v1/consent', {
      apiKey,
      body: {
        user_token: u, action: 'GRANT', locale: 'hi', purposes: { marketing: true },
        notice_version_hash: noticeVersionHash,
        interaction_events: [{ type: 'language_confirmed', locale: 'hi' }, { type: 'toggle', purpose_id: 'marketing', value: true }],
      },
    });
  }
  await h.req('POST', '/v1/erase', { apiKey, body: { user_token: 'c2' } });
  const chain = await h.req('GET', '/v1/chain/verify', {});
  assert.equal(chain.json.ok, true, JSON.stringify(chain.json));
});
