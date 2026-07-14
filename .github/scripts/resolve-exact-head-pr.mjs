#!/usr/bin/env node

import { readFileSync } from "node:fs";

const sha = process.argv[2]?.trim();
if (!sha) {
  console.error("Usage: resolve-exact-head-pr.mjs <head-sha>");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  console.error(
    `Could not parse the open pull request response: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const pulls = Array.isArray(payload)
  ? payload.flatMap((page) => (Array.isArray(page) ? page : [page]))
  : [];
const matches = pulls.filter(
  (pull) =>
    pull &&
    pull.state === "open" &&
    pull.head &&
    pull.head.sha === sha &&
    Number.isInteger(pull.number),
);

if (matches.length !== 1) {
  console.error(
    `Not exactly one open PR with head SHA ${sha} (found ${matches.length}) - skipping.`,
  );
  process.exit(2);
}

process.stdout.write(`${matches[0].number}\n`);
