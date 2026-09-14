// src/db/index.js
// ─────────────────────────────────────────────────────────────────────────
// Backend-agnostic database layer.
//
// DATABASE_URL selects the adapter:
//   sqlite://:memory:      -> in-memory (tests)
//   sqlite://./path.db     -> file-backed (local dev)
//   postgres://...         -> production Postgres (requires `pg`)
//
// Both adapters expose the same minimal surface:
//   db.exec(sql)                      run DDL / scripts
//   db.get(sql, params) -> row|undef
//   db.all(sql, params) -> row[]
//   db.run(sql, params) -> { changes }
//   db.tx(fn)                         run fn(db) in a transaction
//   db.placeholder(i)                 '?' (sqlite) or `$i` (pg)
//   db.dialect                        'sqlite' | 'postgres'
//
// Query builders in src/db/queries.js use db.placeholder() so app code is
// written once and runs on either backend.
// ─────────────────────────────────────────────────────────────────────────

import { SqliteAdapter } from './adapters/sqlite.js';

export async function openDatabase(url = process.env.DATABASE_URL || 'sqlite://:memory:') {
  if (url.startsWith('sqlite://')) {
    return new SqliteAdapter(url.slice('sqlite://'.length));
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    // Lazy import so environments without `pg` (or without registry access)
    // can still run the SQLite path and the full test suite.
    const { PostgresAdapter } = await import('./adapters/postgres.js');
    return PostgresAdapter.connect(url);
  }
  throw new Error(`unsupported DATABASE_URL scheme: ${url}`);
}
