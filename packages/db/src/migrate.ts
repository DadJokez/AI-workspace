/**
 * Apply Drizzle migrations.
 * Usage: `pnpm --filter @ai-workspace/db db:migrate`
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { applyMigrations } from "./apply-migrations";
import { createDb } from "./client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");

  // max 1: the timeouts applyMigrations SETs and the migration transaction
  // must share one connection.
  const db = createDb({ url, max: 1 });
  await applyMigrations(db, path.resolve(__dirname, "..", "drizzle"));
  console.log("migrations applied");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
