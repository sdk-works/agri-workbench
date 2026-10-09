import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// One indexed table per lifecycle. JSON bodies are versioned; credentials never enter exports.
export const kinds = [
  "users",
  "sessions",
  "conversations",
  "turns",
  "feedback",
  "jobs",
  "reviews",
  "documents",
  "exports",
  "settings",
  "events",
  "review_versions",
  "document_versions",
];
export async function openRepository({ filename, databaseUrl }) {
  const pool = databaseUrl
    ? new pg.Pool({ connectionString: databaseUrl, max: 5 })
    : null;
  if (!pool) fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = pool ? null : new DatabaseSync(filename);
  if (sqlite)
    sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
  const query = async (sql, args = [], client = pool) =>
    pool
      ? (await client.query(sql, args)).rows
      : sqlite.prepare(sql.replace(/\$\d+/g, "?")).all(...args);
  const execute = async (sql, args = [], client = pool) =>
    pool
      ? client.query(sql, args)
      : sqlite.prepare(sql.replace(/\$\d+/g, "?")).run(...args);
  for (const kind of kinds) {
    await execute(
      `CREATE TABLE IF NOT EXISTS wb_${kind} (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, domain TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL)`,
    );
    await execute(
      `CREATE INDEX IF NOT EXISTS wb_${kind}_scope ON wb_${kind}(tenant,owner,domain,status)`,
    );
  }
  function api(client) {
    const table = (k) => {
      if (!kinds.includes(k)) throw Error("Invalid repository kind");
      return `wb_${k}`;
    };
    return {
      async get(k, id) {
        const rows = await query(
          `SELECT body FROM ${table(k)} WHERE id=$1`,
          [id],
          client,
        );
        return rows[0] ? JSON.parse(rows[0].body) : null;
      },
      async list(k, filters = {}) {
        const entries = Object.entries(filters);
        if (
          entries.some(
            ([key]) => !["tenant", "owner", "domain", "status"].includes(key),
          )
        )
          throw Error("Invalid filter");
        const where = entries.length
          ? " WHERE " +
            entries.map(([key], i) => `${key}=$${i + 1}`).join(" AND ")
          : "";
        return (
          await query(
            `SELECT body FROM ${table(k)}${where} ORDER BY created_at DESC,id DESC`,
            entries.map(([, v]) => v),
            client,
          )
        ).map((r) => JSON.parse(r.body));
      },
      async put(k, r) {
        await execute(
          `INSERT INTO ${table(k)}(id,tenant,owner,domain,status,created_at,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant,owner=excluded.owner,domain=excluded.domain,status=excluded.status,body=excluded.body`,
          [
            r.id,
            r.tenant || "park",
            r.owner || "",
            r.domain || "",
            r.status || "",
            r.created_at || new Date().toISOString(),
            JSON.stringify(r),
          ],
          client,
        );
        return r;
      },
      async remove(k, id) {
        await execute(`DELETE FROM ${table(k)} WHERE id=$1`, [id], client);
      },
    };
  }
  let tail = Promise.resolve();
  const repo = {
    ...api(pool),
    type: pool ? "postgresql" : "sqlite",
    transaction(fn) {
      const run = tail.then(async () => {
        const client = pool ? await pool.connect() : null;
        try {
          if (pool) {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(487321)");
          } else sqlite.exec("BEGIN IMMEDIATE");
          const out = await fn(api(client));
          if (pool) await client.query("COMMIT");
          else sqlite.exec("COMMIT");
          return out;
        } catch (e) {
          if (pool) await client.query("ROLLBACK");
          else sqlite.exec("ROLLBACK");
          throw e;
        } finally {
          client?.release();
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    async backup(target) {
      if (pool) throw Error("PostgreSQL 请使用 pg_dump");
      await tail;
      await backup(sqlite, target);
    },
    async close() {
      await tail;
      if (pool) await pool.end();
      else sqlite.close();
    },
  };
  return repo;
}
