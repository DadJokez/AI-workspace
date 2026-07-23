# Feature: date-part derivation (day-of-week, month/quarter bucketing) in the query tool

**Labels:** `enhancement`, `query-engine`
**Severity:** Feature gap

## Summary

The query tool exposes raw date strings only. It cannot derive day-of-week, week, month, or quarter from a date column, so any calendar-pattern analysis (weekday vs weekend volume, day-of-week AOV, week-level anomaly windows) is impossible. The agent's own report: *"The dataset has an `order_date` column but no `day_of_week` column… day-of-week derivation requires date arithmetic the tool cannot perform on raw strings."*

Monthly bucketing currently only works by the agent issuing ~30 separate range-count queries — which is how a single "orders per month" request consumed a large multiple of the tokens it should have.

## Ask

- Parse date columns at ingest (see bug 03) and expose derived parts: `year`, `quarter`, `month`, `week`, `day_of_week`, `is_weekend`.
- Allow group-by on derived parts (pairs with issue 10).

## Value

Weekday/weekend and month-over-month questions are among the most common analytics asks; today each one is either unanswerable or answered via dozens of manual range queries.
