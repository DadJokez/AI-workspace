# Bug: boolean-valued filter silently ignored — returns full-table count

**Labels:** `bug`, `critical`, `data-correctness`, `query-engine`
**Severity:** Critical — silent wrong answers

## Summary

Filtering on a boolean-like column (`refunded` containing string values `TRUE`/`FALSE`) with a boolean literal returns the **unfiltered full-table count** instead of the filtered count, with no error. Filtering with the string value works.

## Reproduction

1. Load `orders.csv` (column `refunded` with string values `TRUE`/`FALSE`).
2. Query `count WHERE refunded = true` (boolean literal).

**Expected:** 1,540 (or a type-mismatch error).
**Actual:** 62,030 — the full row count, presented as the filtered result. Agent transcript: *"The refunded filter returned the full count rather than the filtered count — the tool is not supporting the boolean filter as expected. Let me try with string values."* String-value filtering (`refunded = "TRUE"`) then returned the correct 1,540.

## Impact

Same class as issue 01: a failed filter that degrades to "match everything" produces confident wrong numbers. Type coercion between boolean literals and string-typed columns should either work or fail loudly.

## Suggested fix

- On filter type mismatch, return an error naming the column's actual type and sample values.
- Never fall back to an unfiltered result.

## Provenance

Observed via agent transcript narration (July 23, 2026, `orders.csv`). Confirm with direct API test.
