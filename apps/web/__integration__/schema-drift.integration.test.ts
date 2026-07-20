import { describe, expect, it } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createDb } from "@ai-workspace/db";
import * as dbSchema from "@ai-workspace/db/schema";

/**
 * Schema-drift gate (#449 compensating control): drizzle meta snapshots are
 * deliberately frozen while migrations are handwritten SQL, so NOTHING else
 * verifies that `packages/db/src/schema.ts` and the applied migrations agree
 * until prod runtime. This suite introspects the freshly-migrated integration
 * database and asserts parity in BOTH directions:
 *
 *   - every drizzle table / column / index exists in Postgres, and
 *   - every public-schema table / column / index exists in the drizzle schema
 *     (allowlisting drizzle's own migrations bookkeeping table).
 *
 * Precision over breadth: tables, columns, column nullability, column types
 * (exact — today's schema uses only types where drizzle's getSQLType() and
 * information_schema agree verbatim), index existence + uniqueness + column
 * lists, and primary keys. Each spec collects every mismatch into a list and
 * asserts it empty, so a failure prints the full drift, not just the first.
 */

const DB_URL = process.env.DATABASE_URL;

/** Tables Postgres owns that the drizzle schema intentionally omits. */
const PG_TABLE_ALLOWLIST = new Set(["__drizzle_migrations"]);

interface DrizzleTableMeta {
  columns: Map<string, { notNull: boolean; sqlType: string }>;
  /** Declared indexes and unique constraints, keyed by index name. */
  indexes: Map<string, { unique: boolean; cols: string[] }>;
  pkCols: string[];
}

/**
 * Index entries are either columns or SQL expressions; this repo's only
 * expression form is `sql\`${t.col} DESC\``, whose column rides inside the SQL
 * query chunks (index ordering does not show up in pg_index's column list, so
 * the bare column name is the right comparison key). Duck-typed rather than
 * instanceof because the workspace can resolve more than one drizzle-orm
 * module instance.
 */
function indexedColumnName(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") return name;
    const chunks = (entry as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        const chunkName =
          chunk && typeof chunk === "object"
            ? (chunk as { name?: unknown }).name
            : undefined;
        if (typeof chunkName === "string") return chunkName;
      }
    }
  }
  return "<expression>";
}

function loadDrizzleSchema(): Map<string, DrizzleTableMeta> {
  const tables = Object.values(dbSchema as Record<string, unknown>).filter(
    (value): value is PgTable => value instanceof PgTable,
  );
  const byName = new Map<string, DrizzleTableMeta>();
  for (const table of tables) {
    const cfg = getTableConfig(table);
    const columns = new Map(
      cfg.columns.map((c) => [
        c.name,
        { notNull: c.notNull, sqlType: c.getSQLType() },
      ]),
    );
    const indexes = new Map<string, { unique: boolean; cols: string[] }>();
    for (const idx of cfg.indexes) {
      indexes.set(idx.config.name ?? "<unnamed>", {
        unique: idx.config.unique,
        cols: idx.config.columns.map(indexedColumnName),
      });
    }
    for (const unique of cfg.uniqueConstraints) {
      indexes.set(unique.name ?? "<unnamed>", {
        unique: true,
        cols: unique.columns.map((c) => c.name),
      });
    }
    const pkCols = cfg.columns.filter((c) => c.primary).map((c) => c.name);
    for (const pk of cfg.primaryKeys) {
      pkCols.push(...pk.columns.map((c) => c.name));
    }
    byName.set(cfg.name, { columns, indexes, pkCols });
  }
  return byName;
}

interface PgColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
  data_type: string;
  udt_name: string;
}

interface PgIndexRow {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  cols: string;
}

/** information_schema spells enums "USER-DEFINED"; drizzle spells the enum name. */
function normalizePgType(row: PgColumnRow): string {
  return row.data_type === "USER-DEFINED" ? row.udt_name : row.data_type;
}

const suite = describe.skipIf(!DB_URL);

