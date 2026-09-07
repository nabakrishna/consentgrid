// tests/helpers.js
// Shared test harness: boots an in-memory server on an ephemeral port and
// returns a small typed client that threads the dashboard session cookie.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';

export async function startTestServer(extraEnv = {}) {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-keys-'));
  const env = {
    ...process.env,
    DATABASE_URL: 'sqlite://:memory:',
    SERVER_HMAC_PEPPER: 'test-pepper',
    WEBHOOK_SIGNING_SECRET: 'test-webhook-secret',
    SESSION_SECRET: 'test-session-secret',
    KMS_PROVIDER: 'local',
    KMS_LOCAL_DIR: keyDir,
    NODE_ENV: 'test',
    ...extraEnv,
  };
  let lastOtp = null;
  const built = await buildServer(env, { otpSink: (o) => { lastOtp = o; } });
  const server = built.router.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let cookie = '';
  async function req(method, pathname, { body, apiKey, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    if (cookie) headers['cookie'] = cookie;
    const res = await fetch(base + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    if (raw) return { status: res.status, text: await res.text(), res };
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  return {
    base,
    req,
    setCookie: (c) => { cookie = c; },
    lastOtp: () => lastOtp,
    close: () => new Promise((r) => server.close(r)),
    built,
  };
}

/** Convenience: full path from signup -> approved Hindi notice. */
export async function seedApprovedOrg(h) {
  const signup = await h.req('POST', '/v1/orgs', { body: { name: 'Test Co', email: `t${Math.random().toString(36).slice(2)}@x.com`, password: 'password123' } });
  h.setCookie('cg_session=' + encodeURIComponent(signup.json.session));
  const apiKey = signup.json.api_key;
  const orgId = signup.json.org_id;
  const tpl = await h.req('POST', '/v1/templates', { body: { name: 'Signup', purposes: ['marketing', 'analytics'] } });
  const ver = await h.req('POST', `/v1/templates/${tpl.json.template_id}/versions`, { body: { template_boilerplate: 'Legal text v1', variable_payload: {} } });
  const vid = ver.json.version_id;
  const nvh = ver.json.notice_version_hash;
  await h.req('POST', `/v1/versions/${vid}/locales`, { body: { locale: 'hi', title: 'सूचना', body_html: '<p>...</p>' } });
  await h.req('POST', `/v1/versions/${vid}/locales/hi/approve`, {});
  return { orgId, apiKey, versionId: vid, noticeVersionHash: nvh };
}
