// src/crypto/canonical.js
// ─────────────────────────────────────────────────────────────────────────
// Deterministic JSON canonicalization (RFC 8785 / JCS-style subset).
//
// Signatures and hashes must be computed over a byte-stable representation,
// independent of key insertion order or whitespace. Two semantically-equal
// artifacts MUST serialize to identical bytes on any machine.
//
// Rules:
//   - object keys sorted lexicographically (by UTF-16 code unit, JS default)
//   - no insignificant whitespace
//   - numbers: only finite; integers preferred; no -0
//   - undefined values dropped; functions/symbols rejected
// ─────────────────────────────────────────────────────────────────────────

export function canonicalize(value) {
  return serialize(value);
}

function serialize(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number is not canonicalizable');
    if (Object.is(v, -0)) return '0';
    return String(v);
  }
  if (t === 'bigint') return v.toString();
  if (Array.isArray(v)) {
    return '[' + v.map((el) => serialize(el === undefined ? null : el)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(v[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize value of type ${t}`);
}
