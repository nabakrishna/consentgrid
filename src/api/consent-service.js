// src/api/consent-service.js
// ─────────────────────────────────────────────────────────────────────────
// Core consent business logic. Enforces every [MUST-V1] legal guard before an
// artifact is minted, then signs + chains it and enqueues webhooks.
//
// Guards enforced here:
//   - No pre-ticked consent: a purpose may be `true` only if backed by an
//     explicit interaction event referencing that purpose_id.
//   - No silent language auto-selection: the payload must carry a
//     `language_confirmed` interaction event; the resolved locale must be an
//     APPROVED notice or minting is blocked (honest fallback).
//   - Minor flow: if is_minor, a verified guardian_verification is required.
//   - Identity: only the keyed id_hash is stored; raw token never persisted.
// ─────────────────────────────────────────────────────────────────────────

import { httpError } from './http.js';
import { mintArtifact, GENESIS_PREV_HASH } from '../crypto/artifact.js';
import { identifierHash } from '../crypto/identity.js';
import { ARTIFACT_SCHEMA_VERSION } from '../crypto/artifact.js';
import { uuid, nowIso, sha256hex } from '../lib/ids.js';

const VALID_ACTIONS = new Set(['GRANT', 'WITHDRAW', 'CORRECT', 'ERASE']);
const VALID_CHANNELS = new Set(['web', 'app', 'ivr', 'offline']);

/**
 * Validate that every purpose marked true has a matching explicit interaction.
 * interaction_events: [{type:'toggle'|'click'|'tap', purpose_id, value, ts}, ...]
 * Throws 422 on any pre-ticked / unbacked purpose.
 */
export function assertNoPreTicked(purposes, interactionEvents) {
  const interacted = new Map(); // purpose_id -> last boolean value from an explicit event
  for (const ev of interactionEvents || []) {
    if (ev && ev.purpose_id && (ev.type === 'toggle' || ev.type === 'click' || ev.type === 'tap')) {
      if (typeof ev.value === 'boolean') interacted.set(ev.purpose_id, ev.value);
      else interacted.set(ev.purpose_id, true); // a click without explicit value counts as an affirmative interaction
    }
  }
  for (const [pid, val] of Object.entries(purposes || {})) {
    if (val === true) {
      if (!interacted.has(pid)) {
        throw httpError(422, 'pre_ticked_rejected',
          `purpose "${pid}" is true but has no explicit user interaction event — pre-ticked/default-allow consent is not accepted`);
      }
      if (interacted.get(pid) !== true) {
        throw httpError(422, 'interaction_conflict',
          `purpose "${pid}" is true but the last interaction for it was not affirmative`);
      }
    }
  }
}

/** Require an explicit language-confirmation interaction. */
export function assertLanguageConfirmed(interactionEvents, locale) {
  const ok = (interactionEvents || []).some(
    (ev) => ev && ev.type === 'language_confirmed' && (!ev.locale || ev.locale === locale)
  );
  if (!ok) {
    throw httpError(422, 'language_not_confirmed',
      'consent requires an explicit language_confirmed interaction event (no silent auto-selection)');
  }
}

export class ConsentService {
  constructor(repo, km, { webhookEnqueue } = {}) {
    this.repo = repo;
    this.km = km;
    this.webhookEnqueue = webhookEnqueue; // async (orgId, eventType, payload)
  }

