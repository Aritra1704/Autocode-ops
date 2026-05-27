# Stallone Architecture
## Arnold — The Autonomous Coding Agent

*Version 0.1 — Planning Document*
*Date: May 27, 2026*

---

## Core Philosophy

> "Gemini thinks. Ollama types. Arnold ships."

Gemini is not just a model in Stallone — it IS the runtime. It drives every decision,
calls every tool, and never steps away from a task until it's done or has a clear reason
to stop. Ollama models are disposable workers Gemini calls to generate specific code
blocks. The human is an optional collaborator, not a required approver.

---

## The Fundamental Shift from LocalClaw

**LocalClaw architecture:**
```
Task → Planner generates static JSON plan → Executor blindly runs steps in order
       (Gemini plans ONCE and steps away)
```

**Arnold architecture:**
```
Task → Gemini enters a tool loop
       Gemini decides next tool → LocalClaw executes → result returned to Gemini
       Gemini decides next tool → LocalClaw executes → result returned to Gemini
       ... (continuous until done or blocked)
       Gemini never steps away
```

This is the same pattern Claude Code uses. The model drives. The runtime executes.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     STALLONE RUNTIME                     │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │              GeminiDriver (The Brain)            │  │
│  │                                                  │  │
│  │  Tool loop:                                      │  │
│  │  1. Load context snapshot (2000 tokens)          │  │
│  │  2. Gemini decides next tool call                │  │
│  │  3. Runtime executes tool                        │  │
│  │  4. Result returned to Gemini                    │  │
│  │  5. Repeat until task_done or needs_human        │  │
│  │                                                  │  │
│  │  Budget monitor: checkpoint at 70% token budget  │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │ calls                                  │
│     ┌───────────┼────────────────────────────────┐      │
│     │           │                                │      │
│  [File Tools] [Ollama   ] [Git Tools] [Human    ]│      │
│  write_file   Sub-Agent   git_status  ask_human  │      │
│  patch_file   (code gen)  git_diff    /delegate  │      │
│  read_file                git_commit             │      │
│  list_files               run_tests              │      │
│  search_files                                    │      │
│     │           │                                │      │
│  ┌──┴──┐    ┌───┴──────────────────────────┐    │      │
│  │File │    │     FileEditPipeline          │    │      │
│  │Edit │    │  Router (llama3.2:3b)         │    │      │
│  │Pipe │    │    ↙ write    ↘ patch         │    │      │
│  │line │    │  Writer     Patcher           │    │      │
│  └──┬──┘    │  (7b)       (7b)              │    │      │
│     │       │    ↓           ↓              │    │      │
│     │       │  GitVerificationAgent (7b)    │    │      │
│     │       │  diff→test→commit or repair   │    │      │
│     │       └──────────────────────────────┘    │      │
│     └───────────────────────────────────────────┘      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              MEMORY LAYER                       │   │
│  │  L0: Task state + checkpoint                    │   │
│  │  L1: Exact artifacts (verbatim decisions)       │   │
│  │  L2: Learnings + RAG + Knowledge Graph          │   │
│  │  L3: Model performance stats                    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │           INTELLIGENCE LAYER                    │   │
│  │  ModelPerformanceTracker — data-driven routing  │   │
│  │  SkillGenerator — auto-creates from patterns    │   │
│  │  OnlineDetector — knows when you're reachable   │   │
│  │  TokenBudget — manages context window lifespan  │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Module Specifications

### 1. GeminiDriver — `src/brain/geminiDriver.js`

The heart of Arnold. Replaces the Orchestrator + Planner + Executor from LocalClaw.

**What it does:**
- Opens a Gemini multi-turn session (function calling mode)
- Hands Gemini the task description + all available tools
- Runs a `while (!done)` loop: send → receive tool call → execute → return result
- Monitors token budget via `TokenBudget`; compacts context at 70%
- On task completion: extracts learnings, updates model performance stats
- On failure after max retries: parks task, notifies via Telegram

**Gemini model used:**
- Default: `gemini-2.5-flash` (cheap, fast, 1M context)
- Escalation: `gemini-2.5-pro` when Flash requests it (complex architecture decision)
- Escalation is NOT hardcoded — Flash decides when to escalate based on task complexity

**Tool categories available to Gemini:**
```
File I/O:       read_file, list_files, search_files, write_file*
Edit pipeline:  call_file_edit(path, objective)  ← delegates to FileEditPipeline
Git:            git_status, git_diff, git_log, git_commit, run_tests
Shell:          run_terminal_command (sandboxed)
Memory:         save_learning, recall_learnings, save_artifact, get_artifact
Skills:         run_skill, create_skill, list_skills
Subtasks:       spawn_subtask, get_task_status
Human:          ask_human(question, urgency)
Ollama:         call_ollama_agent(model, task, context)
Infra:          pull_ollama_model, register_project
```
*write_file only used by FileEditPipeline internally, not Gemini directly

