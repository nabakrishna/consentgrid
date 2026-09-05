// src/db/repo.js
// ─────────────────────────────────────────────────────────────────────────
// Repository layer: all SQL lives here. App/route code never writes SQL.
// Every method threads params positionally and uses db.placeholder(i) so the
// same code runs on SQLite (?) and Postgres ($1). Methods are async to work
// with the async Postgres adapter; the sync SQLite adapter is await-safe.
// ─────────────────────────────────────────────────────────────────────────

import { uuid, nowIso, sha256hex, toBool, asJson, jsonParam } from '../lib/ids.js';

// Small helper to build "$1,$2,..." or "?,?,..." placeholder lists.
function ph(db, startAt, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(db.placeholder(startAt + i));
  return out.join(',');
}

export class Repo {
  constructor(db) { this.db = db; }

  // ── Orgs & auth ─────────────────────────────────────────────────────────
  async createOrg({ name, email, passwordHash }) {
    const org_id = uuid();
    const p = (i) => this.db.placeholder(i);
    await this.db.run(
      `INSERT INTO orgs(org_id,name,email,password_hash,status,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},'active',${p(5)})`,
      [org_id, name, email, passwordHash, nowIso()]
    );
    await this.db.run(
      `INSERT INTO org_sequences(org_id,next_seq,last_hash)
       VALUES(${p(1)},1,'${'0'.repeat(64)}')`,
      [org_id]
    );
    return org_id;
  }

