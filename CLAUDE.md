# CLAUDE.md — Stallone

Guidance for Claude Code when working in this repository.

## What is Stallone?

Stallone is a Node.js autonomous coding agent. It runs as a persistent service, polls a
PostgreSQL task queue, drives a per-step tool loop with Gemini as the brain, delegates all
file writes to Ollama sub-agents, and ships code via git.

**Core philosophy:** "Gemini thinks. Ollama types. Stallone ships."

## Commands

```bash
# Database (required first)
docker compose up -d postgres
npm run migrate

# Run service
npm run dev          # development, auto-reload
npm start            # foreground
pm2 start pm2.config.cjs   # background via PM2

# Tests
npm test
node --test tests/<file>

# UI
npm run ui:dev       # Vite on :5173
npm run ui:build     # build → served by control API on :4174
```

## Architecture

### Model roles (all implemented, all live)

| Role | Model | Config var | Frequency |
|---|---|---|---|
| Architect / PO | `gemini-2.5-flash` | `GEMINI_DEFAULT_MODEL` | Once per coordinator task — drives the `plan` tool call |
| Scrum Master | `gemini-2.5-flash-lite` | `GEMINI_STEP_MODEL` | Every step of every leaf task |
| QA | `gemini-2.5-flash-lite` | `GEMINI_STEP_MODEL` | After every completed leaf task (review loop) |
| CTO (escalation) | `gemini-2.5-pro` | `GEMINI_ESCALATION_MODEL` | Auto-triggered after 3 consecutive step failures |
| Developer (coder) | Ollama `qwen2.5-coder:7b` | `OLLAMA_MODEL_CODER` | Every file write/patch |
| Router | Ollama `llama3.2:3b` | `OLLAMA_MODEL_ROUTER` | write vs patch decision per file |
| Fallback | Ollama `qwen2.5-coder:14b` | `OLLAMA_MODEL_ORCHESTRATOR` | When Gemini is unavailable |

### Step loop — stateless, flat token cost

Each Gemini call in `src/brain/geminiDriver.js` receives a **fresh single-turn prompt**:

```
System prompt (~800 tokens, fixed)
Task title + description (fixed per task)
Project context (fixed per task)
Compact step log — one line per completed step (~50 tokens each)
Recent tool results — ring buffer of last 3 outputs (capped at 2500/3000 chars each)
```

There is **no accumulated conversation history**. The `recentResults[]` ring buffer
(max 3 entries) replaces the old unbounded `messages[]` array. Token cost is flat
regardless of step count (~6200 tokens at step 15 vs ~35000 in the old design).

Every Gemini generate call has `maxOutputTokens: 4096` set explicitly — this prevents
truncated JSON responses (the root cause of the Fargo failure).

Escalation: a `consecutiveFailures` counter auto-promotes to `gemini-2.5-pro` after
3 failures in a row, then resets on the next success.

See `docs/SPEC_STATELESS_STEP_LOOP.md` for the full design, known tradeoffs, and
future improvement ideas.

### Task flow

1. Orchestrator polls `pending` tasks with `FOR UPDATE SKIP LOCKED`
2. **Coordinator tasks** → GeminiDriver (flash) reads the project via `run_shell`, calls
   `plan` tool → inserts child task tree into DB → parks as `waiting_children`
3. **Leaf tasks** → GeminiDriver step loop (flash-lite): `run_shell` → `run_ollama` →
   verify → `done` / `fail`. Auto-escalates to Pro on 3 consecutive failures.
4. `run_ollama` → OllamaSubAgent → FileEditRouter (write vs patch) → FileWriter or
   FilePatcher → GitVerificationAgent → commit
5. After leaf completes → GeminiReviewLoop (flash-lite) reviews committed output,
   creates a fix task if `needs_fix`

Task state machine: `pending → in_progress → waiting_children → done / failed`

### Key files

