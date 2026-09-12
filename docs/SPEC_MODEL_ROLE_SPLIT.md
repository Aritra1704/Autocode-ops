# Spec: Model Role Split

*Date: 2026-06-01 — Status: ✅ Implemented*

---

## Agile analogy

| Agile Role | Model | Config var | Frequency |
|---|---|---|---|
| **Architect / PO** | gemini-2.5-flash | `GEMINI_DEFAULT_MODEL` | Once per coordinator task (plan tool call) |
| **Scrum Master** | gemini-2.5-flash-lite | `GEMINI_STEP_MODEL` | Every step of every leaf task |
| **QA** | gemini-2.5-flash-lite | `GEMINI_STEP_MODEL` | After every completed leaf task |
| **CTO (escalation)** | gemini-2.5-pro | `GEMINI_ESCALATION_MODEL` | Auto-triggered after 3 consecutive step failures |
| **Developer** | Ollama qwen2.5-coder:7b | `OLLAMA_MODEL_CODER` | Every file write/patch |

Flash-lite for Scrum Master and QA: both roles only need strict JSON tool routing and
structured verdict output — no deep reasoning required. Flash-lite costs ~10x less than
Flash at the same call frequency, and the step loop fires on every single step.

Flash (not flash-lite) is kept for planning because the `plan` tool call synthesises
multiple shell reads into a structured task tree — this benefits from stronger reasoning.

Pro escalation: a `consecutiveFailures` counter in `geminiDriver.js` auto-promotes to
Pro after 3 failures in a row and resets on the next success. This was previously
configured but never wired; it is now live.

---

## What was implemented

### `src/config.js`
```
GEMINI_STEP_MODEL=gemini-2.5-flash-lite      # default
GEMINI_STEP_MAX_OUTPUT_TOKENS=4096           # hard cap on every Gemini call
```
Both Zod-validated and exported as `config.geminiStepModel` and
`config.geminiStepMaxOutputTokens`.

### `src/brain/geminiDriver.js`
- Step loop uses `config.geminiStepModel` (flash-lite) instead of `config.geminiDefaultModel`
- `consecutiveFailures` counter: promotes to `config.geminiEscalationModel` (Pro) at ≥ 3
- `maxOutputTokens: config.geminiStepMaxOutputTokens` added to every generate call
- Full stateless step loop implemented — see `SPEC_STATELESS_STEP_LOOP.md`

### `src/intelligence/geminiReviewLoop.js`
- Both generate calls updated from `config.geminiDefaultModel` → `config.geminiStepModel`
- `maxOutputTokens: config.geminiStepMaxOutputTokens` added to review generate call

---

## Fargo truncation failure (resolved)

**Original error:**
```
Gemini returned unparseable response: {
  "tool": "run_ollama",
  "filePath": "social-media-ai-agent_ag/src/tests/test_api_screener_run.py",
  "instruction": "The `test_successful_request` test is failing because the `criteria` payload do
```

**Root cause:** Two compounding issues:
1. No `maxOutputTokens` set → Gemini hit its default output cap mid-token, producing
   truncated JSON that couldn't be parsed
2. Unbounded `messages[]` accumulation → by step 6-8 of a debugging task, the prompt
   exceeded 30k tokens, leaving almost no output budget for the model's response

**Fix applied:**
1. `maxOutputTokens: 4096` on every generate call (in both driver and review loop)
2. Replaced unbounded `messages[]` with a stateless step loop + `recentResults[]` ring
   buffer — prompt is now flat at ~6200 tokens regardless of step count

See `SPEC_STATELESS_STEP_LOOP.md` for the full stateless loop design.
