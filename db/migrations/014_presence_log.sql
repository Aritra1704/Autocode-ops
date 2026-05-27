CREATE TABLE IF NOT EXISTS stallone.presence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  score numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
