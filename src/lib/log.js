// src/lib/log.js — [MUST-V1] structured logging (JSON lines to stdout).
// No PII is ever logged: we log id_hash prefixes and org_ids, never tokens.

function emit(level, msg, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
  // request-scoped child with a correlation id
  child: (base) => ({
    info: (msg, f) => emit('info', msg, { ...base, ...f }),
    warn: (msg, f) => emit('warn', msg, { ...base, ...f }),
    error: (msg, f) => emit('error', msg, { ...base, ...f }),
  }),
};
