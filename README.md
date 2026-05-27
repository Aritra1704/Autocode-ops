# Stallone: The Autonomous Coding Agent

Stallone is a persistent, 24/7 autonomous coding agent built on a Gemini-driven tool loop.
It takes a project from idea to working code — planning, architecting, writing, verifying,
and committing — without waiting for human approval on every step.

Born from the lessons of LocalClaw, Stallone does what its predecessor couldn't:
it works directly inside your real projects, edits files surgically, and never loses context.

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

| Decision | Model | Cost |
|----------|-------|------|
| Architecture, routing, complex reasoning | Gemini Flash | ~$0.001/task |
| Escalation (subtle bugs, deep design) | Gemini Pro | On request only |
| Routine code generation | Ollama qwen2.5-coder:7b | Free |
| Write vs patch routing | Ollama llama3.2:3b | Free |
| Git verification, syntax, tests | Ollama qwen2.5-coder:7b | Free |
| Complex implementation (when you're online) | You + Codex | Your quota |

Gemini Flash handles the thinking. Ollama handles the typing. You handle what neither can.

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
│   ├── ARCHITECTURE.md     # Full technical specification
│   └── WHY_STALLONE.md     # Origin story — why LocalClaw was retired
└── db/
    └── migrations/         # 11 from LocalClaw + 3 new (performance, checkpoints, presence)
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
| 6.3 | Skill auto-generation test: run same task type 3 times, verify skill is created | Claude | ⬜ Planned |
| 6.4 | Context compaction test: task that exceeds token budget, verify checkpoint + resume | Claude | ⬜ Planned |

---

## Docs

- [`RUNBOOK.md`](RUNBOOK.md) — how to start, test, and interact with Stallone
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full technical specification for every module
- [`docs/WHY_STALLONE.md`](docs/WHY_STALLONE.md) — origin story, LocalClaw diagnosis, why this exists
