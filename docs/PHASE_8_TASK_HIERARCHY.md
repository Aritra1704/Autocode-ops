# Phase 8 — Deep Task Hierarchy (Epic → Story → Task → Subtask)

## Problem

Stallone's planner currently creates a two-level tree: `coordinator → [phase tasks]`. Phase tasks are treated as atomic units but are often far too large — "Test AI Screener Endpoint" consumed all 30 steps and still didn't finish. There is no enforcement of task granularity at planning time, and no visibility below the phase level.

The 30-step failure is a symptom. The root cause is **tasks are not broken down small enough before execution begins**.

## Goal

Make Stallone plan like a senior engineer, not a project manager:
- Every leaf task must be executable in ≤ 15 steps (atomic unit rule)
- Any task estimated at > 15 steps must be split before it is queued
- Full hierarchy is visible and queryable — like Jira but in Postgres

## Hierarchy

```
Epic          — the whole project (e.g. "Complete Fargo")
  └─ Story    — a phase or feature area (e.g. "Phase 2 - AI Screener")
       └─ Task — a coherent unit of work (e.g. "Implement Ollama pre-filter")
            └─ Subtask  — atomic, ≤ 15 steps (e.g. "Write ollama.py client")
            └─ Testcase — atomic test, ≤ 10 steps (e.g. "Write test_screener.py")
            └─ Bug      — fix for a known failure, ≤ 10 steps
```

Each level is a row in `stallone.tasks`. The hierarchy is expressed via `parent_task_id` (already exists). Depth is unlimited in the DB; the planner enforces ≤ 4 levels by convention.

## DB Migration

```sql
-- 1. Expand task_type enum values (text column, no enum type — just document valid values)
-- Valid values: epic | story | task | subtask | testcase | bug
-- 'coordinator' is retired (replaced by epic/story/task acting as coordinators)
-- 'standard' is retired (replaced by subtask/testcase/bug)

-- 2. Add depth column for fast level queries
ALTER TABLE stallone.tasks ADD COLUMN depth integer NOT NULL DEFAULT 0;
-- depth 0 = epic, 1 = story, 2 = task, 3 = subtask/testcase/bug

-- 3. Add estimated_steps column — planner fills this before splitting decision
ALTER TABLE stallone.tasks ADD COLUMN estimated_steps integer;

-- 4. Add step_budget column — executor enforces this, defaults by type
ALTER TABLE stallone.tasks ADD COLUMN step_budget integer NOT NULL DEFAULT 15;
-- epics/stories/tasks: budget = 0 (they are coordinators, no direct execution)
-- subtask: 15, testcase: 10, bug: 10

-- 5. Index for hierarchy traversal
CREATE INDEX idx_tasks_parent ON stallone.tasks(parent_task_id);
CREATE INDEX idx_tasks_depth ON stallone.tasks(depth);
```

## Planner Changes (`src/brain/geminiDriver.js` system prompt)

### Atomic Unit Rule (enforce in system prompt)
Add to Gemini's planning instructions:

```
TASK SIZING RULE (non-negotiable):
Before queuing any task, estimate how many shell commands, file writes, and LLM calls it will require.
- If estimated steps > 15: you MUST split it into subtasks. Do not queue the parent as executable.
- subtask / testcase / bug: max 15 steps. These are the only types Gemini directly executes.
- task / story / epic: coordinator only — they spawn children and wait. Never execute steps directly.

SPLITTING RULE for test tasks:
Any task that involves "testing", "verifying", or "confirming" must always be split into:
  1. A subtask: "Write <test file>" — create the pytest file only
  2. A testcase: "Run <test file>" — execute pytest and report results
Never combine writing and running tests into a single task.
```

### `plan` Tool Extension

Current `plan` tool payload:
```json
{
  "tool": "plan",
  "tasks": [
    { "title": "...", "description": "...", "depends_on": [] }
  ]
}
```

Extended payload:
```json
{
  "tool": "plan",
  "tasks": [
    {
      "title": "...",
      "description": "...",
      "task_type": "subtask",
      "estimated_steps": 8,
      "step_budget": 15,
      "depends_on": [],
      "children": [
        {
          "title": "...",
          "task_type": "testcase",
          "estimated_steps": 5,
          "step_budget": 10,
          "depends_on": ["<sibling-ref>"]
        }
      ]
    }
  ]
}
```

The `plan` tool handler recursively inserts children, setting `parent_task_id` and `depth` correctly.

### Step Budget Enforcement

In `geminiDriver.js` execution loop, replace the hardcoded `MAX_STEPS = 30` with:

```js
const stepBudget = task.step_budget ?? 15;
if (stepCount >= stepBudget) {
  // Instead of failing: pause and re-plan
  // Emit a new coordinator task: "Re-plan remaining work for: <task title>"
  // Mark current task as 'needs_replan' (new status)
}
```

This turns a hard failure into a graceful handoff rather than a dead end.

## New Task Status

Add `needs_replan` as a valid status:
- Set when a task hits its step budget without completing
- The orchestrator picks up `needs_replan` tasks and resubmits them to the planner with context of what was completed so far
- Replaces the current `failed` outcome for step-limit hits (real failures remain `failed`)

## Coordinator Recursion

The coordinator polling loop (`checkChildrenComplete`) already works at any depth since it queries by `parent_task_id`. No structural change needed — it naturally handles N levels.

What changes: coordinators at story/task level must also propagate failure upward correctly. Currently a failed child cascades immediately. With deeper trees, policy should be:
- `subtask` fails → parent `task` retries it once (if retry_count < max_retries), then marks itself failed
- `task` fails → parent `story` marks itself failed, halts sibling tasks in the same story
- `story` fails → parent `epic` pauses, sends Telegram alert, waits for human input

## Telegram Notifications

| Event | Message |
|-------|---------|
| Epic created | `📦 Epic queued: <title> — N stories` |
| Story starts | `📖 Story: <title> — N tasks` |
| Task splits at runtime | `✂️ Task split: <title> → N subtasks (was too large)` |
| Subtask done | silent (too noisy) |
| Story done | `✅ Story done: <title>` |
| Epic done | `🏁 Epic complete: <title>` |
| needs_replan | `🔄 Replanning: <title> — hit step limit, breaking down further` |

## Implementation Order

1. DB migration (depth, estimated_steps, step_budget columns)
2. Expand `task_type` valid values in code constants
3. Update `plan` tool handler to support nested `children` and set depth
4. Update system prompt with atomic unit rule + splitting rule for tests
5. Replace hardcoded `MAX_STEPS=30` with per-task `step_budget`, emit `needs_replan` instead of failing
6. Update coordinator to handle `needs_replan` status
7. Update Telegram notifications for new event types
8. Test with a small project: "Build a 3-file Node.js HTTP server with tests"

## Files to Change

- `db/migrations/` — new migration file
- `src/brain/geminiDriver.js` — system prompt, step budget enforcement, plan tool handler
- `src/orchestrator.js` — needs_replan handling, coordinator recursion policy
- `src/index.js` — Telegram notification messages for new event types
- `src/config.js` — add `STEP_BUDGET_SUBTASK`, `STEP_BUDGET_TESTCASE` env vars

## What This Fixes

| Current problem | After Phase 8 |
|----------------|---------------|
| "Test X" always hits 30 steps | Split into write-test + run-test at planning time |
| Phase tasks are too coarse | Stories → Tasks → Subtasks, each ≤ 15 steps |
| Step limit = hard failure | Step limit = graceful replan |
| No visibility below phase level | Full tree queryable by depth, parent_task_id |
| Fargo phases can fail silently | Story-level failure triggers Telegram alert + human gate |