| Path | What it does |
|---|---|
| `src/brain/geminiDriver.js` | Stateless step loop — fresh prompt per step, ring buffer, auto-escalation |
| `src/brain/ollamaSubAgent.js` | File write/patch sub-agent |
| `src/agents/fileEditRouter.js` | write vs patch routing (llama3.2:3b) |
| `src/agents/fileWriter.js` | New file generation (qwen2.5-coder:7b) |
| `src/agents/filePatcher.js` | Surgical file patching (qwen2.5-coder:7b) |
| `src/agents/gitVerificationAgent.js` | Verify + commit after every edit |
| `src/intelligence/geminiReviewLoop.js` | Post-task QA review (flash-lite) |
| `src/config.js` | All config — Zod-validated from `.env` |
| `db/migrations/` | Numbered SQL migrations |

### Memory and context

Task context assembled from: task row + recent agent_logs + learnings (keyword search) +
RAG chunks (semantic). Loaded in `src/index.js` (`loadTaskContext`) before passing to
GeminiDriver. Token usage per step is logged to `agent_logs` (step_type = `llm_call`).

### MCP

`src/mcp/` — postgres and filesystem MCP servers proxy DB access.

## Configuration

All config in `.env`, validated by Zod in `src/config.js`. Startup fails if required
keys are missing.

**Minimal dev setup:**
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/localclaw
DATABASE_SCHEMA=stallone
GEMINI_API_KEY=<key>
OLLAMA_BASE_URL=http://127.0.0.1:11434
STALLONE_WORKSPACE_ROOT=/Users/aritrarpal/Documents/workspace_biz
CONTROL_API_PORT=4174
```

**Model env vars:**
```
GEMINI_DEFAULT_MODEL=gemini-2.5-flash          # planning (plan tool call, coordinator tasks)
GEMINI_STEP_MODEL=gemini-2.5-flash-lite        # step loop + QA review (every step)
GEMINI_ESCALATION_MODEL=gemini-2.5-pro         # auto-escalation after 3 consecutive failures
GEMINI_STEP_MAX_OUTPUT_TOKENS=4096             # hard output cap per Gemini call
OLLAMA_MODEL_ORCHESTRATOR=qwen2.5-coder:14b   # Gemini fallback (offline mode)
OLLAMA_MODEL_CODER=qwen2.5-coder:7b           # file writes/patches
OLLAMA_MODEL_ROUTER=llama3.2:3b               # write vs patch routing
```

## Privacy constraint (hard rule)

Stallone must never store sensitive information in plaintext. All secrets scrubbed before
Gemini prompts, encrypted at rest, redacted from logs. See `docs/PRIVACY_AND_SECRETS.md`.
Every feature that persists data must comply.

## Claude Code behaviour rules (MANDATORY)

- **NEVER write or edit source code without explicit user approval.** Role is planning and
  specification only.
- When an improvement is identified, write a spec in `docs/` and wait for explicit
  confirmation ("yes", "go ahead", "implement it") before touching any `.js`, `.json`,
  `.cjs`, `.sql`, or `.env` file.
- If a request could be "plan this" or "implement this", always default to planning and ask.

## Engineering rules

- Small, explicit, readable changes. Prefer deterministic behaviour.
- All file paths in tool operations must be relative to workspace root.
- External API calls must have explicit timeouts, retries, and exponential backoff.
- Fail fast on missing required runtime config.

## Specs and design docs (`docs/`)

| File | Status | What it covers |
|---|---|---|
| `SPEC_STATELESS_STEP_LOOP.md` | ✅ Implemented | Stateless step loop design, v1 problems, v2 fixes, future ideas |
| `SPEC_MODEL_ROLE_SPLIT.md` | ✅ Implemented | Flash-lite for step loop + QA, Pro escalation, agile role analogy |
| `ARCHITECTURE.md` | Reference | System diagram, module specs (may lag code) |
| `PRIVACY_AND_SECRETS.md` | Active constraint | Secrets handling rules — mandatory for all new features |
| `PHASE_6_3_SKILL_AUTOGEN.md` | ✅ Implemented | Skill auto-generation from learning clusters |
| `PHASE_7_PROJECT_PLANNER.md` | ✅ Implemented | Project planner / coordinator task design |
| `PHASE_8_TASK_HIERARCHY.md` | ✅ Implemented | Task tree / coordinator / waiting_children design |
| `BACKLOG.md` | Low-priority | Deferred improvements |
| `WHY_STALLONE.md` | History | Why LocalClaw was retired |