---

### 2. OllamaSubAgent — `src/brain/ollamaSubAgent.js`

The tool Gemini calls when it needs raw code generated.

**Protocol:**
1. Gemini calls: `call_ollama_agent({model, task, context, expected_output_format})`
2. SubAgent builds a focused prompt (task + context only, no pipeline noise)
3. Ollama generates raw output
4. SubAgent returns raw text to Gemini
5. Gemini reviews, extracts, and decides: good → apply via FileEditPipeline; bad → retry or do it itself

**Retry logic:**
- Max retries: configurable via `OLLAMA_MAX_RETRIES` (default: 3)
- On each retry: pass error + previous bad output back to Ollama for self-correction
- After max retries: return `{status: "failed", reason: "..."}` to Gemini
- Gemini then writes the code itself using Gemini Flash

**Model selection:**
Gemini specifies the model. If the model isn't available locally:
- SubAgent checks `ollama list`
- If missing: calls `pull_ollama_model` to download it
- Then retries

---

### 3. FileEditPipeline — `src/agents/`

A 3-agent pipeline. Gemini calls `call_file_edit(path, objective)` as one tool.
Internally this runs three sub-agents in sequence.

#### 3a. FileEditRouter — `src/agents/fileEditRouter.js`
**Model:** `llama3.2:3b` (fast, binary decision)
**Prompt:** Does `<path>` exist and have real content? yes → patch. no → write.
**Output:** `{action: "write" | "patch"}`
**Note:** Reads file existence from filesystem, not model hallucination.

#### 3b. FileWriter — `src/agents/fileWriter.js`
**Model:** `qwen2.5-coder:7b`
**Used when:** File doesn't exist (new file)
**Input:** path + objective + project context
**Output:** Full file content → written via `write_file`
**Rule:** One file per call. Max 150 lines for reliable output.

#### 3c. FilePatcher — `src/agents/filePatcher.js`
**Model:** `qwen2.5-coder:7b`
**Used when:** File exists and needs editing
**Input:** Full current file content + objective
**Process:**
1. If file > 150 lines: first call `search_files` to locate the relevant block
2. Generate precise `{oldContent, newContent}` pairs
3. Apply via `patch_file` (exact string match)
4. If patch fails (string not found): re-read file, retry once with corrected old_string
**Rule:** One logical change per patch call. Multiple patches for multiple changes.

#### 3d. GitVerificationAgent — `src/agents/gitVerificationAgent.js`
**Model:** `qwen2.5-coder:7b` (Ollama, works offline)
**Runs after every file edit** (write or patch)
**Process:**
1. `git diff` — what changed?
2. Language-appropriate syntax check (node --check, python -m py_compile, etc.)
3. Run project test command if defined in `PROJECT_RULES.md` or `package.json`
4. If all pass: `git add <file>` + `git commit -m "<step description>"`
5. If fail: attempt self-repair (re-run patcher with error + diff as context), max 2 attempts
6. If still fail after repair: return `{status: "blocked", reason: error}` to GeminiDriver
   GeminiDriver then decides: try different approach, ask human, or park task

**Key benefit:** One commit per verified step. Git history = task execution log.
If process crashes, git log shows exactly where to resume.

---

### 4. Context Management — `src/context/`

#### 4a. ContextLoader — `src/context/loader.js`
Loads the right ~2000 tokens at the start of each Gemini context window:
- Task brief (200 tokens)
- Project summary from knowledge graph (300 tokens)
- Last 3 relevant learnings for this project/task type (500 tokens)
- Last context checkpoint if resuming a mid-task window (500 tokens)
- Recent git log for project (200 tokens)
- Arnold soul (200 tokens)
Total: ~2000 tokens. Gemini requests additional files explicitly via `read_file`.

#### 4b. ContextCompactor — `src/context/compactor.js`
Monitors token usage from Gemini API response metadata.
At 70% of budget:
- Gemini writes a `context_checkpoint` memory artifact:
  - Steps completed (summary, not full logs)
  - Steps remaining (from original plan)
  - Current file hashes (knows what was changed without re-reading)
  - Key decisions made (architecture choices, model selections)
At 90%: open new Gemini context window, load from checkpoint via ContextLoader.
This is also crash recovery — Arnold always resumes from last checkpoint.

---

### 5. Intelligence Layer — `src/intelligence/`

