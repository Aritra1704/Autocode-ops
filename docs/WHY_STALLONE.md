# Why Stallone Exists

## The Short Version

LocalClaw proved the dream is real. Stallone is the dream, built right.

---

## The Conversation That Started This (May 27, 2026)

After months of building LocalClaw, the question was asked: *"Why am I horribly failing? Why can't I succeed? Where am I going wrong?"*

The diagnosis was brutal and honest. The system wasn't broken — the *architecture decisions* were fighting against the dream at every level. This document records exactly what was learned, why LocalClaw was retired, and why Stallone was built differently.

---

## What LocalClaw Actually Was

LocalClaw is a Node.js autonomous coding agent with:
- PostgreSQL task queue with lease-based polling
- Multi-provider LLM routing (Ollama + Gemini in hybrid mode)
- RAG with embeddings (nomic-embed-text), knowledge graph, exact memory artifacts
- Self-reflection engine, repair engine, specialized review agents
- Skills registry with 8 builtin skills
- MCP servers (postgres, filesystem, github)
- Telegram bot, React dashboard, Railway deployment, Docker sandboxing
- CLI, PM2 process management

It ran. It polled. It executed tasks. It was real infrastructure.

---

## What Was Actually Failing (The Diagnosis)

### 1. Hybrid mode was ON by accident
`.env` had `ORCHESTRATOR_MODE=hybrid` and `MODEL_PLANNER_CLOUD=gemini-2.5-flash`.
The "free local 24/7 coder" was using the Gemini API for planning on every single task.
Dream: free. Reality: API-dependent.

### 2. Every task required human approval before it started
`executionPolicy: "external_only"` in every task contract.
The system generated a plan, then stopped and waited for a human to click approve.
It would **never** run autonomously with that policy. Only `auto_local` skips the gate.
`REPAIR_AUTO_APPROVE=false` and `DEPLOY_AUTO_APPROVE=false` made it worse.

### 3. The planner never used patch_file
`patch_file` existed in the tool registry (surgical line-level editing).
But `qwen2.5-coder:14b` always chose `write_file` — overwriting entire files from scratch.
This meant every task destroyed existing code and replaced it with a blank-slate rewrite.
End-to-end project development was structurally impossible.

### 4. Tasks never touched real project files
Every task created an **isolated workspace** at `/Volumes/Ari_SSD_01/PROJECTS/localclaw/workspace/<slug>/`.
Code written there was never in the actual project.
`workspace_biz` was set as `LOCALCLAW_WORKSPACE_ROOTS` but the executor ignored it.
The files were always orphaned.

### 5. The local planner model produced malformed output on every run
Every ContractGenie task logged: *"Deterministic fallback plan created due to malformed planner output."*
`qwen2.5-coder:14b` couldn't reliably produce the JSON plan schema LocalClaw expected.
The fallback plan was generic and wrong. The task failed or got blocked.

### 6. The verifier blocked successful tasks
The verifier returned `needs_human_review` for outputs that were actually correct
(e.g., files created, docker-compose valid) because it couldn't run PostgreSQL to test.
`deriveFinalReviewStatus` then set status to `blocked`.
`deriveBlockedReason` picked `specializedReview.summary` ("passed") as the reason.
The message "Specialized agents passed documentation, security, and dependency review"
appeared as the blocked reason — deeply misleading.

### 7. The user kept resubmitting the same stuck task
With no understanding of why tasks were in `waiting_approval`, the same task was submitted
5 times. Each resubmission created another orphaned task. The queue appeared empty
because all tasks were in terminal states, never in `pending`.

### 8. The dream requires 70B models — or smarter architecture
The promise of "completely free 24/7 coding via local models" requires 32B–70B models
for reliable end-to-end generation. On a 16GB Mac Mini M4, the ceiling is 14B comfortably,
7B reliably. 7B models cannot plan + write multi-file features in one shot.
The hype is real — for people with 64GB+ systems. For everyone else, smarter architecture
is the only path.

---

## The Architecture Vision That Changed Everything

The question asked during this diagnosis session:
> *"GEMINI will be the base of localclaw, ollama models will be the agents under localclaw
> and at gemini's disposal... GEMINI is the orchestrator it will take in the project,
> architect, plan, design, create tasks, write HLD, write LLD, write each and every nook
> for every step... then code using ollama in agentic mode... GEMINI is the brain which
> facilitates which task has to be done by which model... utilise all the possible options
> we have in our hand, it has all the time in the world... remember its wins and fail rates,
> saves for future relations, can create skills for itself when required... if im online for
> coding can delegate some tasks to me. Is all this possible via GEMINI?"*

**Yes. All of it.**

And this is Stallone.

---

## What's Different in Stallone

| Problem in LocalClaw | Solution in Stallone |
|---------------------|---------------------|
| Plan-then-execute (static) | Gemini drives a live tool loop continuously |
| Ollama plans, often fails | Gemini plans, Ollama only codes small pieces |
| `write_file` for everything | 3-agent file pipeline (route → write or patch → verify) |
| Isolated workspace, real project untouched | Works directly in `workspace_biz/<project>/` |
| Approval gate on everything | `auto_local` by default, gates only for deploy |
| Verifier blocks correct outputs | Git verification agent: commit if tests pass |
| Model selection hardcoded | Data-driven: track success rates per model per task type |
| Context grows forever | Context compaction: checkpoint at 70% budget, resume |
| Skills created manually | Auto-generated when a pattern succeeds 3 times |
| No online detection | Presence scoring (Telegram + dashboard + time-of-day) |

---

## The Name

**Stallone** — after Rocky Balboa. Gets knocked down, gets back up. Doesn't quit.
The project was knocked down by months of failure. It gets back up.
The agent, the system, the runtime — all of it is Stallone.

---

## What LocalClaw Left Behind

LocalClaw is not deleted. It sits at `workspace_biz/localclaw/` and rests.
It proved every subsystem works. The DB schema, the RAG pipeline, the knowledge graph,
the Telegram bot, the skills registry, the MCP servers, the sandbox — all of it is sound.
Stallone inherits everything that works and rebuilds everything that doesn't.

LocalClaw was the research. Stallone is the product.

---

*Written: May 27, 2026*
*Author: The conversation between the builder and Claude Code*
