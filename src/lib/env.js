// src/lib/env.js
// Minimal, dependency-free .env loader. Deliberately tiny — we do not want a
// runtime dependency, and we never override variables that are already set in
// the real environment (so container/orchestrator config always wins).
//
// It is intentionally NOT called from buildServer(): the test harness passes an
// explicit env object, and we must not let a stray .env file leak into tests.
// Call loadDotenv() only from CLI entrypoints (server start, seed, scripts).

import fs from 'node:fs';
import path from 'node:path';

/**
 * Load KEY=VALUE pairs from a .env file into process.env, without overriding
 * anything already present. Silently no-ops if the file is missing.
 * @param {string} [file] path to the env file (default: ./.env in cwd)
 * @returns {string[]} the names of the keys that were applied
 */
export function loadDotenv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return [];
  const applied = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // never override real env
    let val = line.slice(eq + 1).trim();
    // Strip a single layer of matching quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    applied.push(key);
  }
  return applied;
}
