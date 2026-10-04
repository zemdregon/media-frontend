-- T2.2 (LLD-SYNC, LLD-MATCH "Derived fields of an item"): per-source display metadata.
-- A canonical item shows the metadata of its best present source. When that source goes missing
-- the next source must take over without calling the origin, so the fields `sources` did not yet
-- carry are kept per source: {"sort","originalTitle","overview","genres":[],"runtimeMs"}.
-- Expand-only (TDD section 3): a defaulted column; existing rows read as no extra metadata.
ALTER TABLE sources ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
