# Bug: filter+aggregate returns unfiltered full-table aggregate — silently

**Labels:** `bug`, `critical`, `data-correctness`, `query-engine`
**Severity:** Critical — silent wrong answers presented as correct results

## Summary

When a query combines a row filter with an aggregation (e.g. *average discount WHERE sales_rep = "Dana Kim"*), the tool returns the **full-table aggregate** instead of the filtered aggregate — with no error, warning, or indication that the filter was dropped. The result is a plausible-looking, confidently wrong number.

## Reproduction

1. Load a CSV with a numeric column and a categorical column (e.g. `orders.csv`: `discount_pct`, `sales_rep`).
2. Request an aggregate with a filter: `avg(discount_pct) WHERE sales_rep = "Dana Kim"`.
3. Compare against ground truth computed externally.

**Expected:** filtered average (~17.3% for this segment in the test dataset).
**Actual:** full-table average (4.03%) returned as if it were the filtered result. Agent transcript: *"The filter+aggregate combination is not applying the filter — it's returning full-table averages both times. The tool supports filter OR aggregate but not filter+aggregate combined."*

## Impact

- Every segment-level statistic (per-rep, per-region, per-category, per-period average/sum) returned by this tool is potentially the full-table value mislabeled as a segment value.
- An LLM agent that does not sanity-check will report these as findings. In our eval, only cross-checking (the "filtered" value exactly equaling the known table-wide value) exposed the bug.

## Suggested fix

If the combination is unsupported, **reject the request with an explicit error**. Silently degrading to an unfiltered aggregate is the worst possible behavior for an analytics tool. Longer term: support filtered aggregation (see issue 10).

## Provenance — CONFIRMED in run trace (no longer inferred)

Run `82fca145-b464-4ede-95cb-ae1a7f61e614` (2026-07-23), tool call `tooluse_1dnZid2xkyTiEIr4Hi07mw`:

- **Input:** `operation: table_aggregate, aggregate: count, column: order_id, filterColumn: order_date, filterOperator: contains, filterValue: "2024-01"`
- **Output:** `value: 62030, inspectedValues: 62030` — the full-table count (actual Jan-2024 rows: 1,268)
- **Receipt:** reports `sourceCoverage: full, resultCoverage: full` and does not acknowledge that a filter was requested, let alone that it was dropped.

The `resources__query` schema advertises `filterColumn`/`filterValue`/`filterOperator` alongside `aggregate` on the same operation, accepts the combination, and silently ignores the filter. Second corroborating call in the same run: `tooluse_tm04xZKnF9Lb9smit5DNSI` (another filtered `table_aggregate` → `value: 62030`).
