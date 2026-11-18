import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EGRESS_INVENTORY,
  egressAllowlist,
  renderEgressInventoryMarkdown,
} from "@/lib/egress-inventory";

/**
 * `pnpm egress:inventory` rewrites docs/security/EGRESS_INVENTORY.md, which
 * does not depend on this machine's environment. `--json` and `--allowlist`
 * print this environment's own rows and proxy lists instead.
 */
const DOC_PATH = fileURLToPath(
  new URL("../../../docs/security/EGRESS_INVENTORY.md", import.meta.url),
);

const flags = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = flags.filter(
  (flag) => flag !== "--json" && flag !== "--allowlist",
);
if (unknown.length > 0 || flags.length > 1) {
  console.error("Usage: pnpm egress:inventory [--json | --allowlist]");
  process.exit(1);
}

if (flags[0] === "--json") {
  console.log(JSON.stringify(EGRESS_INVENTORY, null, 2));
} else if (flags[0] === "--allowlist") {
  console.log(JSON.stringify(egressAllowlist(EGRESS_INVENTORY), null, 2));
} else {
  writeFileSync(DOC_PATH, renderEgressInventoryMarkdown());
  console.error(`Wrote ${DOC_PATH}`);
}
