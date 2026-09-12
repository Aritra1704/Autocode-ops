ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depends_on UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS phase_index INTEGER;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (
    status IN (
      'pending',
      'leased',
      'in_progress',
      'verifying',
      'blocked',
      'waiting_approval',
      'waiting_children',
      'done',
      'failed',
      'cancelled'
    )
  );

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_task_type_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_type_check CHECK (
    task_type IN ('standard', 'coordinator')
  );

CREATE INDEX IF NOT EXISTS tasks_parent_task_id_idx
  ON tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;
