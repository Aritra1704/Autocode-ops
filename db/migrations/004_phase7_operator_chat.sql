
CREATE TABLE IF NOT EXISTS project_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  root_path TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  project_target_id UUID REFERENCES project_targets(id) ON DELETE SET NULL,
  project_path TEXT,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_sessions_actor_check CHECK (
    actor IN ('architect', 'coder', 'analyst', 'content_creator', 'writer')
  ),
  CONSTRAINT chat_sessions_status_check CHECK (
    status IN ('active', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
  ON chat_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  actor TEXT,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_messages_role_check CHECK (
    role IN ('user', 'assistant', 'system')
  )
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
  ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS chat_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS chat_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_chat_session
  ON tasks(chat_session_id);
