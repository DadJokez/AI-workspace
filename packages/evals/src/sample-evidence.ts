import type { SampleResult } from "./types";

/** Bound retained diagnostics only, after assertions ran on the original transcript. */
export function retainSample(sample: SampleResult): SampleResult {
  let transformed = false;
  const json = JSON.stringify(sample, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    const safe = value
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
      .replace(/(bearer\s+)[^\s,;"']+/gi, "$1[REDACTED]")
      .replace(/((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]")
      .slice(0, 32_000);
    if (safe !== value) transformed = true;
    return safe;
  });
  return { ...JSON.parse(json) as SampleResult, ...(transformed ? { evidenceTransformed: true } : {}) };
}
