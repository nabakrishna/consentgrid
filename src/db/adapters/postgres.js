// src/db/adapters/postgres.js
// ─────────────────────────────────────────────────────────────────────────
// PRODUCTION adapter. Requires the `pg` package:  npm i pg
//
// It is intentionally NOT imported unless DATABASE_URL is a postgres:// URL,
// so the SQLite dev/test path has zero external dependencies. This file is
// written against pg's stable API; drop `pg` into node_modules on a machine
// with registry access and it runs unchanged.
//
// Same surface as SqliteAdapter, but async. App code uses `await db.get(...)`
// etc. The SQLite adapter's sync methods are await-compatible (awaiting a
// non-promise is a no-op), so a single code path serves both.
//
// Placeholders: pg uses $1,$2,... — placeholder(i) returns `$${i}`.
// Query builders always thread params in order, so this is transparent.
// ─────────────────────────────────────────────────────────────────────────

export class PostgresAdapter {
  dialect = 'postgres';
  #pool;
  #client; // set inside a tx

  constructor(pool) { this.#pool = pool; }

  static async connect(url) {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        "DATABASE_URL is postgres:// but the 'pg' package is not installed. " +
        "Run `npm i pg` (needs registry access), or use a sqlite:// URL for local dev."
      );
    }
    const { Pool } = pg.default ?? pg;
    const pool = new Pool({ connectionString: url, max: 10 });
    // Fail fast on bad config.
    const c = await pool.connect(); c.release();
    return new PostgresAdapter(pool);
  }

  placeholder(i) { return `$${i}`; }

  #exec(text, params) {
    return (this.#client ?? this.#pool).query(text, params);
  }

  async exec(sql) { await this.#exec(sql); }

  async get(sql, params = []) {
    const r = await this.#exec(sql, params);
    return r.rows[0];
  }

  async all(sql, params = []) {
    const r = await this.#exec(sql, params);
    return r.rows;
  }

  async run(sql, params = []) {
    const r = await this.#exec(sql, params);
    return { changes: r.rowCount };
  }

  async tx(fn) {
    const client = await this.#pool.connect();
    const scoped = new PostgresAdapter(this.#pool);
    scoped.#client = client;
    try {
      await client.query('BEGIN');
      const r = await fn(scoped);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async close() { await this.#pool.end(); }
}
