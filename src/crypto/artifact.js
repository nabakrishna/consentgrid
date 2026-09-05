// src/crypto/artifact.js
// ─────────────────────────────────────────────────────────────────────────
// Consent Artifact: canonicalization, content hashing, hash-chain linking,
// signing, and self-verification.
//
// A Consent Artifact is the tamper-evident record of ONE consent event
// (grant / withdraw / correct / erase). Integrity has three layers:
//
//   1. content_hash : SHA-256 over the canonical artifact body. Detects any
//                     edit to a single record.
//   2. hash-chain   : each artifact embeds prev_hash (the previous artifact's
//                     content_hash within the same org partition). Detects
//                     deletion or reordering of records.
//   3. signature    : KMS/HSM ECDSA over (content_hash). Proves the record was
//                     minted by us and not fabricated. Tagged with key_id so
//                     rotation never breaks historical verification.
//
// [TIER-2] merkle_root_id links the artifact to an hourly Merkle root that is
// published to an external ledger (schema field present now; batching worker
// is a later build). Field is carried through signing so it can't be added
// retroactively without invalidating the signature.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';

export const ARTIFACT_SCHEMA_VERSION = '1.0.0';
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * The canonical, signable body of an artifact. Only these fields are covered
 * by content_hash + signature. Anything outside `body` (e.g. server receive
 * timestamps, delivery status) is metadata and NOT part of the proof.
 *
 * @typedef {Object} ArtifactBody
 * @property {string}  schema_version
 * @property {string}  artifact_id            uuid
 * @property {string}  org_id
 * @property {string}  id_hash                keyed hash of user_token (never raw PII)
 * @property {string}  action                 GRANT | WITHDRAW | CORRECT | ERASE
 * @property {string}  channel                web | app | ivr | offline
 * @property {Object}  purposes               { purpose_id: boolean } post-state
 * @property {Array}   interaction_events     explicit click/tap proof (no pre-tick)
 * @property {string}  locale                 the single language actually shown+confirmed
 * @property {string}  template_hash          immutable legal boilerplate hash
 * @property {string}  variable_payload_hash  runtime-injected specifics hash
 * @property {string}  notice_version_hash    combined notice version identifier
 * @property {boolean} is_minor
 * @property {?Object} guardian_verification   { method, ref_hash, verified_at } | null
 * @property {boolean} migrated
 * @property {?string} pre_existing_consent_date
 * @property {?string} expires_at             re-consent cadence (nullable)
 * @property {string}  prev_hash              chain link
 * @property {string}  created_at             ISO8601 (event time)
 */

/** SHA-256 hex over the canonical body. */
export function contentHash(body) {
  const canon = canonicalize(body);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Build + sign an artifact.
 * @param {ArtifactBody} body  fully-populated body EXCEPT content_hash/signature.
 * @param {import('./kms.js').KeyManager} km
 * @returns {Promise<{body:ArtifactBody, content_hash:string, key_id:string, algorithm:string, signature:string}>}
 */
export async function mintArtifact(body, km) {
  const ch = contentHash(body);
  const sig = await km.sign(Buffer.from(ch, 'hex'));
  return {
    body,
    content_hash: ch,
    key_id: sig.key_id,
    algorithm: sig.algorithm,
    signature: sig.signature,
  };
}

/**
 * Self-verify a single artifact: recompute content_hash and check the
 * signature against the (historical) key_id it was signed with.
 * @returns {Promise<{ok:boolean, content_hash_ok:boolean, signature_ok:boolean}>}
 */
export async function verifyArtifact(artifact, km) {
  const recomputed = contentHash(artifact.body);
  const content_hash_ok = recomputed === artifact.content_hash;
  let signature_ok = false;
  if (content_hash_ok) {
    signature_ok = await km.verify(Buffer.from(artifact.content_hash, 'hex'), artifact.signature, artifact.key_id);
  }
  return { ok: content_hash_ok && signature_ok, content_hash_ok, signature_ok };
}

/**
 * Verify an ordered chain of artifacts (same org partition).
 * Checks each artifact individually AND that prev_hash links are intact.
 * @param {Array} artifacts  ordered oldest -> newest
 * @param {import('./kms.js').KeyManager} km
 * @returns {Promise<{ok:boolean, count:number, brokenAt:?number, reason:?string}>}
 */
export async function verifyChain(artifacts, km) {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];
    if (a.body.prev_hash !== expectedPrev) {
      return { ok: false, count: artifacts.length, brokenAt: i, reason: 'prev_hash mismatch (record inserted/removed/reordered)' };
    }
    const v = await verifyArtifact(a, km);
    if (!v.ok) {
      return {
        ok: false,
        count: artifacts.length,
        brokenAt: i,
        reason: !v.content_hash_ok ? 'content_hash mismatch (record edited)' : 'signature invalid',
      };
    }
    expectedPrev = a.content_hash;
  }
  return { ok: true, count: artifacts.length, brokenAt: null, reason: null };
}

// ── Merkle tree [TIER-2 anchoring; helper available now] ─────────────────────
/**
 * Compute a Merkle root over an ordered list of leaf hashes (hex).
 * Odd nodes are promoted (Bitcoin-style duplication avoided; we promote to
 * prevent CVE-2012-2459-class duplicate-leaf ambiguity).
 * @param {string[]} leafHexes
 * @returns {string} root hex ('' for empty input)
 */
export function merkleRoot(leafHexes) {
  if (leafHexes.length === 0) return '';
  let level = leafHexes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(crypto.createHash('sha256').update(Buffer.from(level[i] + level[i + 1], 'hex')).digest('hex'));
      } else {
        next.push(level[i]); // promote unpaired node
      }
    }
    level = next;
  }
  return level[0];
}

/**
 * Produce a Merkle inclusion proof for leaf at `index`.
 * @returns {Array<{hash:string, side:'left'|'right'}>}
 */
export function merkleProof(leafHexes, index) {
  const proof = [];
  let idx = index;
  let level = leafHexes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx || i + 1 === idx) {
          const isLeft = idx === i + 1; // sibling is on the left
          proof.push({ hash: isLeft ? level[i] : level[i + 1], side: isLeft ? 'left' : 'right' });
        }
        next.push(crypto.createHash('sha256').update(Buffer.from(level[i] + level[i + 1], 'hex')).digest('hex'));
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Verify a Merkle inclusion proof. */
export function verifyMerkleProof(leafHex, proof, rootHex) {
  let acc = leafHex;
  for (const step of proof) {
    const pair = step.side === 'left' ? step.hash + acc : acc + step.hash;
    acc = crypto.createHash('sha256').update(Buffer.from(pair, 'hex')).digest('hex');
  }
  return acc === rootHex;
}
