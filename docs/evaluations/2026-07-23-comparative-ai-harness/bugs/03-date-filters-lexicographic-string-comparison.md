# Bug: date filters compare raw strings — mixed-format dates return wrong rows

**Labels:** `bug`, `high`, `data-correctness`, `query-engine`
**Severity:** High

## Summary

Date-range filters compare `order_date` as raw strings rather than parsed dates. On a column containing mixed formats (`YYYY-MM-DD` and `M/D/YYYY`), a range filter returns rows that don't belong in the range, because `"3/25/2024" >= "2026-01-01"` is true lexicographically.

## Reproduction

1. Load `orders.csv` — 61,997 rows have ISO `YYYY-MM-DD` dates; 20 rows have `M/D/YYYY`; 13 more have out-of-range values (`1970-01-01`, `2027-…`).
2. Query `count WHERE order_date >= "2026-01-01"`.

**Expected:** 15,188 (rows actually dated 2026) — or a warning that 33 rows are unparseable/mixed-format.
**Actual:** 15,210, and the first returned row is dated `3/25/2024`. Agent transcript: *"the ≥2026-01-01 filter returned 15,210 rows but the first row returned shows order_date '3/25/2024' — revealing that dates are mixed format… date-based filters are unreliable."*

## Impact

- Any date-bounded metric on a file with even a handful of non-ISO dates is contaminated.
- Real-world CSVs contain mixed date formats routinely; this is not an exotic input.

## Suggested fix

Parse dates at ingest (with per-row parse status), filter on the parsed value, and surface unparseable-row counts in every date-filtered result (`matchedRows`, `unparseableRows`).

## Provenance

Observed via agent transcript narration (July 23, 2026, `orders.csv`). The 33 mixed/corrupt dates in the test file are planted and documented; repro file available.
