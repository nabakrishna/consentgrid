// src/db/seed.js
// ─────────────────────────────────────────────────────────────────────────
// Seeds a demo tenant so the dashboard, widget demo, and public verifier all
// have something to show on first run. Idempotent-ish: if the demo org already
// exists it is reused, and a fresh API key is minted (raw keys are shown once).
//
//   npm run seed                 # against DATABASE_URL (default: sqlite file)
//
// Everything goes through the same Repo + ConsentService the API uses, so the
// seeded artifacts are real: signed, hash-chained, and guard-checked (explicit
// language confirmation + no pre-ticked purposes). No raw PII is stored.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { loadDotenv } from '../lib/env.js';
import { openDatabase } from './index.js';
import { migrate } from './migrate.js';
import { Repo } from './repo.js';
import { createKeyManager } from '../crypto/kms.js';
import { ConsentService } from '../api/consent-service.js';
import { makeEnqueue } from '../webhook/dispatcher.js';
import { hashPassword } from '../lib/password.js';
import { sha256hex } from '../lib/ids.js';

const DEMO = {
  name: 'Acme Retail (demo)',
  email: 'demo@consentgrid.local',
  password: 'demo-password-123',
  purposes: ['marketing', 'analytics', 'personalization'],
  boilerplate:
    'ConsentGrid demo notice. We process your personal data only for the purposes you ' +
    'explicitly turn on below. You may withdraw consent at any time; withdrawal is as ' +
    'easy as granting. This is sample legal text for demonstration only.',
  locales: [
    { locale: 'en', title: 'Your data, your choice', body_html: '<p>Choose how Acme Retail may use your data. Nothing is pre-selected.</p>' },
    { locale: 'hi', title: 'आपका डेटा, आपकी पसंद', body_html: '<p>चुनें कि Acme Retail आपके डेटा का उपयोग कैसे कर सकता है। कुछ भी पहले से चयनित नहीं है।</p>' },
  ],
};

function line(label, value) { console.log(`  ${label.padEnd(16)} ${value}`); }