  /**
   * Record a consent event and mint a signed, chained artifact.
   * @returns the public artifact view (no raw PII).
   */
  async record(orgId, input) {
    const {
      user_token, action, channel = 'web', purposes = {}, interaction_events = [],
      locale, notice_version_hash, template_hash, variable_payload_hash,
      is_minor = false, guardian_verification_id = null,
      migrated = false, pre_existing_consent_date = null, expires_at = null,
    } = input;

    if (!user_token) throw httpError(400, 'missing_user_token', 'opaque user_token is required (never send raw PII)');
    if (!VALID_ACTIONS.has(action)) throw httpError(400, 'invalid_action', `action must be one of ${[...VALID_ACTIONS].join(',')}`);
    if (!VALID_CHANNELS.has(channel)) throw httpError(400, 'invalid_channel', `channel must be one of ${[...VALID_CHANNELS].join(',')}`);
    if (!locale) throw httpError(400, 'missing_locale', 'resolved locale is required');

    // ── Guards (skip purpose/lang checks for pure WITHDRAW/ERASE with no purposes) ──
    const isAffirmative = action === 'GRANT' || action === 'CORRECT';
    if (isAffirmative) {
      assertLanguageConfirmed(interaction_events, locale);
      assertNoPreTicked(purposes, interaction_events);

      // Honest fallback: the resolved locale MUST have an approved notice.
      const approved = await this.repo.getApprovedLocale(orgId, locale, null);
      if (!approved) {
        throw httpError(409, 'no_approved_notice',
          `no approved notice for locale "${locale}"; artifact minting is blocked until an approved notice exists (no silent English fallback)`);
      }
      // Bind the artifact to the actual approved notice version the user saw.
      if (notice_version_hash && notice_version_hash !== approved.notice_version_hash) {
        throw httpError(409, 'notice_version_mismatch',
          'submitted notice_version_hash does not match the current approved notice for this locale');
      }
      input._resolvedNotice = approved;
    }

    // ── Minor / guardian verification [MUST-V1] ──
    let guardianBlock = null;
    if (is_minor) {
      if (!guardian_verification_id) {
        throw httpError(428, 'guardian_verification_required',
          'is_minor=true requires a completed guardian verification (guardian_verification_id)');
      }
      const gv = await this.repo.getGuardianVerification(guardian_verification_id);
      if (!gv || gv.org_id !== orgId) throw httpError(400, 'guardian_verification_unknown', 'unknown guardian_verification_id');
      if (!gv.verified_at) throw httpError(428, 'guardian_not_verified', 'guardian verification is not yet completed');
      guardianBlock = {
        method: gv.method,
        ref_hash: gv.guardian_ref_hash, // hash only — never the raw phone
        verified_at: gv.verified_at,
        // Liability boundary is documented in LEGAL-OPEN-QUESTIONS.md and customer terms:
        // this proves the flow ran; it does NOT assert the phone truly belongs to a legal guardian.
        liability_note: 'flow-executed-not-identity-verified',
      };
    }

    // ── Identity: keyed hash only ──
    const user = await this.repo.upsertUser(orgId, user_token, { isMinor: is_minor });
    if (!user.salt) {
      // Salt already shredded => this identity was erased; refuse to re-mint under it.
      throw httpError(410, 'identity_shredded', 'this user identity has been erased (salt destroyed); cannot record new consent');
    }
    const id_hash = identifierHash(user_token, user.salt);

    // ── Build + sign + chain the artifact (atomic per org) ──
    const resolved = input._resolvedNotice;
    const view = await this.repo.db.tx(async (txdb) => {
      const txRepo = new (this.repo.constructor)(txdb);
      const { seq, prev_hash } = await txRepo.reserveSeq(orgId);

      const body = {
        schema_version: ARTIFACT_SCHEMA_VERSION,
        artifact_id: uuid(),
        org_id: orgId,
        id_hash,
        action,
        channel,
        purposes,
        interaction_events,
        locale,
        template_hash: template_hash || resolved?.template_hash || '',
        variable_payload_hash: variable_payload_hash || resolved?.variable_payload_hash || '',
        notice_version_hash: notice_version_hash || resolved?.notice_version_hash || '',
        is_minor: !!is_minor,
        guardian_verification: guardianBlock,
        migrated: !!migrated,
        pre_existing_consent_date: pre_existing_consent_date,
        expires_at: expires_at,
        prev_hash: prev_hash || GENESIS_PREV_HASH,
        created_at: nowIso(),
      };

      const artifact = await mintArtifact(body, this.km);
      await txRepo.commitArtifact(orgId, artifact, seq);

      // Lock the notice version now that it's referenced by a live artifact.
      if (body.notice_version_hash) await txRepo.lockVersionByHash(orgId, body.notice_version_hash);

      return { artifact, seq };
    });

    // ── Webhooks: standardized payload ──
    if (this.webhookEnqueue) {
      const eventType = action === 'WITHDRAW' ? 'consent.withdrawn'
        : action === 'ERASE' ? 'consent.erased'
        : action === 'CORRECT' ? 'consent.corrected'
        : 'consent.granted';
      // Standardized, machine-actionable, bidirectional revocation payload.
      const stdAction = (action === 'WITHDRAW' || action === 'ERASE') ? action : 'GRANT';
      for (const [pid, val] of Object.entries(purposes)) {
        // Emit one standardized directive per purpose so client middleware can act without custom parsing.
        await this.webhookEnqueue(orgId, eventType, {
          action: stdAction === 'GRANT' ? (val ? 'GRANT' : 'REVOKE') : stdAction,
          purpose_id: pid,
          user_token, // the client's own opaque token — they can map it back; platform stores only its hash
          artifact_id: view.artifact.body.artifact_id,
          occurred_at: view.artifact.body.created_at,
        });
      }
      if (Object.keys(purposes).length === 0 && (action === 'WITHDRAW' || action === 'ERASE')) {
        await this.webhookEnqueue(orgId, eventType, {
          action, purpose_id: '*', user_token, artifact_id: view.artifact.body.artifact_id, occurred_at: view.artifact.body.created_at,
        });
      }
    }

    return publicView(view.artifact);
  }

  /** [MUST-V1] Erasure via crypto-shredding: mint an ERASE artifact, then destroy the salt. */
  async erase(orgId, user_token, { reason = 'user_request' } = {}) {
    // Record the erasure event in the ledger FIRST (while we can still compute id_hash),
    // then destroy the salt. After that the identifier is unrecoverable.
    const view = await this.record(orgId, {
      user_token, action: 'ERASE', channel: 'web',
      purposes: {}, interaction_events: [{ type: 'erase_request', reason, ts: Date.now() }],
      locale: 'en',
    });
    await this.repo.shredUserSalt(orgId, user_token);
    return { erased: true, terminal_artifact_id: view.artifact_id, note: 'per-user salt destroyed; historical id_hash is now irreversible' };
  }
}

/** Strip anything sensitive; expose the signed body + proof fields. */
export function publicView(artifact) {
  return {
    artifact_id: artifact.body.artifact_id,
    org_id: artifact.body.org_id,
    action: artifact.body.action,
    channel: artifact.body.channel,
    purposes: artifact.body.purposes,
    locale: artifact.body.locale,
    notice_version_hash: artifact.body.notice_version_hash,
    is_minor: artifact.body.is_minor,
    expires_at: artifact.body.expires_at,
    created_at: artifact.body.created_at,
    content_hash: artifact.content_hash,
    key_id: artifact.key_id,
    algorithm: artifact.algorithm,
    signature: artifact.signature,
    id_hash: artifact.body.id_hash, // keyed hash, not PII
  };
}
