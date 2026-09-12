# Stallone: The Autonomous Coding Agent

Stallone is a persistent, 24/7 autonomous coding agent built on a Gemini-driven tool loop.
It takes a project from idea to working code — planning, architecting, writing, verifying,
and committing — without waiting for human approval on every step.

Born from the lessons of LocalClaw, Stallone does what its predecessor couldn't:
it works directly inside your real projects, edits files surgically, and never loses context.

## Why This Project Matters

Most "autonomous coding agent" projects stall at the same wall: either they need a human
to babysit every step (defeating the point of autonomy), or they hand planning to a model
too weak to plan reliably (defeating the point of correctness). LocalClaw hit this wall
for months — see [`docs/WHY_STALLONE.md`](docs/WHY_STALLONE.md) for the full post-mortem.
Stallone is the fix, and it's the difference between "an agent that runs" and
"an agent that ships":

- **It is the actual product, not a demo.** Stallone is not a proof-of-concept that writes
  a `hello.py` and stops — it plans multi-phase projects (epic → story → task → subtask),
  queues real work in Postgres, and commits verified code to git without a human clicking
  "approve" at every step.
- **It compounds instead of resetting.** Every task outcome is recorded. Model
  success/failure rates are tracked per task category. Patterns that succeed three times
  become auto-generated skills. The system gets cheaper and more reliable the longer it runs
  — it does not start from zero on every task the way most agent scaffolding does.
  See [`docs/PHASE_6_3_SKILL_AUTOGEN.md`](docs/PHASE_6_3_SKILL_AUTOGEN.md).
- **It scopes cost to the difficulty of the decision, not the size of the codebase.**
  A cheap model routes and executes routine steps; a stronger model is escalated to only
  when steps actually fail three times in a row. This is what makes "24/7" financially
  viable instead of a novelty.
- **It fails safely.** Every file edit goes through a router → writer/patcher → git
  verification pipeline before it is committed. Crashes resume from the last clean commit,
  not from scratch, and secret scrubbing is spec'd and gated — see docs/PRIVACY_AND_SECRETS.md (Phase A implementation in progress)
  (see [`docs/PRIVACY_AND_SECRETS.md`](docs/PRIVACY_AND_SECRETS.md)).
- **It knows when to stop being autonomous.** Presence scoring detects when a human is
  online and delegates complex or ambiguous work to them via Telegram instead of guessing —
  autonomy without this is just recklessness with extra steps.

In short: this isn't a script that calls an LLM in a loop. It's the infrastructure for
letting an LLM run a real software project end-to-end, with the guardrails that make doing
that safe enough to actually leave running.

---

## How It Works

Stallone does not generate a static plan and walk away. Gemini drives a **live tool loop** —
deciding the next action, calling the right tool, reading the result, and deciding again —
until the task is done or it needs you.

```
Task arrives
    ↓
Gemini reads project context (2000 tokens, not the whole codebase)
    ↓
Gemini drives: read → think → delegate → verify → commit → repeat
    ↓
When online: delegates complex implementation to you + Codex via Telegram
When offline: Ollama models handle routine code generation locally
    ↓
Every file change is git-verified before the next step begins
    ↓
Task ships. Learning saved. Skill created if pattern repeats.
```

---

## Core Principles

1. **Gemini is the brain, not a tool.** It drives the entire loop — planning, routing,
   reviewing, and deciding when to escalate. It never steps away mid-task.

2. **Ollama models are workers, not planners.** Each Ollama call does one job:
   write this function, patch this block. Gemini gives the context, receives the output,
   and applies it surgically.

3. **Surgical editing by default.** Every change to an existing file goes through a
   3-agent pipeline: a router decides write vs patch, a writer or patcher generates
   the change, a git verification agent confirms it before committing.

4. **Works in your real projects.** No isolated workspace copies. Stallone operates
   directly inside `workspace_biz/<project>/` — code lands where it belongs.

5. **Git is the source of truth.** Every verified step is committed immediately.
   The git log is the task execution log. Crashes resume from the last clean commit.

6. **You are a collaborator, not an approver.** When you are online, Stallone
   delegates complex tasks to you via Telegram, waits for your git push, then
   verifies and continues automatically.

7. **Learns and evolves.** Every task outcome is recorded. Model performance is
   tracked per task type. When a pattern succeeds three times, Stallone auto-generates
   a skill so the next run is faster and cheaper.

---

## Multi-Model Intelligence

Modeled as an agile team — see [`docs/SPEC_MODEL_ROLE_SPLIT.md`](docs/SPEC_MODEL_ROLE_SPLIT.md):

