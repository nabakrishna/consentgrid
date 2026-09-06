// tests/crypto.test.js
// Core cryptographic guarantees: signing, content-hash tamper detection,
// hash-chain integrity, keyed identifier hashing, crypto-shredding, Merkle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalDevSigner } from '../src/crypto/kms.js';
import {
  mintArtifact, verifyArtifact, verifyChain, contentHash,
  merkleRoot, merkleProof, verifyMerkleProof, GENESIS_PREV_HASH, ARTIFACT_SCHEMA_VERSION,
} from '../src/crypto/artifact.js';
import { generateUserSalt, identifierHash, identifierMatches } from '../src/crypto/identity.js';
import { canonicalize } from '../src/crypto/canonical.js';

function tmpSigner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-keys-'));
  return new LocalDevSigner(dir);
}

function bodyFixture(overrides = {}) {
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    artifact_id: 'a1',
    org_id: 'org1',
    id_hash: 'deadbeef',
    action: 'GRANT',
    channel: 'web',
    purposes: { marketing: true, analytics: false },
    interaction_events: [{ type: 'toggle', purpose_id: 'marketing', value: true }],
    locale: 'hi',
    template_hash: 't', variable_payload_hash: 'v', notice_version_hash: 'nv',
    is_minor: false, guardian_verification: null,
    migrated: false, pre_existing_consent_date: null, expires_at: null,
    prev_hash: GENESIS_PREV_HASH, created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('canonicalization is stable regardless of key order', () => {
  const a = canonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } });
  const b = canonicalize({ a: 2, nested: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b);
});

test('mint + self-verify a valid artifact', async () => {
  const km = tmpSigner();
  const art = await mintArtifact(bodyFixture(), km);
  assert.ok(art.signature && art.key_id && art.algorithm === 'ECDSA_SHA_256');
  const v = await verifyArtifact(art, km);
  assert.deepEqual(v, { ok: true, content_hash_ok: true, signature_ok: true });
});

test('tampering with the body is detected (content_hash mismatch)', async () => {
  const km = tmpSigner();
  const art = await mintArtifact(bodyFixture(), km);
  art.body.purposes.marketing = false; // flip a recorded choice
  const v = await verifyArtifact(art, km);
  assert.equal(v.content_hash_ok, false);
  assert.equal(v.ok, false);
});

test('forged signature is rejected', async () => {
  const km = tmpSigner();
  const art = await mintArtifact(bodyFixture(), km);
  art.signature = Buffer.from('not-a-real-signature').toString('base64');
  const v = await verifyArtifact(art, km);
  assert.equal(v.signature_ok, false);
});

test('hash-chain links across a sequence and detects a deleted record', async () => {
  const km = tmpSigner();
  const chain = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < 4; i++) {
    const art = await mintArtifact(bodyFixture({ artifact_id: 'a' + i, prev_hash: prev, created_at: `2026-01-0${i + 1}T00:00:00.000Z` }), km);
    chain.push(art); prev = art.content_hash;
  }
  assert.equal((await verifyChain(chain, km)).ok, true);
  // remove the 3rd record -> chain must break
  const broken = [chain[0], chain[1], chain[3]];
  const res = await verifyChain(broken, km);
  assert.equal(res.ok, false);
  assert.equal(res.brokenAt, 2);
});

test('key rotation: old artifacts still verify under their historical key_id', async () => {
  const km = tmpSigner();
  const older = await mintArtifact(bodyFixture({ artifact_id: 'old' }), km);
  const firstKey = older.key_id;
  const newKey = km.rotate();
  assert.notEqual(firstKey, newKey);
  const newer = await mintArtifact(bodyFixture({ artifact_id: 'new' }), km);
  assert.equal(newer.key_id, newKey);
  // both verify against their own key
  assert.equal((await verifyArtifact(older, km)).ok, true);
  assert.equal((await verifyArtifact(newer, km)).ok, true);
});

test('keyed identifier hash: same token+salt is stable, differs by salt', () => {
  const s1 = generateUserSalt();
  const s2 = generateUserSalt();
  const h1 = identifierHash('user-token-abc', s1, 'pepper');
  const h1b = identifierHash('user-token-abc', s1, 'pepper');
  const h2 = identifierHash('user-token-abc', s2, 'pepper');
  assert.equal(h1, h1b);
  assert.notEqual(h1, h2);
  assert.ok(identifierMatches('user-token-abc', s1, h1, 'pepper'));
  assert.equal(identifierMatches('wrong-token', s1, h1, 'pepper'), false);
});

test('crypto-shredding: destroying the salt makes the identifier unrecoverable', () => {
  const salt = generateUserSalt();
  const h = identifierHash('tok', salt, 'pepper');
  // After the salt is gone, hashing throws and matching returns false forever.
  assert.throws(() => identifierHash('tok', null, 'pepper'), /crypto-shredded|destroyed/);
  assert.equal(identifierMatches('tok', null, h, 'pepper'), false);
});

test('pepper is required in addition to salt (defense in depth)', () => {
  const salt = generateUserSalt();
  const withPepper = identifierHash('tok', salt, 'server-pepper');
  const noPepper = identifierHash('tok', salt, '');
  assert.notEqual(withPepper, noPepper);
});

test('merkle root + inclusion proof round-trips; tampered leaf fails', () => {
  const leaves = ['aa', 'bb', 'cc', 'dd', 'ee'].map((x) => contentHash({ x }));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const proof = merkleProof(leaves, i);
    assert.equal(verifyMerkleProof(leaves[i], proof, root), true);
  }
  const proof0 = merkleProof(leaves, 0);
  assert.equal(verifyMerkleProof(leaves[1], proof0, root), false);
});

test('LocalDevSigner refuses to start in production', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => new LocalDevSigner(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prod-'))), /production/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});
