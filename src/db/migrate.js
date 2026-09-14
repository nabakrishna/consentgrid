// src/db/migrate.js
// Applies the schema for the active backend. Idempotent-ish: it checks for a
// sentinel table first. For production migrations at scale, replace with a
// versioned migration tool; this is deliberately minimal for the MVP.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');

export async function migrate(db) {
  const already = await db.get(
    db.dialect === 'postgres'
      ? "SELECT to_regclass('public.orgs') AS t"
      : "SELECT name AS t FROM sqlite_master WHERE type='table' AND name='orgs'"
  );
  if (already && already.t) return { applied: false, reason: 'schema already present' };

  const file = db.dialect === 'postgres' ? '001_init.postgres.sql' : '001_init.sqlite.sql';
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  await db.exec(sql);
  return { applied: true, file };
}

// CLI entrypoint
// if (import.meta.url === `file://${process.argv[1]}`) { --> error on Node 20.3.0, see
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openDatabase();
  const r = await migrate(db);
  console.log(JSON.stringify({ backend: db.dialect, ...r }));
  if (db.close) await db.close();
}
