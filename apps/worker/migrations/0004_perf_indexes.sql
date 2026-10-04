-- Migration 0004: query-plan fixes from the T5.7 run at the NFR-SCALE-001 envelope
-- (docs/reports/2026-perf-cost.md). Expand-only (TDD section 3): one new index, no data change.
--
-- mi_year0: browse sorted by year orders by COALESCE(year, 0) (null years sort first, and the
-- keyset cursor carries that value), which `mi_year (type, year, id)` cannot serve; without this
-- index every year-sorted page sorted every visible title in a temp B-tree.
CREATE INDEX mi_year0 ON media_items(type, COALESCE(year, 0), id);
