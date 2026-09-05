// src/api/auth.js
// Authentication helpers: API-key auth (server-to-server) and a minimal
// session cookie for the dashboard. [MUST-V1] RBAC seam via roles.

import crypto from 'node:crypto';
import { httpError } from './http.js';
import { verifyPassword } from '../lib/password.js';

// ── Dashboard sessions (stateless HMAC cookie) ──────────────────────────────
const SESSION_TTL_MS = 8 * 3600 * 1000;

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.WEBHOOK_SIGNING_SECRET || 'dev-session-secret';
}

export function issueSession(orgId, role = 'owner') {
  const payload = Buffer.from(JSON.stringify({ orgId, role, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Require a valid dashboard session; returns {orgId, role}. */
export function requireSession(req) {
  const data = verifySession(readCookie(req, 'cg_session'));
  if (!data) throw httpError(401, 'unauthorized', 'login required');
  return data;
}

/** Require a valid API key; returns the api_keys row (incl. org_id). */
export async function requireApiKey(req, repo) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const key = bearer || req.headers['x-api-key'];
  if (!key) throw httpError(401, 'missing_api_key', 'provide Authorization: Bearer <key> or X-API-Key');
  const row = await repo.findApiKey(key);
  if (!row) throw httpError(401, 'invalid_api_key', 'unknown or revoked API key');
  return row;
}

export async function authenticateOrg(repo, email, password) {
  const org = await repo.getOrgByEmail(email);
  if (!org) return null;
  if (!verifyPassword(password, org.password_hash)) return null;
  return org;
}

// ── RBAC ────────────────────────────────────────────────────────────────────
const ROLE_RANK = { support: 1, viewer: 2, admin: 3, owner: 4 };
export function requireRole(session, minRole) {
  if ((ROLE_RANK[session.role] || 0) < (ROLE_RANK[minRole] || 99)) {
    throw httpError(403, 'forbidden', `requires role >= ${minRole}`);
  }
}