#### 5a. ModelPerformanceTracker — `src/intelligence/modelPerformanceTracker.js`
Tracks in DB table `model_performance`:
```
{model, task_category, success_count, fail_count, avg_tokens, p95_duration_ms}
```
Updated after every task step.
Queried by GeminiDriver when deciding which model to pass to OllamaSubAgent.
Default order when no data: Flash → Flash with more context → Pro → ask human.

#### 5b. SkillGenerator — `src/intelligence/skillGenerator.js`
Watches the learnings table.
Trigger: same task pattern 3+ times, last 2 runs successful.
Action: Gemini generates a skill JSON, saves to `skills/generated/`, registers with `trust_score: 0.6`.
After 3 successful skill uses: trust_score → 1.0, promoted to `skills/builtin/`.
Skill template copied from LocalClaw's existing format.

#### 5c. OnlineDetector — `src/intelligence/onlineDetector.js`
Presence scoring (0–1):
- Telegram: last message < 30 min → +0.5
- Dashboard open (ping /api/presence every 60s) → +0.3
- Time-of-day IST 9am–midnight → +0.2
- Manual `/online` flag → 1.0 override; `/offline` → 0.0 override
Used by `ask_human` tool: only route to human if presence_score > 0.5.
If offline: park the question, continue with other steps, revisit when online.

#### 5d. TokenBudget — `src/intelligence/tokenBudget.js`
Per-task budget. Default: 50K tokens for Flash, 10K for Pro.
Configurable via `GEMINI_TASK_TOKEN_BUDGET`.
Feeds ContextCompactor trigger.
Also tracks total spend per project for billing awareness.

---

### 6. Soul — `src/memory/soul.md`

Arnold's identity. Evolved from LocalClaw's soul.

Core directives:
- Precision first: `patch_file` over `write_file` always
- Verification is truth: tests must pass, git must be clean
- Work directly in the project: never create an isolated workspace
- Ollama does the typing, Gemini does the thinking
- When in doubt, recall a learning before asking the human
- Track your wins and failures. They make you smarter.
- If a task pattern repeats 3 times, create a skill. Don't repeat yourself.
- Never waste tokens on chatty output. One decision, one action.
- The human is a collaborator, not an approver. Only ask when presence_score > 0.5.

---

### 7. What Copies Directly from LocalClaw

These modules are copied as-is (minor config updates only):

| Module | What it does |
|--------|-------------|
| `src/db/client.js` + migrations | PostgreSQL pool, schema, all 11 migrations |
| `src/memory/exactArtifacts.js` | Verbatim artifact storage with supersession |
| `src/memory/knowledgeGraph.js` + `graphifyAdapter.js` | Project relationship graph |
| `src/rag/` (chunker, ingestor, retriever) | Embeddings-based file retrieval |
| `src/memory/retention.js` | Auto-prune stale artifacts on schedule |
| `src/learnings/extractor.js` | Extract reusable patterns from completed tasks |
| `src/skills/manager.js` | Skill registry and execution |
| `skills/builtin/` (all 8 skills) | Scaffold skills, auto-prune, deploy-readiness, etc. |
| `src/tools/registry.js` | Tool definitions (extended with new tools) |
| `src/sandbox/manager.js` | Docker sandboxing for terminal commands |
| `src/git/cli.js` | Git operations wrapper |
| `src/github/` | GitHub publisher (optional feature) |
| `src/railway/` | Railway deployer (optional feature) |
| `src/telegram/` | Telegram bot + commands (extended with /online, /offline) |
| `src/control/api.js` | HTTP control API + React dashboard bridge |
| `src/cli/` | CLI (renamed: `arnold` command) |
| `src/mcp/` | MCP servers (postgres, filesystem, github) |
| `src/llm/providers/` | Gemini + Ollama provider clients |
| `src/browser/automation.js` | Browser automation for UI testing |

---

### 8. What Is Retired from LocalClaw

| Module | Why retired |
|--------|------------|
| `src/orchestrator.js` | Replaced by GeminiDriver |
| `src/agent/planner.js` | Gemini plans natively |
| `src/agent/executor.js` | Replaced by FileEditPipeline |
| `src/agent/verifier.js` | Replaced by GitVerificationAgent |
| `src/agent/specializedReview.js` | Merged into GitVerificationAgent |
| `src/agent/router.js` | Replaced by ModelPerformanceTracker |
| `src/agent/plannerContext.js` | Replaced by ContextLoader |
| `src/selfhealing/repairEngine.js` | Gemini self-repairs inline |
| `src/selfimprovement/reflectionEngine.js` | Gemini reflects continuously |
| `src/persona/artifacts.js` | Simplified to notification formatting only |
| `src/project/contract.js` (workspace isolation) | Arnold works in real project dirs |
| `src/control/taskContract.js` (executionPolicy) | All tasks are auto_local by default |

