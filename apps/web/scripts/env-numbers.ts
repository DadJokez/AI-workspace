/**
 * Env-var numeric parsing for smoke scripts. Extracted from
 * production-auth-smoke.ts so the logic is importable by tests — the script
 * itself executes `main()` at module load and must never be imported.
 */
export function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Like positiveNumber but allows an explicit 0 — used where 0 means
 * "disabled" (e.g. SMOKE_REQUEST_PACE_MS=0 turns pacing off).
 */
export function nonNegativeNumber(value: string | undefined, fallback: number) {
  // Number("") is 0 — an empty/blank env var must mean "unset", not
  // "explicitly disabled".
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
