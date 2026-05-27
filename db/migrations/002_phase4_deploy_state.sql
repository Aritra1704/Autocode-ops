ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS environment_id TEXT,
  ADD COLUMN IF NOT EXISTS service_id TEXT,
  ADD COLUMN IF NOT EXISTS remote_deployment_id TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_deployments_status_created
  ON deployments(status, created_at);

CREATE INDEX IF NOT EXISTS idx_deployments_approval_id
  ON deployments(approval_id);
