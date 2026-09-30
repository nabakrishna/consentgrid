// src/crypto/identity.js
// ─────────────────────────────────────────────────────────────────────────
// [MUST-V1] User identifier hashing + crypto-shredding erasure.
//
// The platform NEVER stores a raw identifier (email/phone). The client issues
// an opaque `user_token`; we store only a keyed hash of it.
//
//   id_hash = HMAC-SHA256( key = perUserSalt || SERVER_HMAC_PEPPER, msg = user_token )
//
//   - perUserSalt        : 32 random bytes, held by the Data Fiduciary (per user).
//                          Destroying it makes the hash irreversible => "erasure
//                          by crypto-shredding" without deleting ledger rows.
//   - SERVER_HMAC_PEPPER : global server secret (KMS/secret manager in prod).
//                          Defense-in-depth: even with a leaked salt, an
//                          attacker also needs the server pepper to brute-force
//                          a candidate token space.
//
// The salt is what gets deleted on a valid erasure request. The id_hash stays
// in the ledger so the hash-chain remains structurally intact for audit.
//
// NOTE (legal): whether this satisfies DPDP "erasure" is an OPEN QUESTION —
// see LEGAL-OPEN-QUESTIONS.md. Engineering does not resolve it.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

/** Generate a fresh 32-byte per-user salt (hex). Fiduciary-held. */
export function generateUserSalt() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute the keyed identifier hash.
 * @param {string} userToken  opaque client-issued token (never a raw email/phone)
 * @param {string} saltHex    per-user salt (hex). If null/destroyed, throws.
 * @param {string} pepper     server-side secret pepper
 * @returns {string} hex digest
 */
export function identifierHash(userToken, saltHex, pepper = process.env.SERVER_HMAC_PEPPER || '') {
  if (!userToken || typeof userToken !== 'string') throw new Error('userToken required');
  if (!saltHex) throw new Error('salt destroyed or missing: identifier is crypto-shredded (unrecoverable)');
  const key = Buffer.concat([Buffer.from(saltHex, 'hex'), Buffer.from(pepper, 'utf8')]);
  return crypto.createHmac('sha256', key).update(Buffer.from(userToken, 'utf8')).digest('hex');
}

/**
 * Verify a token maps to a stored id_hash (constant-time).
 * Returns false rather than throwing when the salt is gone — a shredded
 * identity simply can never match again.
 */
export function identifierMatches(userToken, saltHex, expectedHashHex, pepper = process.env.SERVER_HMAC_PEPPER || '') {
  if (!saltHex) return false;
  const got = Buffer.from(identifierHash(userToken, saltHex, pepper), 'hex');
  const exp = Buffer.from(expectedHashHex, 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}
