# Feature: compound (multi-column) filters and filtered aggregation

**Labels:** `enhancement`, `query-engine`, `high-value`
**Severity:** Feature gap — hard capability ceiling for the whole product

## Summary

The query tool cannot:

1. Apply a filter and an aggregate in one operation (see bug 01 — currently it *silently* returns the unfiltered aggregate).
2. Filter on more than one column at once (e.g. `sales_rep = X AND discount_pct > 15 AND refunded = TRUE`).
3. Split grouped counts by a date range (e.g. category share in 2024 H1 vs 2026 H1).

## What this makes impossible (with any model)

From a structured eval on a 62k-row synthetic dataset, the following standard analyses were **unreachable regardless of model quality**:

- Any segment average (per-rep, per-region, per-category AOV or discount rate)
- Cohort retention (orders per customer by acquisition campaign over time)
- Interaction effects (channel × day-of-week metrics)
- Mix-shift trends (category share over time)
- Anomaly attribution (refund rate of a rep's high-discount orders vs baseline)

The agent burned ~1M tokens on sampling workarounds (top-N sorts, matchedRows arithmetic) to approximate what one `GROUP BY` with a `WHERE` clause would answer.

## Ask

Support `filter (multi-predicate, AND/OR) + group-by + aggregate` as one operation. Even a restricted version (max 3 predicates, single group-by column) removes the entire ceiling described above. Until then, reject unsupported combinations loudly (bug 01) so agents stop receiving wrong numbers.
