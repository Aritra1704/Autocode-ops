ALTER TABLE skill_runs
  ADD COLUMN IF NOT EXISTS skill_version INTEGER,
  ADD COLUMN IF NOT EXISTS input_payload JSONB,
  ADD COLUMN IF NOT EXISTS output_summary TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_skill_runs_skill_status_created
  ON skill_runs(skill_id, status, created_at);
