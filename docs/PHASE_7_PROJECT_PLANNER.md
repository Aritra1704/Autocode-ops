# Phase 7 — Project Planner

**Status:** Spec  
**Depends on:** Phase 6.3 (skill auto-generation) ✅  
**Goal:** Stallone receives a high-level goal (e.g. "complete the Fargo project"), reads the codebase and spec docs itself, generates an ordered plan of subtasks, queues them in the DB, and executes them one by one — with no help from Claude.

---

## 1. The Problem

Stallone today executes tasks given to it. It has no ability to:

- Read a project and understand what needs to be built
- Break a large goal into ordered phases
- Create and queue subtasks itself
- Verify each phase passes before starting the next

A human (or Claude) must decompose every project manually and submit individual tasks. This is the opposite of autonomous.

---

## 2. Design

### 2.1 Two task types

Introduce a `task_type` column on the `tasks` table:

| Value | Meaning |
|---|---|
| `standard` | Current behaviour — Gemini executes the task directly |
| `coordinator` | Gemini plans subtasks, inserts them, then waits for all to finish |

A coordinator task never writes files directly. Its only job is to plan, monitor, and report.

### 2.2 New `plan` tool

Add `plan` to the Gemini system prompt alongside `run_ollama`, `run_shell`, `done`, `fail`:

```
{ "tool": "plan", "phases": [ { "title": "...", "description": "...", "acceptance_criteria": "..." }, ... ] }
```

When Gemini calls `plan`:
- Each phase is inserted into `tasks` as a `standard` task with:
  - `parent_task_id` = coordinator task's id
  - `depends_on` = id of the previous phase (sequential by default)
  - `status = 'pending'`
  - `project_name` / `project_path` inherited from coordinator
- Coordinator task status moves to `waiting_children`
- Telegram notification: `📋 Project plan created\n<title>\nN phases queued`

Gemini must call `plan` only once. If it calls it twice, the second call is rejected with an error result.

### 2.3 How Gemini builds the plan

Before calling `plan`, Gemini must read the project. The system prompt instructs it to:

1. Call `run_shell` with `cat README.md` (or equivalent) to understand the project
2. Call `run_shell` with `cat docs/PHASES.md` (or equivalent spec) if it exists
3. Call `run_shell` with `ls src/` to see what is already built
4. Then call `plan` with phases derived from the spec

This means Gemini reads the actual project state and skips phases that are already complete. It is not given the plan by a human.

### 2.4 Task dependency enforcement

The polling loop in `leaseNextPendingTask` must be updated:

- Before leasing a task, check if it has `depends_on` set
- If the dependency task is not `done`, skip this task (do not lease it)
- If the dependency task is `failed`, mark this task `failed` with reason `"dependency failed: <id>"`

This guarantees sequential phase execution.

### 2.5 Coordinator polling loop

After inserting child tasks, the coordinator does not block. Instead:

- Its status is set to `waiting_children`
- The existing 5-second poll loop checks coordinators separately:
  - If all children are `done` → mark coordinator `done`
  - If any child is `failed` → mark coordinator `failed`, send Telegram alert
  - Otherwise → do nothing (keep waiting)

`waiting_children` tasks are excluded from `leaseNextPendingTask` (they are not executable).

### 2.6 Self-verification per phase

Each phase task description must include an `acceptance_criteria` section. The phase task's Gemini system prompt instructs it:

- After writing all files and running build/test commands
- Call `run_shell` with the acceptance criteria check (e.g. `curl -s http://127.0.0.1:8005/api/health | python3 -m json.tool`)
- Only call `done` if the check passes
- If the check fails, attempt to fix and retry (up to `MAX_STEPS`)
- If still failing after retries, call `fail` with the check output

This means phases are not marked done until they actually work.

---

## 3. DB Migration — `016_project_planner.sql`

```sql
ALTER TABLE stallone.tasks
  ADD COLUMN IF NOT EXISTS task_type       TEXT    NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS parent_task_id  UUID    REFERENCES stallone.tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depends_on      UUID    REFERENCES stallone.tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS phase_index     INTEGER;

-- Index for coordinator polling
CREATE INDEX IF NOT EXISTS tasks_parent_task_id_idx
  ON stallone.tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- Add waiting_children to the set of valid statuses
-- (Postgres CHECK constraint update — drop and recreate if exists)
```

---

## 4. Code Changes

### 4.1 `src/index.js`

**`leaseNextPendingTask`** — add dependency check:

