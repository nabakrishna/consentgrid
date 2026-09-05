// src/api/routes.js
// Wires all HTTP endpoints onto the Router. Grouped by audience:
//   public widget/API (api-key or open), dashboard (session), verification (open).

import crypto from 'node:crypto';
import { httpError } from './http.js';
import { requireApiKey, requireSession, requireRole, authenticateOrg, issueSession } from './auth.js';
import { hashPassword } from '../lib/password.js';
import { ConsentService, publicView } from './consent-service.js';
import { GuardianService } from './guardian-service.js';
import { verifyArtifact, verifyChain } from '../crypto/artifact.js';
import { resolveCandidates, isRtl } from '../lib/language.js';
import { botScore, TokenBucket } from '../lib/ratelimit.js';
import { asJson, toBool, nowIso, sha256hex } from '../lib/ids.js';
import { makeEnqueue } from '../webhook/dispatcher.js';

export function registerRoutes(router, { repo, km, hooks = {} }) {
  const enqueue = makeEnqueue(repo);
  const consent = new ConsentService(repo, km, { webhookEnqueue: enqueue });
  const guardian = new GuardianService(repo, {
    otpSink: ({ gvId, otp, guardianPhone }) => {
      // Test/dev capture hook (never used in production wiring).
      if (typeof hooks.otpSink === 'function') hooks.otpSink({ gvId, otp, guardianPhone });
      // DEV ONLY: surface OTP to server logs so you can test without an SMS provider.
      // The OTP is NEVER returned in an API response.
      if (process.env.NODE_ENV !== 'production') console.error(`[dev-otp] gv=${gvId} otp=${otp}`);
    },
  });
  const limiter = new TokenBucket({ rps: Number(process.env.RATE_LIMIT_RPS || 20), burst: Number(process.env.RATE_LIMIT_BURST || 40) });
  setInterval(() => limiter.sweep(), 30000).unref?.();

  const setSessionCookie = (res, token) =>
    res.setHeader('set-cookie', `cg_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);

  // ── Health ────────────────────────────────────────────────────────────────
  router.get('/health', ({ send }) => send(200, { ok: true, ts: nowIso() }));

  // ── Org signup / login (dashboard) ─────────────────────────────────────────
  router.post('/v1/orgs', async ({ body, send }) => {
    const { name, email, password } = body || {};
    if (!name || !email || !password) throw httpError(400, 'missing_fields', 'name, email, password required');
    if (await repo.getOrgByEmail(email)) throw httpError(409, 'email_taken', 'email already registered');
    const orgId = await repo.createOrg({ name, email, passwordHash: hashPassword(password) });
    // Postgres: create the org's artifact partition now.
    try { const { ensureOrgPartition } = await import('../db/partitions.js'); await ensureOrgPartition(repo.db, orgId); } catch { /* sqlite no-op */ }
    // Issue an initial API key (shown once).
    const fullKey = `cg_live_${crypto.randomBytes(24).toString('base64url')}`;
    await repo.createApiKey(orgId, 'default', fullKey);
    const token = issueSession(orgId, 'owner');
    send(201, { org_id: orgId, api_key: fullKey, session: token, note: 'store the api_key now; it will not be shown again' });
  });

  router.post('/v1/sessions', async ({ body, res, send }) => {
    const { email, password } = body || {};
    const org = await authenticateOrg(repo, email, password);
    if (!org) throw httpError(401, 'invalid_credentials', 'bad email or password');
    const token = issueSession(org.org_id, 'owner');
    setSessionCookie(res, token);
    send(200, { org_id: org.org_id, session: token });
  });

  // ── API key management (dashboard) ──────────────────────────────────────────
  router.get('/v1/api-keys', async ({ req, send }) => {
    const s = requireSession(req);
    send(200, { keys: await repo.listApiKeys(s.orgId) });
  });
  router.post('/v1/api-keys', async ({ req, body, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    const fullKey = `cg_live_${crypto.randomBytes(24).toString('base64url')}`;
    const keyId = await repo.createApiKey(s.orgId, (body && body.label) || 'key', fullKey);
    send(201, { key_id: keyId, api_key: fullKey, note: 'store now; not shown again' });
  });
  router.del('/v1/api-keys/:id', async ({ req, params, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    await repo.revokeApiKey(s.orgId, params.id);
    send(200, { revoked: true });
  });

  // ── Notice templates + versions + locales (dashboard) ───────────────────────
  router.post('/v1/templates', async ({ req, body, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    const { name, purposes } = body || {};
    if (!name || !Array.isArray(purposes)) throw httpError(400, 'invalid', 'name + purposes[] required');
    const id = await repo.createTemplate(s.orgId, name, purposes);
    send(201, { template_id: id });
  });

  router.get('/v1/templates', async ({ req, send }) => {
    const s = requireSession(req);
    const templates = (await repo.listTemplates(s.orgId)).map((t) => ({
      template_id: t.template_id, name: t.name, purposes: asJson(t.purposes, []), created_at: t.created_at,
    }));
    send(200, { templates });
  });

  router.get('/v1/templates/:id/versions', async ({ req, params, send }) => {
    const s = requireSession(req);
    send(200, { versions: await repo.listVersions(s.orgId, params.id) });
  });

  router.post('/v1/templates/:id/versions', async ({ req, params, body, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    const { template_boilerplate, variable_payload } = body || {};
    if (!template_boilerplate) throw httpError(400, 'invalid', 'template_boilerplate (legal text) required');
    const templateHash = sha256hex(template_boilerplate);
    const v = await repo.createVersion(s.orgId, params.id, { templateHash, variablePayload: variable_payload || {} });
    send(201, v);
  });

  router.post('/v1/versions/:vid/locales', async ({ req, params, body, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    const { locale, title, body_html, direction, auto_translated } = body || {};
    if (!locale || !title || !body_html) throw httpError(400, 'invalid', 'locale, title, body_html required');
    await repo.addLocale(s.orgId, params.vid, {
      locale, title, bodyHtml: body_html,
      direction: direction || (isRtl(locale) ? 'rtl' : 'ltr'),
      autoTranslated: !!auto_translated,
    });
    send(201, { added: true, direction: direction || (isRtl(locale) ? 'rtl' : 'ltr') });
  });

  router.post('/v1/versions/:vid/locales/:locale/approve', async ({ req, params, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    await repo.approveLocale(s.orgId, params.vid, params.locale, `session:${s.orgId}`);
    send(200, { approved: true });
  });

  router.get('/v1/versions/:vid/locales', async ({ req, params, send }) => {
    const s = requireSession(req);
    send(200, { locales: await repo.listLocales(s.orgId, params.vid) });
  });

  // ── Language resolution (public; used by widget) ────────────────────────────
  // Returns a 3–4 language shortlist. Never the full 22 unless ?all=1.
  router.get('/v1/languages/resolve', async ({ query, send }) => {
    const orgId = query.org_id;
    if (!orgId) throw httpError(400, 'missing_org_id', 'org_id required');
    const approved = await repo.approvedLocalesForOrg(orgId);
    const navigatorLanguages = (query.nav || '').split(',').map((x) => x.trim()).filter(Boolean);
    const result = resolveCandidates({
      htmlLang: query.html_lang || null,
      storedPreference: query.stored || null,
      navigatorLanguages,
      approved,
    });
    send(200, {
      ...result,
      approved_all: approved, // used only if the user taps "More languages"
      note: 'suggestion only; explicit user confirmation required before notice is considered shown',
    });
  });

  // ── Notice fetch (public; single language, cached) ──────────────────────────
  router.get('/v1/notice', async ({ query, send, res }) => {
    const { org_id, locale } = query;
    if (!org_id || !locale) throw httpError(400, 'missing_params', 'org_id and locale required');
    const approved = await repo.getApprovedLocale(org_id, locale, query.version_id || null);
    if (!approved) {
      // Honest fallback: signal explicitly that this locale is unavailable.
      return send(409, {
        available: false,
        locale,
        message: `This notice isn't yet available in "${locale}". Consent will not be recorded until an approved notice exists in your language.`,
      });
    }
    // Cache per (org, locale, version) at the edge.
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
    res.setHeader('etag', `"${approved.notice_version_hash}"`);
    send(200, {
      available: true,
      org_id, locale,
      direction: approved.direction,
      title: approved.title,
      body_html: approved.body_html,
      auto_translated: toBool(approved.auto_translated),
      notice_version_hash: approved.notice_version_hash,
      template_hash: approved.template_hash,
      variable_payload_hash: approved.variable_payload_hash,
      version_id: approved.version_id,
    });
  });

  // ── Guardian verification (public; minor flow) ──────────────────────────────
  router.post('/v1/guardian/start', async ({ req, body, send }) => {
    const api = await requireApiKey(req, repo);
    const { user_token, guardian_phone } = body || {};
    if (!user_token) throw httpError(400, 'missing_user_token', 'user_token required');
    const r = await guardian.start(api.org_id, user_token, guardian_phone);
    send(201, r);
  });
  router.post('/v1/guardian/verify', async ({ req, body, send }) => {
    const api = await requireApiKey(req, repo);
    const { guardian_verification_id, guardian_phone, otp } = body || {};
    const r = await guardian.verify(api.org_id, guardian_verification_id, guardian_phone, otp);
    send(200, r);
  });

  // ── Consent submission (public; api-key + rate limit + bot check) ───────────
  router.post('/v1/consent', async ({ req, body, ctx, send }) => {
    const api = await requireApiKey(req, repo);
    // Rate limit per (org, ip).
    if (!limiter.take(`${api.org_id}:${ctx.ip}`)) throw httpError(429, 'rate_limited', 'too many requests');
    // Bot heuristics on the submission.
    const score = botScore({
      userAgent: ctx.userAgent,
      interactionEvents: body && body.interaction_events,
      timingMs: body && body.notice_shown_to_submit_ms,
    });
    if (score.bot) {
      await repo.logIncident(api.org_id, 'low', 'bot_submission_blocked', { reasons: score.reasons, ip_hash: sha256hex(ctx.ip) });
      throw httpError(403, 'bot_detected', `submission rejected: ${score.reasons.join(',')}`);
    }
    const view = await consent.record(api.org_id, body || {});
    ctx.log.info('consent_recorded', { org_id: api.org_id, artifact_id: view.artifact_id, action: view.action, id_hash: view.id_hash.slice(0, 12) });
    send(201, view);
  });

  // ── Erasure (public; api-key) — crypto-shred ────────────────────────────────
  router.post('/v1/erase', async ({ req, body, send }) => {
    const api = await requireApiKey(req, repo);
    const { user_token, reason } = body || {};
    if (!user_token) throw httpError(400, 'missing_user_token', 'user_token required');
    const r = await consent.erase(api.org_id, user_token, { reason });
    send(200, r);
  });

  // ── Self-service consent history (public; api-key, scoped to a user_token) ──
  // [MUST-V1] end user (via the client) fetches their own artifacts.
  router.get('/v1/consent/history', async ({ req, query, send }) => {
    const api = await requireApiKey(req, repo);
    const { user_token } = query;
    if (!user_token) throw httpError(400, 'missing_user_token', 'user_token required');
    const user = await repo.getUser(api.org_id, user_token);
    if (!user || !user.salt) return send(200, { artifacts: [], note: 'no records or identity erased' });
    const { identifierHash } = await import('../crypto/identity.js');
    const idHash = identifierHash(user_token, user.salt);
    const rows = await repo.listArtifactsForUser(api.org_id, idHash);
    send(200, { artifacts: rows.map(rowToPublic) });
  });

  // ── Artifact fetch + self-verify (public; api-key) ──────────────────────────
  router.get('/v1/artifacts/:id', async ({ req, params, send }) => {
    const api = await requireApiKey(req, repo);
    const row = await repo.getArtifactById(params.id);
    if (!row || row.org_id !== api.org_id) throw httpError(404, 'not_found', 'artifact not found');
    send(200, rowToPublic(row));
  });

  router.get('/v1/artifacts/:id/verify', async ({ req, params, send }) => {
    const api = await requireApiKey(req, repo);
    const row = await repo.getArtifactById(params.id);
    if (!row || row.org_id !== api.org_id) throw httpError(404, 'not_found', 'artifact not found');
    const artifact = rowToArtifact(row);
    const v = await verifyArtifact(artifact, km);
    send(200, { artifact_id: params.id, ...v });
  });

  // ── Public verification (NO account) [DESIGN-FOR] ───────────────────────────
  // Anyone can verify an artifact_id: signature validity, notice version, time.
  router.get('/v1/verify/:id', async ({ params, send }) => {
    const row = await repo.getArtifactById(params.id);
    if (!row) return send(404, { found: false });
    const artifact = rowToArtifact(row);
    const v = await verifyArtifact(artifact, km);
    send(200, {
      found: true,
      artifact_id: params.id,
      signature_valid: v.signature_ok,
      content_hash_intact: v.content_hash_ok,
      notice_version_hash: row.notice_version_hash,
      locale: row.locale,
      action: row.action,
      timestamp: row.created_at,
      key_id: row.key_id,
      // No PII, no purposes detail — just the proof surface.
    });
  });

  // ── Chain verification for an org (dashboard) ───────────────────────────────
  router.get('/v1/chain/verify', async ({ req, send }) => {
    const s = requireSession(req);
    const rows = await repo.chainForOrg(s.orgId);
    const artifacts = rows.map(rowToArtifact);
    const result = await verifyChain(artifacts, km);
    send(200, result);
  });

  // ── Consent log + export (dashboard) ────────────────────────────────────────
  router.get('/v1/consent-log', async ({ req, query, send }) => {
    const s = requireSession(req);
    const rows = await repo.listArtifactsForOrg(s.orgId, {
      limit: Math.min(Number(query.limit || 100), 1000),
      offset: Number(query.offset || 0),
      action: query.action || null,
      locale: query.locale || null,
    });
    send(200, { artifacts: rows.map(rowToPublic) });
  });

  router.get('/v1/export', async ({ req, query, res, send }) => {
    const s = requireSession(req);
    const rows = await repo.listArtifactsForOrg(s.orgId, { limit: 100000, offset: 0 });
    if ((query.format || 'json') === 'csv') {
      const csv = toCsv(rows.map(rowToPublic));
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="consent-export.csv"' });
      return res.end(csv);
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="consent-export.json"' });
    res.end(JSON.stringify({ schema: 'consentgrid.artifact-export.v1', artifacts: rows.map(rowToPublic) }, null, 2));
  });

  // ── Webhook endpoint management (dashboard) ─────────────────────────────────
  router.post('/v1/webhooks', async ({ req, body, send }) => {
    const s = requireSession(req); requireRole(s, 'admin');
    const { url, events } = body || {};
    if (!url) throw httpError(400, 'invalid', 'url required');
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const id = await repo.createWebhookEndpoint(s.orgId, url, secret, events || undefined);
    send(201, { endpoint_id: id, secret, note: 'use this secret to verify CG-Signature headers' });
  });
  router.get('/v1/webhooks', async ({ req, send }) => {
    const s = requireSession(req);
    const eps = await repo.listWebhookEndpoints(s.orgId);
    send(200, { endpoints: eps.map((e) => ({ endpoint_id: e.endpoint_id, url: e.url, events: asJson(e.events, []), active: toBool(e.active) })) });
  });
  router.get('/v1/webhooks/dead-letters', async ({ req, send }) => {
    const s = requireSession(req);
    send(200, { dead_letters: await repo.listDeadLetters(s.orgId) });
  });
}

