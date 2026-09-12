# Spec: Stateless Step Loop — Design, Problems, and Mitigations

*Date: 2026-06-01*

---

## What we built

Replaced the unbounded `messages[]` accumulation in `geminiDriver.js` with a stateless
single-turn prompt per step. Each Gemini call receives only:

1. System prompt (fixed, ~800 tokens)
2. Task title + description (fixed per task)
3. Project context (fixed per task)
4. Compact step log — one line per completed step (~50 tokens each)
5. Last tool result only — capped

**Token cost before vs after:**

| Step | Before (unbounded) | After (stateless) |
|---|---|---|
| Step 1  | ~1500 tokens  | ~1500 tokens |
| Step 5  | ~8000 tokens  | ~1900 tokens |
| Step 10 | ~18000 tokens | ~2100 tokens |
| Step 15 | ~35000 tokens | ~2300 tokens |

Context is cleared between tasks automatically — each `runTask()` call starts fresh.

---

## Problems discovered after v1 implementation

### Problem 1 — Planning loses prior shell reads (HIGH)

The `plan` tool requires synthesising multiple prior shell reads (README, ls src, PHASES.md).
With only `lastToolResult`, the model sees only the last shell output and forgets the earlier
reads. Plans generated from incomplete context are often wrong or incomplete.

**Fix:** Keep a `recentResults[]` ring buffer of the last 3 tool results instead of a single
`lastToolResult` string. The prompt shows all three under "Recent tool results:".

### Problem 2 — Debug loops lose root cause (HIGH)

A typical test-fix cycle:
```
Step N:   pytest → FAILED (AssertionError: expected X got Y)  ← was lastToolResult
Step N+1: run_ollama fix assertion                             ← overwrites lastToolResult
Step N+2: pytest → FAILED (different error)                   ← lastToolResult now
Step N+3: model only sees N+2's error, forgot original cause
```
Without the prior context the model may apply the same wrong fix repeatedly.

**Fix:** Same ring buffer — last 3 results covers the full fix cycle.

### Problem 3 — run_ollama diff cap too tight (MEDIUM)

1500 chars covers ~50-60 lines. A typical new file is 100-200 lines — diff gets truncated.
The model at the next step doesn't know the actual current state of the file it just wrote,
leading to contradictory instructions on subsequent edits to the same file.

**Fix:** Increase `run_ollama` result cap to 2500 chars.

### Problem 4 — Compact log has no instruction context (MEDIUM)

Log line: `Step 2 [run_ollama] src/api.py → committed abc1234`
The model has no idea what instruction was given or what code was actually written.
When revisiting the same file it has to guess the current content.

**Fix:** Store the first 80 chars of the instruction in `steps[]` and include it in the
compact log line.

### Problem 5 — Shell output cap regressed (LOW)

v1 dropped `run_shell` cap from 3000 → 1500 chars. Long pytest stack traces and compiler
errors get cut off more aggressively than the old design.

**Fix:** Restore shell output cap to 3000 chars.

---

## v2 implementation (current)

All five fixes applied in `src/brain/geminiDriver.js`:

- `recentResults[]` ring buffer, max 3 entries, replaces `lastToolResult`
- `run_ollama` result cap: 2500 chars
- `run_shell` result cap: 3000 chars (restored)
- Compact log includes first 80 chars of `run_ollama` instruction

**Worst-case token cost per step with all fixes:**

| Component | Tokens |
|---|---|
| System prompt | ~800 (fixed) |
| Task + context | ~1500 (fixed per task) |
| Compact log (15 steps × 60 tokens) | ~900 |
| Recent results (3 × ~1000 avg) | ~3000 |
| **Total** | **~6200 flat** |

Still 4-5x cheaper than the old unbounded approach at step 10+. Stays flat regardless
of task length.

---

## Future ideas to revisit

### Idea A — Tool-aware result retention
Instead of a fixed ring buffer, retain results selectively:
- Always keep the last `run_shell` result (verification output)
- Always keep the last `run_ollama` result (what was just written)
- Discard older results of the same tool type

This would keep the buffer smaller while preserving the most relevant context per tool.

### Idea B — Summarised history via flash-lite
Instead of a compact log (one line per step), call flash-lite to summarise the completed
steps into a 200-token paragraph before each Gemini step call. Cost: one extra LLM call
per step, but richer context than one-liners. Worth exploring if planning quality suffers.

### Idea C — Write step context to postgres, load selectively
Each step writes a brief summary row to `agent_logs`. For planning steps specifically,
load the full summaries of all prior shell reads from DB instead of the ring buffer.
Separates planning context from execution context without adding tokens to non-plan steps.

### Idea D — Separate planning pass
For coordinator tasks (those that call `plan`), run a separate pre-pass that collects all
shell reads into a single context blob, then calls Flash (not flash-lite) once to generate
the plan. The step loop is then only used for leaf tasks (which never call `plan`).
This fixes Problem 1 completely and also keeps the planning model at higher quality.

---

## Files changed

| File | Change |
|---|---|
| `src/brain/geminiDriver.js` | Stateless step loop, ring buffer, caps |
| `src/intelligence/geminiReviewLoop.js` | Uses `geminiStepModel` (flash-lite) |
| `src/config.js` | Added `GEMINI_STEP_MODEL`, `GEMINI_STEP_MAX_OUTPUT_TOKENS` |
