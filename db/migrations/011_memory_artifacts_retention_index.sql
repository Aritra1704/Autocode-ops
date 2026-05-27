-- Index for retention prune queries: orphan scan, active expiry, archived cleanup
CREATE INDEX IF NOT EXISTS idx_memory_artifacts_retention
  ON memory_artifacts (archived_at, expires_at, created_at)
  WHERE archived_at IS NULL;

-- Index for retrieval queries: task-linked artifact lookups
CREATE INDEX IF NOT EXISTS idx_memory_artifacts_task_type
  ON memory_artifacts (task_id, artifact_type, retrieval_priority DESC)
  WHERE archived_at IS NULL;

-- Index for chat-linked lookups
CREATE INDEX IF NOT EXISTS idx_memory_artifacts_chat_type
  ON memory_artifacts (chat_session_id, artifact_type, retrieval_priority DESC)
  WHERE archived_at IS NULL;