---

## Database — New Tables Needed

On top of LocalClaw's existing 11 migrations, Arnold adds:

```sql
-- Migration 012: model performance tracking
CREATE TABLE model_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model text NOT NULL,
  task_category text NOT NULL,
  success_count int NOT NULL DEFAULT 0,
  fail_count int NOT NULL DEFAULT 0,
  avg_tokens int,
  p95_duration_ms int,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Migration 013: context checkpoints
CREATE TABLE context_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  window_number int NOT NULL DEFAULT 1,
  steps_completed jsonb NOT NULL DEFAULT '[]',
  steps_remaining jsonb NOT NULL DEFAULT '[]',
  file_hashes jsonb NOT NULL DEFAULT '{}',
  key_decisions jsonb NOT NULL DEFAULT '[]',
  tokens_used int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Migration 014: presence tracking
CREATE TABLE presence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL, -- 'telegram', 'dashboard', 'manual'
  score numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
```

---

## Environment Variables

Inherits all LocalClaw `.env` variables, adds:

```env
# Arnold identity
ARNOLD_NAME=Arnold
ORCHESTRATOR_MODE=gemini  # gemini | local (local = Ollama-only fallback)

# Gemini
GEMINI_API_KEY=<key>
GEMINI_DEFAULT_MODEL=gemini-2.5-flash
GEMINI_ESCALATION_MODEL=gemini-2.5-pro
GEMINI_TASK_TOKEN_BUDGET=50000

# Ollama sub-agent
OLLAMA_MAX_RETRIES=3
OLLAMA_DEFAULT_CODER_MODEL=qwen2.5-coder:7b
OLLAMA_DEFAULT_ROUTER_MODEL=llama3.2:3b
OLLAMA_DEFAULT_VERIFIER_MODEL=qwen2.5-coder:7b

# Workspace (no more SSD isolation)
ARNOLD_WORKSPACE_ROOT=/Users/aritrarpal/Documents/workspace_biz

# Presence
PRESENCE_ONLINE_THRESHOLD=0.5
PRESENCE_WINDOW_MINUTES=30

# Skills
SKILLS_AUTO_GENERATE=true
SKILLS_AUTO_GENERATE_MIN_SUCCESSES=2
SKILLS_AUTO_GENERATE_MIN_PATTERN_COUNT=3
```

---

## Boot Sequence

```
1. DB connect + run pending migrations
2. Load soul.md → Arnold's identity
3. Warm Ollama models (non-blocking)
4. Start RAG ingestor (background)
5. Start knowledge graph sync (background)
6. Start memory retention (background)
7. Start Gemini session factory (warm connection)
8. Start Telegram bot
9. Start control API + serve dashboard
10. Start task queue polling loop
11. Start heartbeat scanner (every HEARTBEAT_INTERVAL_MS)
```

---

## The Heartbeat

Arnold proactively scans the workspace every hour (configurable).
Gemini drives this scan — not a static Ollama prompt.
It looks for: dependency drift, documentation rot, security risks, code quality issues.
If it finds something: creates a task with `source: 'heartbeat'`, `priority: 'low'`.
If you're online and it finds something critical: asks you first via Telegram.

---

## Task Lifecycle (Simplified)

```
pending
  ↓ (GeminiDriver picks up)
in_progress
  ↓ (Gemini tool loop running)
  ↓ (context checkpoint at 70% budget → new window → continues)
  ↓ (FileEditPipeline + GitVerificationAgent on each file change)
done         ← all steps complete, tests pass, git clean
failed       ← max retries exceeded, Gemini gave up
needs_human  ← Gemini parked a step for you (you're online)
blocked      ← external dependency missing (deploy target, credentials)
```

No `waiting_approval`. No `executionPolicy`. No approval gates for local work.

---

## Why This Will Work

1. **Gemini sees everything.** No static plan to go stale. Every tool result feeds back.
2. **Ollama does one job at a time.** Not "plan AND write AND verify." Just "write this function."
3. **Git verifies every step.** Code that passes tests gets committed. Code that doesn't gets repaired immediately.
4. **Files are touched once, surgically.** `patch_file` by default, `write_file` only for new files.
5. **The project is the workspace.** Code lands in `workspace_biz/project/`, not in an orphaned folder.
6. **Context never explodes.** Checkpointing keeps each window focused.
7. **The system learns.** Model performance, learnings, skills — every task makes the next one cheaper and faster.

---

*This document is the living spec for Arnold.*
*When Arnold modifies his own architecture, he updates this document.*
