ALTER TABLE legacy_import_items
  ADD COLUMN IF NOT EXISTS payload JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_target_active_idx
  ON jobs (kind, target_id)
  WHERE task_id IS NULL
    AND target_id IS NOT NULL
    AND status IN ('queued', 'processing', 'waiting');
