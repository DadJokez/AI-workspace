/**
 * Apply Drizzle migrations.
 * Usage: `pnpm --filter @ai-workspace/db db:migrate`
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "./client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");

  const db = createDb({ url, max: 1 });
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "..", "drizzle"),
  });
  console.log("migrations applied");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
