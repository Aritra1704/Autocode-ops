
ALTER TABLE project_targets
  ADD COLUMN IF NOT EXISTS github_repo_owner TEXT,
  ADD COLUMN IF NOT EXISTS github_repo_name TEXT,
  ADD COLUMN IF NOT EXISTS railway_project_id TEXT,
  ADD COLUMN IF NOT EXISTS railway_environment_id TEXT,
  ADD COLUMN IF NOT EXISTS railway_service_id TEXT,
  ADD COLUMN IF NOT EXISTS railway_service_name TEXT,
  ADD COLUMN IF NOT EXISTS browser_allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS project_target_id UUID REFERENCES project_targets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_project_target
  ON tasks(project_target_id);
