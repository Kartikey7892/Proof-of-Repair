/**
 * PostgreSQL access.
 *
 * Production / dev: a real PostgreSQL server via `pg` (DATABASE_URL).
 * Zero-setup demos & tests: PGlite — the real Postgres engine compiled to WASM,
 * running in-process. Both speak identical SQL ($1 params, JSONB, CTEs, window
 * functions), so the rest of the code only sees the `Db` interface.
 */
import { mkdirSync } from "node:fs";
import pg from "pg";
import { MIGRATIONS } from "./schema.js";

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  readonly kind: "postgres" | "pglite";
  readonly label: string;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Return BIGINT/NUMERIC aggregates (COUNT, SUM) as JS numbers, not strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

class PgDb implements Db {
  readonly kind = "postgres" as const;
  readonly label: string;
  constructor(private pool: pg.Pool, url: string) {
    this.label = url.replace(/\/\/[^@]*@/, "//***@");
  }
  query<T>(sql: string, params?: unknown[]) {
    return this.pool.query(sql, params as any[]) as unknown as Promise<{ rows: T[] }>;
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ query: (s, p) => client.query(s, p as any[]) as any });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly kind = "pglite" as const;
  constructor(private db: any, readonly label: string) {}
  query<T>(sql: string, params?: unknown[]) {
    return this.db.query(sql, params) as Promise<{ rows: T[] }>;
  }
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction((tx: any) => fn({ query: (s, p) => tx.query(s, p) }));
  }
  close() {
    return this.db.close();
  }
}

export async function openDb(opts: { url?: string; pgliteDir?: string } = {}): Promise<Db> {
  let db: Db;
  if (opts.url) {
    db = new PgDb(new pg.Pool({ connectionString: opts.url, max: 10 }), opts.url);
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = opts.pgliteDir ?? "memory://";
    if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
    db = new PgliteDb(await PGlite.create(dir), `pglite:${dir}`);
  }
  await migrate(db);
  return db;
}

/** Forward-only, idempotent migrations tracked in schema_migrations. */
export async function migrate(db: Db): Promise<number> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const { rows } = await db.query<{ version: number }>("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => r.version));
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
    });
    applied++;
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}
