// src/lib/ids.js — id + time helpers shared across backends.
import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Booleans are stored as 0/1 in sqlite, native bool in pg. Normalize on read. */
export const toBool = (v) => v === true || v === 1 || v === '1' || v === 't';

/** JSON columns: sqlite stores TEXT, pg stores jsonb (driver returns objects). */
export const asJson = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

/** Serialize a value destined for a JSON column (both backends accept a string). */
export const jsonParam = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
