import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  LOCK_TIMEOUT,
  MigrationTimeoutError,
  STATEMENT_TIMEOUT,
} from "./apply-migrations";
import type { Database } from "./client";

vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: vi.fn() }));

function fakeDb(log: string[]): Database {
  return {
    execute: vi.fn(async (query: string) => {
      log.push(query);
      return [];
    }),
  } as unknown as Database;
}

const STATEMENT = 'ALTER TABLE "widgets" ADD COLUMN "color" text';

/** A one-migration folder in the exact shape drizzle reads. */
function fixtureFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migrate-timeout-"));
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: 1, tag: "0000_widgets", breakpoints: true }],
    }),
  );
  writeFileSync(
    path.join(folder, "0000_widgets.sql"),
    `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY);--> statement-breakpoint\n${STATEMENT};`,
  );
  return folder;
}

/** The shape drizzle 0.45 actually throws: DrizzleQueryError { query, cause: PostgresError { code, query } }. */
function drizzleQueryError(code: string, query: string) {
  const cause = Object.assign(new Error(`canceling statement (${code})`), { code, query });
  return Object.assign(new Error(`Failed query: ${query}`), { query, cause });
}

/** A bare postgres-js error, as seen when the driver call is not wrapped. */
function postgresError(code: string, query: string) {
  return Object.assign(new Error(`canceling statement (${code})`), { code, query });
}

describe("applyMigrations (#898)", () => {
  afterEach(() => {
    vi.mocked(migrate).mockReset();
    delete process.env.MIGRATE_LOCK_TIMEOUT;
    delete process.env.MIGRATE_STATEMENT_TIMEOUT;
  });

  it("issues lock_timeout and statement_timeout on the connection before migrate()", async () => {
    const log: string[] = [];
    vi.mocked(migrate).mockImplementation(async () => {
      log.push("migrate");
    });
    await applyMigrations(fakeDb(log), "/nonexistent");
    expect(log).toEqual([
      "SET lock_timeout = '10s'",
      "SET statement_timeout = '5min'",
      "migrate",
    ]);
    expect(LOCK_TIMEOUT).toBe("10s");
    expect(STATEMENT_TIMEOUT).toBe("5min");
  });

  it("honours the env overrides, for tests only", async () => {
    process.env.MIGRATE_LOCK_TIMEOUT = "1s";
    process.env.MIGRATE_STATEMENT_TIMEOUT = "30s";
    const log: string[] = [];
    await applyMigrations(fakeDb(log), "/nonexistent");
    expect(log).toEqual(["SET lock_timeout = '1s'", "SET statement_timeout = '30s'"]);
  });

  it("refuses a malformed override before touching the database", async () => {
    process.env.MIGRATE_LOCK_TIMEOUT = "10s; DROP TABLE users";
    const log: string[] = [];
    await expect(applyMigrations(fakeDb(log), "/nonexistent")).rejects.toThrow(
      /MIGRATE_LOCK_TIMEOUT must be a Postgres duration/,
    );
    expect(log).toEqual([]);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("names the lock timeout and the migration tag through drizzle's error wrapper", async () => {
    const folder = fixtureFolder();
    // drizzle runs each `--> statement-breakpoint` chunk verbatim, trailing `;` included.
    vi.mocked(migrate).mockRejectedValue(drizzleQueryError("55P03", `\n${STATEMENT};`));
    const failure = applyMigrations(fakeDb([]), folder);
    await expect(failure).rejects.toBeInstanceOf(MigrationTimeoutError);
    await expect(failure).rejects.toThrow(
      "lock_timeout (10s) fired while applying migration 0000_widgets; the migration transaction rolled back, so nothing was applied",
    );
  });

  it("reads the SQLSTATE off a bare driver error too", async () => {
    const folder = fixtureFolder();
    vi.mocked(migrate).mockRejectedValue(postgresError("55P03", `\n${STATEMENT};`));
    await expect(applyMigrations(fakeDb([]), folder)).rejects.toThrow(
      /lock_timeout \(10s\) fired while applying migration 0000_widgets/,
    );
  });

  it("names the statement timeout, and says so when the statement is in no journaled file", async () => {
    const folder = fixtureFolder();
    vi.mocked(migrate).mockRejectedValue(
      postgresError("57014", "CREATE SCHEMA IF NOT EXISTS drizzle"),
    );
    await expect(applyMigrations(fakeDb([]), folder)).rejects.toThrow(
      /statement_timeout \(5min\) fired while applying migration \(unknown — the failing statement is not in any journaled file\)/,
    );
  });

  it("rethrows every other failure untouched", async () => {
    const boom = Object.assign(new Error("relation already exists"), { code: "42P07" });
    vi.mocked(migrate).mockRejectedValue(boom);
    await expect(applyMigrations(fakeDb([]), "/nonexistent")).rejects.toBe(boom);
  });
});
