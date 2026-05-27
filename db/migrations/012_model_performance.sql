CREATE TABLE IF NOT EXISTS stallone.model_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  task_category text NOT NULL,
  success_count int NOT NULL DEFAULT 0,
  fail_count int NOT NULL DEFAULT 0,
  avg_tokens int,
  p95_duration_ms int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, task_category)
);