async function main() {
  loadDotenv();
  const db = await openDatabase(process.env.DATABASE_URL);
  const m = await migrate(db);
  const repo = new Repo(db);
  const km = createKeyManager(process.env);
  const enqueue = makeEnqueue(repo);
  const consent = new ConsentService(repo, km, { webhookEnqueue: enqueue });

  console.log(`\nConsentGrid seed  (backend: ${db.dialect}, migrate: ${m.applied ? 'applied' : m.reason})\n`);

  // ── Org (reuse if present) ────────────────────────────────────────────────
  let org = await repo.getOrgByEmail(DEMO.email);
  let orgId;
  if (org) {
    orgId = org.org_id;
    console.log('Demo org already exists — reusing it and minting a fresh API key.');
  } else {
    orgId = await repo.createOrg({ name: DEMO.name, email: DEMO.email, passwordHash: hashPassword(DEMO.password) });
    try { const { ensureOrgPartition } = await import('./partitions.js'); await ensureOrgPartition(repo.db, orgId); } catch { /* sqlite no-op */ }
    console.log('Created demo org.');
  }

  // ── API key (shown once) ──────────────────────────────────────────────────
  const apiKey = `cg_live_${crypto.randomBytes(24).toString('base64url')}`;
  await repo.createApiKey(orgId, 'seed-key', apiKey);

  // ── Notice: template -> version -> locales -> approve ─────────────────────
  const templateId = await repo.createTemplate(orgId, 'Signup notice', DEMO.purposes);
  const version = await repo.createVersion(orgId, templateId, {
    templateHash: sha256hex(DEMO.boilerplate),
    variablePayload: { company: 'Acme Retail', data_retention_months: 24 },
  });
  for (const l of DEMO.locales) {
    await repo.addLocale(orgId, version.version_id, { locale: l.locale, title: l.title, bodyHtml: l.body_html });
    await repo.approveLocale(orgId, version.version_id, l.locale, 'seed');
  }

  // ── Webhook endpoint (points at a placeholder; run the worker to see DLQ) ──
  const whSecret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const endpointId = await repo.createWebhookEndpoint(
    orgId, 'https://example.com/consentgrid-hook', whSecret, ['consent.granted', 'consent.withdrawn', 'consent.erased'],
  );

  // ── A few real, signed sample artifacts so the log isn't empty ────────────
  const sample = async (userToken, locale, purposes, action = 'GRANT') => {
    const nvh = version.notice_version_hash;
    const events = [{ type: 'language_confirmed', locale }];
    for (const [pid, val] of Object.entries(purposes)) {
      if (val === true) events.push({ type: 'toggle', purpose_id: pid, value: true, ts: Date.now() });
    }
    return consent.record(orgId, {
      user_token: userToken, action, locale, purposes,
      notice_version_hash: nvh, interaction_events: events,
      notice_shown_to_submit_ms: 4200,
    });
  };
  const a1 = await sample('demo-user-anita', 'hi', { marketing: true, analytics: true, personalization: false });
  const a2 = await sample('demo-user-boris', 'en', { marketing: true, analytics: false, personalization: true });
  const a3 = await sample('demo-user-chandra', 'en', { marketing: false, analytics: true, personalization: false });
  // A withdrawal so the log shows a lifecycle + a webhook to deliver.
  await consent.record(orgId, {
    user_token: 'demo-user-anita', action: 'WITHDRAW', locale: 'hi',
    purposes: { marketing: false }, interaction_events: [{ type: 'toggle', purpose_id: 'marketing', value: false, ts: Date.now() }, { type: 'language_confirmed', locale: 'hi' }],
  });

  const chain = await (async () => {
    const rows = await repo.chainForOrg(orgId);
    const { verifyChain } = await import('../crypto/artifact.js');
    const artifacts = rows.map((row) => ({
      content_hash: row.content_hash, key_id: row.key_id, algorithm: row.algorithm, signature: row.signature,
      body: {
        schema_version: row.schema_version || '1.0.0', artifact_id: row.artifact_id, org_id: row.org_id,
        id_hash: row.id_hash, action: row.action, channel: row.channel,
        purposes: JSON.parse(row.purposes || '{}'), interaction_events: JSON.parse(row.interaction_events || '[]'),
        locale: row.locale, template_hash: row.template_hash, variable_payload_hash: row.variable_payload_hash,
        notice_version_hash: row.notice_version_hash, is_minor: !!row.is_minor,
        guardian_verification: row.guardian_verification ? JSON.parse(row.guardian_verification) : null,
        migrated: !!row.migrated, pre_existing_consent_date: row.pre_existing_consent_date,
        expires_at: row.expires_at, prev_hash: row.prev_hash, created_at: row.created_at,
      },
    }));
    return verifyChain(artifacts, km);
  })();

  console.log('\nSeed complete. Ledger integrity:', chain.ok ? 'OK ✓' : `BROKEN at ${chain.brokenAt}`);
  console.log('\n── Demo credentials (store the API key now; it is not shown again) ──');
  line('Dashboard URL', (process.env.PUBLIC_BASE_URL || 'http://localhost:8080') + '/');
  line('Login email', DEMO.email);
  line('Login password', DEMO.password);
  line('API key', apiKey);
  line('Org id', orgId);
  line('Webhook secret', whSecret);
  line('Sample artifacts', [a1.artifact_id, a2.artifact_id, a3.artifact_id].join(', '));
  console.log('\nTry the public verifier at /verify with one of the artifact ids above.');
  console.log('Run `npm run worker` to deliver the queued webhooks (they target example.com and will dead-letter — that exercises the DLQ).\n');

  if (db.close) await db.close();
}

main().catch((e) => { console.error('seed failed:', e); process.exit(1); });
