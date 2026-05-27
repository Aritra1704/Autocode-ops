CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS stallone;

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  project_name TEXT,
  project_path TEXT,
  repo_url TEXT,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  blocked_reason TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tasks_priority_check CHECK (
    priority IN ('critical', 'high', 'medium', 'low')
  ),
  CONSTRAINT tasks_status_check CHECK (
    status IN (
      'pending',
      'leased',
      'in_progress',
      'verifying',
      'blocked',
      'waiting_approval',
      'done',
      'failed',
      'cancelled'
    )
  )
);

CREATE INDEX idx_tasks_status_priority_created
  ON tasks(status, priority, created_at);

CREATE TABLE agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  model_used TEXT,
  tool_called TEXT,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_logs_task_created
  ON agent_logs(task_id, created_at);

CREATE TABLE task_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_state (
  state_key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_via TEXT NOT NULL DEFAULT 'telegram',
  request_message_id TEXT,
  response_message_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  response_payload JSONB
);

CREATE INDEX idx_approvals_status_requested
  ON approvals(status, requested_at);

CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'railway',
  target_env TEXT NOT NULL DEFAULT 'production',
  repo_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  deploy_url TEXT,
  log_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL,
  description TEXT NOT NULL,
  definition JSONB NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE skill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  observation TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
  confidence_score INTEGER NOT NULL DEFAULT 5,
  times_applied INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_learnings_keywords
  ON learnings USING GIN(keywords);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  title TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_documents_source_path
  ON documents(source_path);

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_chunks_document_index_unique UNIQUE (document_id, chunk_index)
);

CREATE TABLE embeddings_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_chunk_id UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model_tag TEXT NOT NULL,
  embedding JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT embeddings_index_chunk_model_unique UNIQUE (document_chunk_id, model_tag)
);

CREATE TABLE model_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_tag TEXT UNIQUE NOT NULL,
  runtime TEXT NOT NULL,
  purpose TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_installed BOOLEAN NOT NULL DEFAULT FALSE,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  fallback_order INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agent_state (state_key, value)
VALUES
  ('status', '"running"'),
  ('current_task_id', 'null'),
  ('pause_reason', 'null'),
  (
    'stats',
    '{"tasks_completed": 0, "tasks_failed": 0, "uptime_start": null}'
  )
ON CONFLICT (state_key) DO NOTHING;

INSERT INTO model_catalog
  (model_tag, runtime, purpose, is_required, is_installed, health_status, fallback_order, notes)
VALUES
  ('gemma4:e4b', 'ollama', 'planning_and_review', TRUE, TRUE, 'unknown', 1, 'mandatory planner model'),
  ('qwen2.5-coder:7b', 'ollama', 'coding_and_debugging', TRUE, TRUE, 'unknown', 1, 'mandatory coder model'),
  ('nomic-embed-text:latest', 'ollama', 'embeddings', TRUE, TRUE, 'unknown', 1, 'mandatory embedding model'),
  ('qwen2.5:7b-instruct', 'ollama', 'summarize_and_classify', FALSE, TRUE, 'unknown', 2, 'fast utility model'),
  ('llama3.1:8b', 'ollama', 'reasoning_fallback', FALSE, TRUE, 'unknown', 3, 'general fallback'),
  ('mistral:7b', 'ollama', 'assistant_fallback', FALSE, TRUE, 'unknown', 4, 'tertiary fallback')
ON CONFLICT (model_tag) DO NOTHING;
