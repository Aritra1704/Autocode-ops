
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS summary_state JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE chat_summaries
  ADD COLUMN IF NOT EXISTS summary_state JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE chat_sessions
SET summary_state = jsonb_build_object(
  'version', 'chat_summary_v1',
  'summary', summary,
  'highlights', CASE
    WHEN summary = '' THEN '[]'::jsonb
    ELSE jsonb_build_array(summary)
  END,
  'preferences', '{}'::jsonb,
  'messageCount', 0
)
WHERE summary_state = '{}'::jsonb;

UPDATE chat_summaries
SET summary_state = jsonb_build_object(
  'version', 'chat_summary_v1',
  'summary', summary,
  'highlights', CASE
    WHEN summary = '' THEN '[]'::jsonb
    ELSE jsonb_build_array(summary)
  END,
  'preferences', '{}'::jsonb,
  'messageCount', message_count
)
WHERE summary_state = '{}'::jsonb;
