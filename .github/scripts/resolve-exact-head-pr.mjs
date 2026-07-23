#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function candidate(pull) {
  return {
    number: pull.number,
    headRefName: pull.head.ref,
    headSha: pull.head.sha,
  };
}

function openPulls(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .flatMap((page) => (Array.isArray(page) ? page : [page]))
    .filter(
      (pull) =>
        pull &&
        pull.state === "open" &&
        Number.isInteger(pull.number) &&
        typeof pull.head?.ref === "string" &&
        typeof pull.head?.sha === "string",
    );
}

export function resolveExactHeadPullRequest(
  payload,
  { headSha, headRefName },
) {
  const sha = headSha?.trim();
  const ref = headRefName?.trim();
  if (!sha) {
    return {
      ok: false,
      reason: "The workflow run did not provide a head SHA.",
      candidates: [],
    };
  }

  const pulls = openPulls(payload);
  const shaMatches = pulls.filter((pull) => pull.head.sha === sha);
  const refMatches = ref
    ? pulls.filter((pull) => pull.head.ref === ref)
    : [];
  const exactMatches = ref
    ? shaMatches.filter((pull) => pull.head.ref === ref)
    : shaMatches;

  if (exactMatches.length === 1) {
    return {
      ok: true,
      pr: exactMatches[0].number,
      headRefName: exactMatches[0].head.ref,
      headSha: exactMatches[0].head.sha,
    };
  }

  if (exactMatches.length > 1) {
    return {
      ok: false,
      reason: `Multiple open pull requests match ${ref ? `${ref} at ` : ""}${sha}.`,
      candidates: exactMatches.map(candidate),
    };
  }

  if (ref && shaMatches.length > 0) {
    return {
      ok: false,
      reason: `Open pull request heads match SHA ${sha}, but none use branch ${ref}.`,
      candidates: shaMatches.map(candidate),
    };
  }

  if (ref && refMatches.length > 0) {
    return {
      ok: false,
      reason: `Branch ${ref} no longer points at workflow SHA ${sha}.`,
      candidates: refMatches.map(candidate),
    };
  }

  return {
    ok: false,
    reason: `No open pull request matches ${ref ? `${ref} at ` : ""}${sha}.`,
    candidates: [],
  };
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  const headSha = process.argv[2];
  const headRefName = process.argv[3];

  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    writeResult({
      ok: false,
      reason: `Could not parse the open pull request response: ${
        error instanceof Error ? error.message : String(error)
      }`,
      candidates: [],
    });
    process.exitCode = 2;
    return;
  }

  const result = resolveExactHeadPullRequest(payload, {
    headSha,
    headRefName,
  });
  writeResult(result);
  process.exitCode = result.ok ? 0 : 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
