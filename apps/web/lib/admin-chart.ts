export function scaleBarValues(values: readonly number[]): number[] {
  const normalized = values.map((value) =>
    Number.isFinite(value) ? Math.max(0, value) : 0,
  );
  const maximum = Math.max(0, ...normalized);

  if (maximum === 0) return normalized.map(() => 0);
  return normalized.map((value) => (value / maximum) * 100);
}

export function percentOf(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.round((Math.max(0, value) / total) * 100);
}
