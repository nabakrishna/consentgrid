// src/db/adapters/sqlite.js
// Built-in node:sqlite adapter (Node >= 22.5, --experimental-sqlite).
// Zero external dependencies — this is what makes the slice runnable and
// testable in registry-restricted environments.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class SqliteAdapter {
  dialect = 'sqlite';
  #db;

  constructor(file) {
    if (file !== ':memory:') {
      const dir = path.dirname(file);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    }
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
  }

  placeholder(_i) { return '?'; }

  exec(sql) { this.#db.exec(sql); }

  get(sql, params = []) { return this.#db.prepare(sql).get(...params); }

  all(sql, params = []) { return this.#db.prepare(sql).all(...params); }

  run(sql, params = []) {
    const info = this.#db.prepare(sql).run(...params);
    return { changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid };
  }

  /** Synchronous transaction. Throwing rolls back. */
  tx(fn) {
    this.#db.exec('BEGIN');
    try {
      const r = fn(this);
      this.#db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  close() { this.#db.close(); }
}