| Role | Decision | Model | Frequency | Cost |
|------|----------|-------|-----------|------|
| Architect / PO | Project planning (`plan` tool, epic → story → task) | Gemini Flash | Once per coordinator task | ~$0.001/task |
| Scrum Master | Every step of every leaf task | Gemini Flash-Lite | Every step | ~10x cheaper than Flash |
| QA | Review after every completed leaf task | Gemini Flash-Lite | Per completed task | ~10x cheaper than Flash |
| CTO (escalation) | Subtle bugs, deep design | Gemini Pro | Auto, after 3 consecutive failures | On demand only |
| Developer | Routine code generation | Ollama qwen2.5-coder:7b | Every file write/patch | Free (local) |
| Router | Write vs patch decision | Ollama llama3.2:3b | Per file edit | Free (local) |
| Fallback | Orchestration when Gemini is unreachable | Ollama qwen2.5-coder:14b | Offline mode only | Free (local) |
| Collaborator | Complex implementation (when you're online) | You + Codex | On delegation | Your quota |

Gemini Flash-Lite handles the high-frequency thinking (routing, verdicts) cheaply; Flash is
reserved for planning, where deeper reasoning actually pays off; Pro is a rare escalation,
not a default. Ollama handles the typing. You handle what none of them can.

---

## Project Structure

```
stallone/
├── src/
│   ├── brain/          # GeminiDriver (the core loop) + OllamaSubAgent
│   ├── agents/         # FileEditRouter, FileWriter, FilePatcher, GitVerificationAgent
│   ├── intelligence/   # ModelPerformanceTracker, SkillGenerator, OnlineDetector, TokenBudget
│   ├── context/        # ContextLoader, ContextCompactor (token budget management)
│   ├── memory/         # Exact artifacts, knowledge graph, RAG, retention, soul
│   ├── tools/          # Tool registry (all tools Gemini can call)
│   ├── skills/         # Skill manager
│   ├── telegram/       # Bot, commands, human delegation
│   ├── control/        # HTTP API, React dashboard bridge
│   ├── db/             # PostgreSQL client, migrations
│   └── ...             # git, github, railway, sandbox, mcp, rag, learnings
├── skills/
│   └── builtin/        # 8 scaffold and automation skills inherited from LocalClaw
├── docs/
│   ├── ARCHITECTURE.md               # Full technical specification (may lag code)
│   ├── SPEC_STATELESS_STEP_LOOP.md   # Stateless step loop design — ✅ Implemented
│   ├── SPEC_MODEL_ROLE_SPLIT.md      # Flash-lite step loop, Pro escalation — ✅ Implemented
│   ├── PHASE_6_3_SKILL_AUTOGEN.md    # Skill auto-generation from learning clusters — ✅ Implemented
│   ├── PHASE_7_PROJECT_PLANNER.md    # Coordinator tasks, the `plan` tool — ✅ Implemented
│   ├── PHASE_8_TASK_HIERARCHY.md     # Epic → story → task → subtask hierarchy — ✅ Implemented
│   ├── PRIVACY_AND_SECRETS.md        # Secret scrubbing rules — active constraint on all new features
│   ├── BACKLOG.md                    # Deferred, lower-priority improvements
│   └── WHY_STALLONE.md               # Origin story — why LocalClaw was retired
└── db/
    └── migrations/         # 17 migrations — LocalClaw-inherited schema plus Stallone-native
                             # additions (model performance, context checkpoints, presence,
                             # project planner, task hierarchy, and more)
```

---

## What Makes It Different from LocalClaw

| LocalClaw | Stallone |
|-----------|----------|
| Generated a static JSON plan, then stepped away | Gemini drives a live tool loop continuously |
| Ollama planned entire tasks — often failed | Ollama does one job at a time, Gemini reviews |
| Used `write_file` for everything | `patch_file` by default, `write_file` only for new files |
| Worked in an isolated SSD workspace | Works directly in your real project directory |
| Approval gate on every task | No gates for local work — only deploys need approval |
| Context window grew without bound | Checkpoints at 70% budget, resumes from checkpoint |
| Skills created manually | Auto-generated when a pattern succeeds 3 times |
| No awareness of whether you were available | Presence scoring — routes to you when you're online |

---

## Implementation Roadmap

**Legend:** ✅ Done · 🔄 In Progress · ⬜ Planned

### Phase 1 — Foundation (copy + configure from LocalClaw)

| # | Task | Owner | Status |
|---|------|-------|--------|
| 1.1 | `package.json`, `.env.example`, `src/config.js` — copy and update env vars for Stallone | Codex | ✅ Done |
| 1.2 | `db/migrations/` — copy all 11 from LocalClaw, add 3 new (model_performance, context_checkpoints, presence_log) | Codex | ✅ Done |
| 1.3 | `src/db/client.js` — copy as-is | Codex | ✅ Done |
| 1.4 | `src/memory/`, `src/rag/`, `src/learnings/` — copy as-is | Codex | ✅ Done |
| 1.5 | `src/tools/registry.js` — copy from LocalClaw, add new tools (search_files, call_ollama_agent, ask_human, pull_ollama_model) | Codex | ✅ Done |
| 1.6 | `src/sandbox/manager.js`, `src/git/cli.js`, `src/github/`, `src/railway/` — copy as-is | Codex | ✅ Done |
| 1.7 | `src/telegram/`, `src/control/`, `src/cli/`, `src/mcp/`, `src/browser/` — copy as-is | Codex | ✅ Done |
| 1.8 | `src/llm/providers/` (Gemini + Ollama clients) — copy as-is | Codex | ✅ Done |
| 1.9 | `skills/builtin/` — copy all 8 skills from LocalClaw | Claude | ✅ Done |
| 1.10 | `src/memory/soul.md` — copy and rewrite for Stallone identity | Claude | ✅ Done |

### Phase 2 — Intelligence Layer (net new, no LocalClaw equivalent)

| # | Task | Owner | Status |
|---|------|-------|--------|
| 2.1 | `src/intelligence/tokenBudget.js` — per-task token counter, triggers compaction at 70% | Codex | ✅ Done |
| 2.2 | `src/intelligence/onlineDetector.js` — presence scoring (Telegram + dashboard + git + time-of-day) | Codex | ✅ Done |
| 2.3 | `src/intelligence/modelPerformanceTracker.js` — tracks success/fail rates per model per task category | Codex | ✅ Done |
| 2.4 | `src/intelligence/skillGenerator.js` — auto-generates skills when a pattern succeeds 3 times | Codex | ✅ Done |
| 2.5 | `src/context/loader.js` — smart 2000-token context load at task start | Codex | ✅ Done |
| 2.6 | `src/context/compactor.js` — checkpoint at 70% budget, resume from checkpoint | Codex | ✅ Done |

### Phase 3 — File Edit Pipeline (net new)

| # | Task | Owner | Status |
|---|------|-------|--------|
| 3.1 | `src/agents/fileEditRouter.js` — llama3.2:3b decides write vs patch | Codex | ✅ Done |
| 3.2 | `src/agents/fileWriter.js` — qwen2.5-coder:7b writes new files | Codex | ✅ Done |
| 3.3 | `src/agents/filePatcher.js` — qwen2.5-coder:7b surgically edits existing files | Codex | ✅ Done |
| 3.4 | `src/agents/gitVerificationAgent.js` — post-edit: diff → syntax → tests → commit or repair | Codex | ✅ Done |
| 3.5 | `src/agents/humanDelegationAgent.js` — parks a step for you, sends Telegram, watches git for your push | Codex | ✅ Done |

### Phase 4 — The Core Loop (most critical, reviewed together before Codex touches it)

| # | Task | Owner | Status |
|---|------|-------|--------|
| 4.1 | `src/brain/ollamaSubAgent.js` — tool Gemini calls to delegate code generation to Ollama | Codex | ✅ Done |
| 4.2 | `src/brain/geminiDriver.js` — the Gemini tool loop: decide → call → receive → decide again | Codex + Claude review | ✅ Done |

### Phase 5 — Wiring and Boot

| # | Task | Owner | Status |
|---|------|-------|--------|
| 5.1 | `src/index.js` — boot sequence (DB → soul → Ollama warmup → RAG → Gemini → Telegram → API → poll) | Codex | ✅ Done |
| 5.2 | Telegram delegation commands (`/online`, `/offline`, `/done`, task notification format) | Codex | ✅ Done |
| 5.3 | Control API updates (presence endpoint `/v1/presence/ping`, Stallone-specific routes) | Claude | ✅ Done |
| 5.4 | PM2 config, `npm` scripts, health check CLI | Codex | ✅ Done |

### Phase 6 — Verification and Launch

#### Per-phase smoke tests (Claude verifies after each phase completes)

| After | Test | Command |
|-------|------|---------|
| Phase 1 | Config loads, DB migrates, skills sync | `npm run migrate && node -e "import('./src/config.js').then(m=>console.log('OK',Object.keys(m.config).length,'keys'))"` |
| Phase 2 | Intelligence modules import cleanly | `node --input-type=module <<< "import('./src/intelligence/onlineDetector.js').then(()=>console.log('OK'))"` |
| Phase 3 | File pipeline router makes correct decision | Manual: pass an existing file path and a new file path, confirm write vs patch routing |
| Phase 4 | GeminiDriver opens a session and calls one tool | Manual: submit a trivial task ("write hello to /tmp/test.txt"), verify file is created and committed |
| Phase 5 | Full boot sequence completes without error | `npm start` — watch logs for all subsystems reaching ready state |

#### End-to-end integration tests

| # | Task | Owner | Status |
|---|------|-------|--------|
| 6.1 | End-to-end test: submit a real task, verify Stallone plans and executes in `workspace_biz/` | Claude + human | ✅ Boot verified |
| 6.2 | Online detection test: trigger human delegation, implement with Codex, verify git pickup | Human | ⬜ Planned |
| 6.3 | Skill auto-generation: wire `learningExtractor` + `skillGenerator` into the post-task path in `geminiDriver.js` | Codex | ✅ Done — see [`docs/PHASE_6_3_SKILL_AUTOGEN.md`](docs/PHASE_6_3_SKILL_AUTOGEN.md) |
| 6.4 | Context compaction test: task that exceeds token budget, verify checkpoint + resume | Claude | ⬜ Planned |

### Phase 7 — Project Planner (net new)

**Goal:** Stallone receives a high-level goal, reads the codebase itself, and plans + queues
its own subtasks — no manual decomposition by a human or Claude.

| # | Task | Status |
|---|------|--------|
| 7.1 | `task_type` column (`standard` / `coordinator`) on `tasks` table — `db/migrations/016_project_planner.sql` | ✅ Done |
| 7.2 | `plan` tool in `geminiDriver.js` — Gemini decomposes a goal into ordered phases and inserts child tasks | ✅ Done |
| 7.3 | Coordinator task parks as `waiting_children`, polls until all children finish, reports in `src/index.js` | ✅ Done |

See [`docs/PHASE_7_PROJECT_PLANNER.md`](docs/PHASE_7_PROJECT_PLANNER.md).

### Phase 8 — Deep Task Hierarchy (net new)

**Goal:** Fix coordinator tasks that were too coarse (a single phase task consuming all 30
steps without finishing) by enforcing real decomposition: epic → story → task → subtask /
testcase / bug, each leaf capped at a small step budget.

| # | Task | Status |
|---|------|--------|
| 8.1 | `depth` column + expanded `task_type` values (`epic`, `story`, `task`, `subtask`, `testcase`, `bug`) — `db/migrations/017_phase8_task_hierarchy.sql` | ✅ Done |
| 8.2 | Per-task-type step budgets in `geminiDriver.js` (atomic leaf tasks ≤ 15 steps) | ✅ Done |
| 8.3 | `plan` tool schema updated to emit nested `task_type` + `children` | ✅ Done |

See [`docs/PHASE_8_TASK_HIERARCHY.md`](docs/PHASE_8_TASK_HIERARCHY.md).

---

## Docs

- [`RUNBOOK.md`](RUNBOOK.md) — how to start, test, and interact with Stallone
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full technical specification for every module (may lag code)
- [`docs/SPEC_STATELESS_STEP_LOOP.md`](docs/SPEC_STATELESS_STEP_LOOP.md) — the stateless, flat-token-cost step loop
- [`docs/SPEC_MODEL_ROLE_SPLIT.md`](docs/SPEC_MODEL_ROLE_SPLIT.md) — why Flash-Lite drives the step loop and QA, Pro is escalation-only
- [`docs/PHASE_6_3_SKILL_AUTOGEN.md`](docs/PHASE_6_3_SKILL_AUTOGEN.md) — how learnings become auto-generated skills
- [`docs/PHASE_7_PROJECT_PLANNER.md`](docs/PHASE_7_PROJECT_PLANNER.md) — coordinator tasks and the `plan` tool
- [`docs/PHASE_8_TASK_HIERARCHY.md`](docs/PHASE_8_TASK_HIERARCHY.md) — epic → story → task → subtask decomposition
- [`docs/PRIVACY_AND_SECRETS.md`](docs/PRIVACY_AND_SECRETS.md) — secret scrubbing rules, mandatory for all new features
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — deferred, lower-priority improvements
- [`docs/WHY_STALLONE.md`](docs/WHY_STALLONE.md) — origin story, LocalClaw diagnosis, why this exists