suite("schema drift gate (drizzle schema.ts <-> migrated Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });
  const drizzle = loadDrizzleSchema();

  async function pgTables(): Promise<string[]> {
    const rows = (await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `)) as unknown as Array<{ table_name: string }>;
    return rows
      .map((r) => r.table_name)
      .filter((name) => !PG_TABLE_ALLOWLIST.has(name));
  }

  async function pgColumns(): Promise<PgColumnRow[]> {
    return (await db.execute(sql`
      select table_name, column_name, is_nullable, data_type, udt_name
      from information_schema.columns
      where table_schema = 'public'
    `)) as unknown as PgColumnRow[];
  }

  async function pgIndexes(): Promise<PgIndexRow[]> {
    return (await db.execute(sql`
      select
        t.relname as table_name,
        i.relname as index_name,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary,
        string_agg(a.attname, ',' order by k.ord) as cols
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      cross join lateral unnest(ix.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      where n.nspname = 'public'
      group by t.relname, i.relname, ix.indisunique, ix.indisprimary
    `)) as unknown as PgIndexRow[];
  }

  it("tables match in both directions", async () => {
    const actual = await pgTables();
    const drift: string[] = [];
    for (const name of drizzle.keys()) {
      if (!actual.includes(name)) {
        drift.push(`drizzle table "${name}" is missing from Postgres`);
      }
    }
    for (const name of actual) {
      if (!drizzle.has(name)) {
        drift.push(`Postgres table "${name}" is not declared in schema.ts`);
      }
    }
    expect(drift).toEqual([]);
    expect(drizzle.size).toBeGreaterThan(0);
  });

  it("columns exist in both directions", async () => {
    const actual = await pgColumns();
    const drift: string[] = [];
    for (const [tableName, meta] of drizzle) {
      const actualCols = actual.filter((r) => r.table_name === tableName);
      for (const colName of meta.columns.keys()) {
        if (!actualCols.some((r) => r.column_name === colName)) {
          drift.push(`drizzle column ${tableName}.${colName} is missing from Postgres`);
        }
      }
      for (const row of actualCols) {
        if (!meta.columns.has(row.column_name)) {
          drift.push(
            `Postgres column ${tableName}.${row.column_name} is not declared in schema.ts`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("column nullability matches", async () => {
    const actual = await pgColumns();
    const drift: string[] = [];
    for (const [tableName, meta] of drizzle) {
      for (const [colName, col] of meta.columns) {
        const row = actual.find(
          (r) => r.table_name === tableName && r.column_name === colName,
        );
        if (!row) continue; // reported by the existence spec
        const pgNotNull = row.is_nullable === "NO";
        if (pgNotNull !== col.notNull) {
          drift.push(
            `${tableName}.${colName}: drizzle notNull=${col.notNull}, Postgres notNull=${pgNotNull}`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("column types match", async () => {
    const actual = await pgColumns();
    const drift: string[] = [];
    for (const [tableName, meta] of drizzle) {
      for (const [colName, col] of meta.columns) {
        const row = actual.find(
          (r) => r.table_name === tableName && r.column_name === colName,
        );
        if (!row) continue; // reported by the existence spec
        const pgType = normalizePgType(row);
        if (pgType !== col.sqlType) {
          drift.push(
            `${tableName}.${colName}: drizzle type "${col.sqlType}", Postgres type "${pgType}"`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("indexes match in both directions, including uniqueness and column lists", async () => {
    const actual = await pgIndexes();
    const drift: string[] = [];
    for (const [tableName, meta] of drizzle) {
      const actualIdx = actual.filter(
        (r) => r.table_name === tableName && !r.is_primary,
      );
      for (const [indexName, idx] of meta.indexes) {
        const row = actualIdx.find((r) => r.index_name === indexName);
        if (!row) {
          drift.push(`drizzle index ${tableName}.${indexName} is missing from Postgres`);
          continue;
        }
        if (row.is_unique !== idx.unique) {
          drift.push(
            `${tableName}.${indexName}: drizzle unique=${idx.unique}, Postgres unique=${row.is_unique}`,
          );
        }
        if (row.cols !== idx.cols.join(",")) {
          drift.push(
            `${tableName}.${indexName}: drizzle columns (${idx.cols.join(",")}), Postgres columns (${row.cols})`,
          );
        }
      }
      for (const row of actualIdx) {
        if (!meta.indexes.has(row.index_name)) {
          drift.push(
            `Postgres index ${tableName}.${row.index_name} is not declared in schema.ts`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("primary keys match", async () => {
    const actual = await pgIndexes();
    const drift: string[] = [];
    for (const [tableName, meta] of drizzle) {
      const pkRow = actual.find((r) => r.table_name === tableName && r.is_primary);
      const dzPk = meta.pkCols.join(",");
      if ((pkRow?.cols ?? "") !== dzPk) {
        drift.push(
          `${tableName}: drizzle pk (${dzPk}), Postgres pk (${pkRow?.cols ?? "<none>"})`,
        );
      }
    }
    expect(drift).toEqual([]);
  });
});
