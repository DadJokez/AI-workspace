import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { createDb, mcpServers } from "@ai-workspace/db";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "INTEGRATION_DATABASE_URL is required in CI for the endpoint URL migration test",
  );
}

const MIGRATION_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../../packages/db/drizzle/0053_relative_mcp_endpoint_urls.sql",
  ),
  "utf8",
);
const SEEDED_ORIGIN = "https://comparative.builtwithrobot.link";
const FIRST_PARTY = ["google", "salesforce", "notion"];
const BYSTANDER = "wp02-bystander";
const SLUGS = [...FIRST_PARTY, BYSTANDER];

const suite = describe.skipIf(!DB_URL);

suite("0053 relative MCP endpoint URLs", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });

  // The integration database is already migrated, so put the rows back the way
  // 0032/0035/0040 seeded them and replay the migration's SQL.
  beforeEach(async () => {
    for (const slug of FIRST_PARTY) {
      await db
        .update(mcpServers)
        .set({ endpointUrl: `${SEEDED_ORIGIN}/api/mcp/${slug}` })
        .where(sql`${mcpServers.slug} = ${slug}`);
    }
    await db
      .insert(mcpServers)
      .values({
        slug: BYSTANDER,
        displayName: "Bystander",
        transport: "http",
        endpointUrl: `${SEEDED_ORIGIN}/api/mcp/bystander`,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(mcpServers).where(sql`${mcpServers.slug} = ${BYSTANDER}`);
    await db.execute(sql.raw(MIGRATION_SQL));
  });

  async function endpoints() {
    const rows = await db
      .select({
        slug: mcpServers.slug,
        endpointUrl: mcpServers.endpointUrl,
        updatedAt: mcpServers.updatedAt,
      })
      .from(mcpServers)
      .where(inArray(mcpServers.slug, SLUGS));
    return new Map(rows.map((row) => [row.slug, row]));
  }

  it("rewrites only the three seeded first-party rows", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));

    const rows = await endpoints();
    for (const slug of FIRST_PARTY) {
      expect(rows.get(slug)?.endpointUrl).toBe(`/api/mcp/${slug}`);
    }
    expect(rows.get(BYSTANDER)?.endpointUrl).toBe(
      `${SEEDED_ORIGIN}/api/mcp/bystander`,
    );
  });

  it("leaves an operator-set endpoint alone", async () => {
    await db
      .update(mcpServers)
      .set({ endpointUrl: "https://notion-mcp.example/mcp" })
      .where(sql`${mcpServers.slug} = 'notion'`);

    await db.execute(sql.raw(MIGRATION_SQL));

    expect((await endpoints()).get("notion")?.endpointUrl).toBe(
      "https://notion-mcp.example/mcp",
    );
  });

  it("is idempotent", async () => {
    await db.execute(sql.raw(MIGRATION_SQL));
    const first = await endpoints();
    await db.execute(sql.raw(MIGRATION_SQL));
    const second = await endpoints();

    for (const slug of SLUGS) {
      expect(second.get(slug)?.endpointUrl).toBe(first.get(slug)?.endpointUrl);
      expect(second.get(slug)?.updatedAt).toEqual(first.get(slug)?.updatedAt);
    }
  });
});