// ── Row mappers ───────────────────────────────────────────────────────────────
function rowToArtifact(row) {
  return {
    content_hash: row.content_hash,
    key_id: row.key_id,
    algorithm: row.algorithm,
    signature: row.signature,
    body: {
      schema_version: row.schema_version || '1.0.0',
      artifact_id: row.artifact_id,
      org_id: row.org_id,
      id_hash: row.id_hash,
      action: row.action,
      channel: row.channel,
      purposes: asJson(row.purposes, {}),
      interaction_events: asJson(row.interaction_events, []),
      locale: row.locale,
      template_hash: row.template_hash,
      variable_payload_hash: row.variable_payload_hash,
      notice_version_hash: row.notice_version_hash,
      is_minor: toBool(row.is_minor),
      guardian_verification: asJson(row.guardian_verification, null),
      migrated: toBool(row.migrated),
      pre_existing_consent_date: row.pre_existing_consent_date,
      expires_at: row.expires_at,
      prev_hash: row.prev_hash,
      created_at: row.created_at,
    },
  };
}

function rowToPublic(row) {
  const a = rowToArtifact(row);
  return publicView(a);
}

function toCsv(items) {
  if (!items.length) return 'artifact_id,action,locale,created_at,content_hash\n';
  const cols = ['artifact_id', 'action', 'channel', 'locale', 'notice_version_hash', 'is_minor', 'created_at', 'content_hash', 'key_id', 'id_hash'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = cols.join(',');
  const rows = items.map((it) => cols.map((c) => esc(it[c])).join(','));
  return [head, ...rows].join('\n') + '\n';
}
