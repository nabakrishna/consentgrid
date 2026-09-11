// src/api/guardian-service.js
// [MUST-V1] Minor / verifiable-parental-consent flow (OTP mode).
//
// LIABILITY BOUNDARY (also in LEGAL-OPEN-QUESTIONS.md + customer terms):
// The platform has NO governmental authority to verify that a phone number
// belongs to an actual legal guardian. This flow proves only that an OTP sent
// to a guardian-declared number was entered back correctly. The resulting
// artifact records that the flow executed; the Data Fiduciary retains legal
// liability for the truth of the guardianship claim.
//
// We store only a HASH of the declared phone (guardian_ref_hash) and a HASH of
// the OTP — never the raw phone number or the raw OTP. [TIER-2] replaces this
// with DigiLocker/Aadhaar KUA, storing only a cryptographic transaction receipt.

import crypto from 'node:crypto';
import { httpError } from './http.js';
import { nowIso, sha256hex } from '../lib/ids.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export class GuardianService {
  constructor(repo, { otpSink } = {}) {
    this.repo = repo;
    // otpSink lets tests capture the OTP; in prod this is an SMS provider.
    // The OTP itself is NEVER logged or returned in API responses.
    this.otpSink = otpSink || (() => {});
  }

  /** Start guardian verification: generate + "send" an OTP to a declared phone. */
  async start(orgId, userRef, guardianPhone) {
    if (!guardianPhone) throw httpError(400, 'missing_guardian_phone', 'guardian phone (declared) is required');
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const guardianRefHash = sha256hex(`${orgId}:${guardianPhone}`);
    const otpHash = sha256hex(`${orgId}:${guardianPhone}:${otp}`);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    const gvId = await this.repo.createGuardianVerification(orgId, userRef, guardianRefHash, otpHash, expiresAt);
    // Deliver out-of-band. Never returned to the caller.
    this.otpSink({ gvId, guardianPhone, otp });
    return { guardian_verification_id: gvId, expires_at: expiresAt, delivery: 'otp_sent' };
  }

  /** Complete verification by checking the OTP. */
  async verify(orgId, gvId, guardianPhone, otp) {
    const gv = await this.repo.getGuardianVerification(gvId);
    if (!gv || gv.org_id !== orgId) throw httpError(404, 'not_found', 'unknown guardian_verification_id');
    if (gv.verified_at) return { verified: true, already: true };
    if (new Date(gv.expires_at).getTime() < Date.now()) throw httpError(410, 'otp_expired', 'OTP expired; restart verification');
    if (gv.attempts >= MAX_ATTEMPTS) throw httpError(429, 'too_many_attempts', 'too many OTP attempts; restart verification');

    const candidate = sha256hex(`${orgId}:${guardianPhone}:${otp}`);
    const ok = safeEq(candidate, gv.otp_hash) && safeEq(sha256hex(`${orgId}:${guardianPhone}`), gv.guardian_ref_hash);
    if (!ok) {
      await this.repo.bumpGuardianAttempts(gvId);
      throw httpError(401, 'otp_incorrect', 'incorrect OTP');
    }
    await this.repo.markGuardianVerified(gvId);
    return { verified: true };
  }
}

function safeEq(a, b) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
