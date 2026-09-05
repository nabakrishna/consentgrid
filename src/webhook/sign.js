// src/webhook/sign.js
// Standardized webhook signing. Clients verify authenticity with the shared
// per-endpoint secret. Signature scheme mirrors common providers:
//   CG-Signature: t=<unixSeconds>,v1=<hex hmac_sha256(secret, `${t}.${body}`)>
import crypto from 'node:crypto';

export function signWebhook(secret, body, t = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { header: `t=${t},v1=${mac}`, t, v1: mac };
}

export function verifyWebhook(secret, body, header, toleranceSec = 300) {
  try {
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
    const t = parseInt(parts.t, 10);
    if (!Number.isFinite(t)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const a = Buffer.from(parts.v1 || '', 'hex'); const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