  async getOrgByEmail(email) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(`SELECT * FROM orgs WHERE email=${p(1)}`, [email]);
  }
  async getOrg(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(`SELECT * FROM orgs WHERE org_id=${p(1)}`, [orgId]);
  }

  // ── API keys ─────────────────────────────────────────────────────────────
  async createApiKey(orgId, label, fullKey, scope = 'server') {
    const p = (i) => this.db.placeholder(i);
    const key_id = uuid();
    await this.db.run(
      `INSERT INTO api_keys(key_id,org_id,label,key_prefix,key_hash,scope,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
      [key_id, orgId, label, fullKey.slice(0, 8), sha256hex(fullKey), scope, nowIso()]
    );
    return key_id;
  }
  async findApiKey(fullKey) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(
      `SELECT * FROM api_keys WHERE key_hash=${p(1)} AND revoked_at IS NULL`,
      [sha256hex(fullKey)]
    );
  }
  async listApiKeys(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT key_id,label,key_prefix,scope,revoked_at,created_at FROM api_keys WHERE org_id=${p(1)} ORDER BY created_at DESC`,
      [orgId]
    );
  }
  async revokeApiKey(orgId, keyId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE api_keys SET revoked_at=${p(1)} WHERE org_id=${p(2)} AND key_id=${p(3)}`,
      [nowIso(), orgId, keyId]
    );
  }

  // ── Users (Data Principals) ──────────────────────────────────────────────
  async upsertUser(orgId, userRef, { isMinor = false } = {}) {
    const p = (i) => this.db.placeholder(i);
    const existing = await this.db.get(
      `SELECT * FROM users WHERE org_id=${p(1)} AND user_ref=${p(2)}`, [orgId, userRef]
    );
    if (existing) return existing;
    // New user gets a fresh per-user salt (Fiduciary-held).
    const { generateUserSalt } = await import('../crypto/identity.js');
    const salt = generateUserSalt();
    await this.db.run(
      `INSERT INTO users(org_id,user_ref,salt,is_minor,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      [orgId, userRef, salt, isMinor ? 1 : 0, nowIso()]
    );
    return this.db.get(`SELECT * FROM users WHERE org_id=${p(1)} AND user_ref=${p(2)}`, [orgId, userRef]);
  }
  async getUser(orgId, userRef) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(`SELECT * FROM users WHERE org_id=${p(1)} AND user_ref=${p(2)}`, [orgId, userRef]);
  }
  /** [MUST-V1] Crypto-shred: destroy the per-user salt. Ledger rows are untouched. */
  async shredUserSalt(orgId, userRef) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE users SET salt=NULL, shredded_at=${p(1)} WHERE org_id=${p(2)} AND user_ref=${p(3)}`,
      [nowIso(), orgId, userRef]
    );
  }

  // ── Notice templates / versions / locales ────────────────────────────────
  async createTemplate(orgId, name, purposes) {
    const p = (i) => this.db.placeholder(i);
    const template_id = uuid();
    await this.db.run(
      `INSERT INTO notice_templates(template_id,org_id,name,purposes,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      [template_id, orgId, name, jsonParam(purposes), nowIso()]
    );
    return template_id;
  }

  async listTemplates(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT template_id,name,purposes,created_at FROM notice_templates WHERE org_id=${p(1)} ORDER BY created_at DESC`,
      [orgId]
    );
  }

  async listVersions(orgId, templateId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT version_id,version_num,template_hash,variable_payload_hash,notice_version_hash,locked,created_at
         FROM notice_versions WHERE org_id=${p(1)} AND template_id=${p(2)} ORDER BY version_num DESC`,
      [orgId, templateId]
    );
  }
  async createVersion(orgId, templateId, { templateHash, variablePayload }) {
    const p = (i) => this.db.placeholder(i);
    const version_id = uuid();
    const row = await this.db.get(
      `SELECT COALESCE(MAX(version_num),0)+1 AS n FROM notice_versions WHERE template_id=${p(1)}`,
      [templateId]
    );
    const version_num = Number(row.n);
    const variablePayloadHash = sha256hex(JSON.stringify(variablePayload ?? {}));
    const noticeVersionHash = sha256hex(templateHash + variablePayloadHash);
    await this.db.run(
      `INSERT INTO notice_versions(version_id,template_id,org_id,version_num,template_hash,variable_payload,variable_payload_hash,notice_version_hash,locked,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},0,${p(9)})`,
      [version_id, templateId, orgId, version_num, templateHash, jsonParam(variablePayload ?? {}), variablePayloadHash, noticeVersionHash, nowIso()]
    );
    return { version_id, version_num, notice_version_hash: noticeVersionHash, template_hash: templateHash, variable_payload_hash: variablePayloadHash };
  }

  async addLocale(orgId, versionId, { locale, title, bodyHtml, direction = 'ltr', autoTranslated = false }) {
    const p = (i) => this.db.placeholder(i);
    await this.db.run(
      `INSERT INTO notice_locales(version_id,org_id,locale,title,body_html,direction,legal_review_state,auto_translated,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},'draft',${p(7)},${p(8)})`,
      [versionId, orgId, locale, title, bodyHtml, direction, autoTranslated ? 1 : 0, nowIso()]
    );
  }

  async approveLocale(orgId, versionId, locale, approvedBy) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE notice_locales SET legal_review_state='approved', approved_by=${p(1)}, approved_at=${p(2)}
       WHERE org_id=${p(3)} AND version_id=${p(4)} AND locale=${p(5)}`,
      [approvedBy, nowIso(), orgId, versionId, locale]
    );
  }

  async getApprovedLocale(orgId, locale, versionId = null) {
    const p = (i) => this.db.placeholder(i);
    if (versionId) {
      return this.db.get(
        `SELECT nl.*, nv.notice_version_hash, nv.template_hash, nv.variable_payload_hash, nv.version_id
           FROM notice_locales nl JOIN notice_versions nv ON nv.version_id=nl.version_id
          WHERE nl.org_id=${p(1)} AND nl.locale=${p(2)} AND nl.version_id=${p(3)} AND nl.legal_review_state='approved'`,
        [orgId, locale, versionId]
      );
    }
    // Latest approved version for this locale.
    return this.db.get(
      `SELECT nl.*, nv.notice_version_hash, nv.template_hash, nv.variable_payload_hash, nv.version_id, nv.version_num
         FROM notice_locales nl JOIN notice_versions nv ON nv.version_id=nl.version_id
        WHERE nl.org_id=${p(1)} AND nl.locale=${p(2)} AND nl.legal_review_state='approved'
        ORDER BY nv.version_num DESC LIMIT 1`,
      [orgId, locale]
    );
  }

  async approvedLocalesForOrg(orgId) {
    const p = (i) => this.db.placeholder(i);
    const rows = await this.db.all(
      `SELECT DISTINCT locale FROM notice_locales WHERE org_id=${p(1)} AND legal_review_state='approved'`,
      [orgId]
    );
    return rows.map((r) => r.locale);
  }

  async listLocales(orgId, versionId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT locale,title,direction,legal_review_state,auto_translated,approved_by,approved_at
         FROM notice_locales WHERE org_id=${p(1)} AND version_id=${p(2)} ORDER BY locale`,
      [orgId, versionId]
    );
  }

  /** Lock a version once it is first referenced by a live artifact. */
  async lockVersionByHash(orgId, noticeVersionHash) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE notice_versions SET locked=1 WHERE org_id=${p(1)} AND notice_version_hash=${p(2)} AND locked=0`,
      [orgId, noticeVersionHash]
    );
  }

  // ── Artifacts (append-only ledger) ────────────────────────────────────────
  /** Reserve the next sequence + prev_hash for an org, atomically. */
  async reserveSeq(orgId) {
    const p = (i) => this.db.placeholder(i);
    const row = await this.db.get(`SELECT next_seq,last_hash FROM org_sequences WHERE org_id=${p(1)}`, [orgId]);
    if (!row) throw new Error('org_sequences row missing');
    return { seq: Number(row.next_seq), prev_hash: row.last_hash };
  }

  async commitArtifact(orgId, artifact, seq) {
    const p = (i) => this.db.placeholder(i);
    const b = artifact.body;
    await this.db.run(
      `INSERT INTO consent_artifacts(
         artifact_id,org_id,seq,id_hash,action,channel,purposes,interaction_events,locale,
         template_hash,variable_payload_hash,notice_version_hash,is_minor,guardian_verification,
         migrated,pre_existing_consent_date,expires_at,prev_hash,content_hash,key_id,algorithm,signature,
         merkle_root_id,created_at,received_at)
       VALUES(${ph(this.db, 1, 25)})`,
      [
        b.artifact_id, orgId, seq, b.id_hash, b.action, b.channel,
        jsonParam(b.purposes), jsonParam(b.interaction_events), b.locale,
        b.template_hash, b.variable_payload_hash, b.notice_version_hash,
        b.is_minor ? 1 : 0, jsonParam(b.guardian_verification),
        b.migrated ? 1 : 0, b.pre_existing_consent_date, b.expires_at,
        b.prev_hash, artifact.content_hash, artifact.key_id, artifact.algorithm, artifact.signature,
        null, b.created_at, nowIso(),
      ]
    );
    // Advance the sequence + last_hash so the next artifact chains correctly.
    await this.db.run(
      `UPDATE org_sequences SET next_seq=${p(1)}, last_hash=${p(2)} WHERE org_id=${p(3)}`,
      [seq + 1, artifact.content_hash, orgId]
    );
  }

  async getArtifactById(artifactId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(`SELECT * FROM consent_artifacts WHERE artifact_id=${p(1)}`, [artifactId]);
  }

  async listArtifactsForUser(orgId, idHash) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT * FROM consent_artifacts WHERE org_id=${p(1)} AND id_hash=${p(2)} ORDER BY seq ASC`,
      [orgId, idHash]
    );
  }

  async listArtifactsForOrg(orgId, { limit = 100, offset = 0, action = null, locale = null } = {}) {
    const p = (i) => this.db.placeholder(i);
    let sql = `SELECT * FROM consent_artifacts WHERE org_id=${p(1)}`;
    const params = [orgId];
    let n = 2;
    if (action) { sql += ` AND action=${p(n++)}`; params.push(action); }
    if (locale) { sql += ` AND locale=${p(n++)}`; params.push(locale); }
    sql += ` ORDER BY seq DESC LIMIT ${p(n++)} OFFSET ${p(n++)}`;
    params.push(limit, offset);
    return this.db.all(sql, params);
  }

  async chainForOrg(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(`SELECT * FROM consent_artifacts WHERE org_id=${p(1)} ORDER BY seq ASC`, [orgId]);
  }

  // ── Guardian verification (minor flow) ────────────────────────────────────
  async createGuardianVerification(orgId, userRef, guardianRefHash, otpHash, expiresAt) {
    const p = (i) => this.db.placeholder(i);
    const gv_id = uuid();
    await this.db.run(
      `INSERT INTO guardian_verifications(gv_id,org_id,user_ref,method,guardian_ref_hash,otp_hash,attempts,expires_at,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},'otp',${p(4)},${p(5)},0,${p(6)},${p(7)})`,
      [gv_id, orgId, userRef, guardianRefHash, otpHash, expiresAt, nowIso()]
    );
    return gv_id;
  }
  async getGuardianVerification(gvId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.get(`SELECT * FROM guardian_verifications WHERE gv_id=${p(1)}`, [gvId]);
  }
  async markGuardianVerified(gvId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(`UPDATE guardian_verifications SET verified_at=${p(1)} WHERE gv_id=${p(2)}`, [nowIso(), gvId]);
  }
  async bumpGuardianAttempts(gvId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(`UPDATE guardian_verifications SET attempts=attempts+1 WHERE gv_id=${p(1)}`, [gvId]);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────
  async createWebhookEndpoint(orgId, url, secret, events) {
    const p = (i) => this.db.placeholder(i);
    const endpoint_id = uuid();
    await this.db.run(
      `INSERT INTO webhook_endpoints(endpoint_id,org_id,url,secret,events,active,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},1,${p(6)})`,
      [endpoint_id, orgId, url, secret, jsonParam(events), nowIso()]
    );
    return endpoint_id;
  }
  async listWebhookEndpoints(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(`SELECT * FROM webhook_endpoints WHERE org_id=${p(1)} AND active=1`, [orgId]);
  }
  async enqueueDelivery(endpointId, orgId, eventType, payload) {
    const p = (i) => this.db.placeholder(i);
    const delivery_id = uuid();
    await this.db.run(
      `INSERT INTO webhook_deliveries(delivery_id,endpoint_id,org_id,event_type,payload,status,attempts,next_attempt_at,created_at,updated_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},'pending',0,${p(6)},${p(7)},${p(8)})`,
      [delivery_id, endpointId, orgId, eventType, jsonParam(payload), nowIso(), nowIso(), nowIso()]
    );
    return delivery_id;
  }
  async claimDueDeliveries(limit = 20) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT d.*, e.url AS endpoint_url, e.secret AS endpoint_secret
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.endpoint_id=d.endpoint_id
        WHERE d.status='pending' AND d.next_attempt_at<=${p(1)}
        ORDER BY d.next_attempt_at ASC LIMIT ${p(2)}`,
      [nowIso(), limit]
    );
  }
  async markDelivered(deliveryId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE webhook_deliveries SET status='delivered',updated_at=${p(1)},attempts=attempts+1 WHERE delivery_id=${p(2)}`,
      [nowIso(), deliveryId]
    );
  }
  async rescheduleDelivery(deliveryId, nextAttemptAt, error, dead = false) {
    const p = (i) => this.db.placeholder(i);
    return this.db.run(
      `UPDATE webhook_deliveries SET status=${p(1)},attempts=attempts+1,next_attempt_at=${p(2)},last_error=${p(3)},updated_at=${p(4)} WHERE delivery_id=${p(5)}`,
      [dead ? 'dead' : 'pending', nextAttemptAt, String(error).slice(0, 500), nowIso(), deliveryId]
    );
  }
  async listDeadLetters(orgId) {
    const p = (i) => this.db.placeholder(i);
    return this.db.all(
      `SELECT delivery_id,event_type,attempts,last_error,created_at FROM webhook_deliveries WHERE org_id=${p(1)} AND status='dead' ORDER BY created_at DESC`,
      [orgId]
    );
  }

  // ── Incident log [DESIGN-FOR] ─────────────────────────────────────────────
  async logIncident(orgId, severity, summary, detail) {
    const p = (i) => this.db.placeholder(i);
    const incident_id = uuid();
    await this.db.run(
      `INSERT INTO incident_log(incident_id,org_id,severity,summary,detail,created_at)
       VALUES(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [incident_id, orgId, severity, summary, jsonParam(detail), nowIso()]
    );
    return incident_id;
  }
}

export { toBool, asJson };
