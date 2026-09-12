ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS orchestrator_model   text,
  ADD COLUMN IF NOT EXISTS gemini_review_status text
    CHECK (gemini_review_status IN ('pending', 'approved', 'needs_fix'));

CREATE INDEX IF NOT EXISTS idx_tasks_gemini_review_status
  ON tasks (gemini_review_status)
  WHERE gemini_review_status = 'pending';
