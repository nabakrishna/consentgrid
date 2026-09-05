// src/lib/password.js — scrypt password hashing (stdlib, no deps).
import crypto from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 32;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [scheme, n, rr, pp, saltB64, dkB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(dkB64, 'base64');
    const dk = crypto.scryptSync(pw, salt, expected.length, { N: +n, r: +rr, p: +pp });
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