```js
WHERE status = 'pending'
  AND task_type != 'waiting_children'
  AND (depends_on IS NULL OR EXISTS (
    SELECT 1 FROM stallone.tasks dep
    WHERE dep.id = tasks.depends_on AND dep.status = 'done'
  ))
  AND (scheduled_at IS NULL OR scheduled_at <= NOW())
```

**New `pollCoordinators()` function** — called each poll tick alongside `pollOnce()`:

```js
async function pollCoordinators() {
  // Find all waiting_children coordinators
  // For each: count children by status
  // If all done → mark coordinator done, send tgNotify ✅
  // If any failed → mark coordinator failed, send tgNotify ❌
}
```

### 4.2 `src/brain/geminiDriver.js`

**System prompt** — add `plan` tool description:

```
{ "tool": "plan", "phases": [{ "title": "...", "description": "...", "acceptance_criteria": "..." }, ...] }
  → creates child tasks in the DB and parks this coordinator task.
  Call this ONLY for high-level goals. Read the project first with run_shell before calling plan.
  Steps before calling plan:
    1. run_shell: cat README.md (understand the project)
    2. run_shell: ls src/ (see what is already built)
    3. run_shell: cat docs/PHASES.md or equivalent spec (understand what needs to be done)
    4. plan: create only the phases that are NOT already complete
```

**`plan` tool handler** in the main loop:

```js
if (toolName === 'plan') {
  if (planAlreadyCalled) {
    // reject second call
    messages.push({ role: 'user', content: 'plan already called — you can only plan once.' });
    continue;
  }
  planAlreadyCalled = true;

  const phases = toolCall.phases ?? [];
  let previousId = null;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const res = await pool.query(
      `INSERT INTO tasks (title, description, priority, source, status, task_type, parent_task_id, depends_on, phase_index, project_name, project_path)
       VALUES ($1, $2, 'medium', 'coordinator', 'pending', 'standard', $3, $4, $5, $6, $7)
       RETURNING id`,
      [phase.title, `${phase.description}\n\n## Acceptance Criteria\n${phase.acceptance_criteria}`,
       task.id, previousId, i, task.project_name, task.project_path]
    );
    previousId = res.rows[0].id;
  }

  await pool.query(
    `UPDATE tasks SET status = 'waiting_children' WHERE id = $1`, [task.id]
  );

  onProgress?.(`📋 Project plan created\n*${task.title}*\n${phases.length} phases queued`);

  // Return early — coordinator is now waiting
  return { success: true, stepsCompleted: stepNumber, error: null, isCoordinator: true };
}
```

### 4.3 `src/control/taskContract.js`

Add `task_type` to the contract builder so the Control API can submit coordinator tasks:

```js
// contract.taskType = 'coordinator' triggers planning mode
```

### 4.4 `src/telegram/commands.js`

No changes needed — plain text messages already create tasks. Sending "Complete the Fargo project at workspace_biz/fargo — read docs/PHASES.md and build phases 1 through 6" creates a coordinator task automatically because Gemini will call `plan` when it sees a high-level multi-phase goal.

---

## 5. Acceptance Criteria

- Sending "Complete the Fargo project — read docs/PHASES.md and build phases 1 through 6" via Telegram creates a coordinator task
- Stallone reads `README.md`, `docs/PHASES.md`, and `ls src/` before calling `plan`
- 6 child tasks are inserted with correct `parent_task_id`, `depends_on` chain, `phase_index` 0–5
- Telegram notification: `📋 Project plan created — 6 phases queued`
- Phase 1 starts only after coordinator inserts children
- Phase 2 starts only after Phase 1 is `done`
- If Phase 3 fails, Phase 4 does not start; coordinator marks itself failed
- Each phase runs `run_shell` acceptance checks before calling `done`
- Coordinator marks itself `done` only when all children are `done`
- Final Telegram: `✅ Project complete: Complete the Fargo project — 6/6 phases done`

---

## 6. What This Enables

Once this is built, any project with a spec doc can be handed to Stallone:

```
"Complete the Fargo project at workspace_biz/fargo — read docs/PHASES.md and build phases 1 through 6"
```

Stallone reads, plans, queues, executes, verifies — no Claude involvement.

---

## 7. Implementation Notes for Codex

Use this prompt for Codex:

> Implement Phase 7 of Stallone per `docs/PHASE_7_PROJECT_PLANNER.md`. The codebase is at `<your-workspace>/stallone/`. Key files to modify: `src/index.js` (leaseNextPendingTask, pollCoordinators, runTask), `src/brain/geminiDriver.js` (plan tool in system prompt + handler). New migration: `db/migrations/016_project_planner.sql`. Do not modify any other files. After implementing, run `node --check src/index.js` and `node --check src/brain/geminiDriver.js` to verify syntax.
