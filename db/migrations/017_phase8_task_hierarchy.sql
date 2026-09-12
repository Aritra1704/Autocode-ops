-- Phase 8: Deep Task Hierarchy
-- Adds depth, estimated_steps, step_budget columns.
-- Expands status check to include needs_replan.
-- Expands task_type check to include epic/story/task/subtask/testcase/bug.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_steps INTEGER,
  ADD COLUMN IF NOT EXISTS step_budget INTEGER NOT NULL DEFAULT 15;

-- Coordinators don't execute steps directly — give them budget 0
UPDATE tasks SET step_budget = 0 WHERE task_type = 'coordinator';

-- Expand status constraint to include needs_replan
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
      'cancelled',
      'needs_replan'
    )
  );

-- Expand task_type to full hierarchy
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_task_type_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_type_check CHECK (
    task_type IN (
      'standard',    -- legacy, treated as subtask
      'coordinator', -- legacy, treated as epic/story
      'epic',        -- whole project
      'story',       -- phase or feature area
      'task',        -- coherent unit of work, spawns subtasks
      'subtask',     -- atomic leaf, step_budget = 15
      'testcase',    -- atomic test leaf, step_budget = 10
      'bug'          -- atomic fix leaf, step_budget = 10
    )
  );

-- Set correct step_budget for leaf types (existing standard tasks)
UPDATE tasks SET step_budget = 15 WHERE task_type = 'standard';

-- Indexes
CREATE INDEX IF NOT EXISTS tasks_depth_idx
  ON tasks (depth);

CREATE INDEX IF NOT EXISTS tasks_needs_replan_idx
  ON tasks (status)
  WHERE status = 'needs_replan';
