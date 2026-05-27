
CREATE TABLE IF NOT EXISTS memory_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  chat_session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  project_scope TEXT,
  subsystem TEXT,
  source_message_id TEXT,
  source_step_number INTEGER,
  retrieval_priority INTEGER NOT NULL DEFAULT 50,
  content TEXT NOT NULL,
  content_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  supersedes_artifact_id UUID REFERENCES memory_artifacts(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_task_created
  ON memory_artifacts(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_chat_created
  ON memory_artifacts(chat_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_type_created
  ON memory_artifacts(artifact_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_scope_subsystem_created
  ON memory_artifacts(project_scope, subsystem, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_priority_created
  ON memory_artifacts(retrieval_priority DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_active_lookup
  ON memory_artifacts(task_id, chat_session_id, artifact_type, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_artifacts_supersedes
  ON memory_artifacts(supersedes_artifact_id);
