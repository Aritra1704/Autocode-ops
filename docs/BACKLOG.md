# Stallone — Backlog

Low-priority improvements noted during development. Not scheduled. Pick up when convenient.

---

## Token Cost Tracking ✅ Done

Implemented in `src/brain/geminiDriver.js`. After every Gemini LLM call, `promptTokens` and `outputTokens` are written to `stallone.agent_logs` (step_type = `llm_call`). Non-fatal — a logging failure never interrupts task execution.

**Query to check cost:**
```sql
SELECT
  t.title,
  COUNT(l.id) AS llm_calls,
  SUM(l.input_summary::int) AS total_input_tokens,
  SUM(l.output_summary::int) AS total_output_tokens,
  ROUND(SUM(l.input_summary::int) / 1e6 * 0.075, 4) AS input_cost_usd,
  ROUND(SUM(l.output_summary::int) / 1e6 * 0.30, 4) AS output_cost_usd
FROM stallone.agent_logs l
JOIN stallone.tasks t ON t.id = l.task_id
WHERE l.step_type = 'llm_call'
GROUP BY t.id, t.title
ORDER BY (SUM(l.input_summary::int) + SUM(l.output_summary::int)) DESC;
```

Can be extended into a cost dashboard on the control UI later.

---

## Split Broad Testing Tasks ✅ Done (Phase 8)

Resolved by Phase 8. The Test Splitting Rule is baked into the Gemini system prompt in `src/brain/geminiDriver.js` — any task involving testing must be split into "Write test file" (subtask) + "Run test file" (testcase) at planning time.

---
