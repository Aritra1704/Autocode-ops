CREATE TABLE IF NOT EXISTS stallone.context_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES stallone.tasks(id) ON DELETE CASCADE,
  window_number int NOT NULL DEFAULT 1,
  steps_completed jsonb NOT NULL DEFAULT '[]',
  steps_remaining jsonb NOT NULL DEFAULT '[]',
  file_hashes jsonb NOT NULL DEFAULT '{}',
  key_decisions jsonb NOT NULL DEFAULT '[]',
  tokens_used int,
  created_at timestamptz NOT NULL DEFAULT now()
);
