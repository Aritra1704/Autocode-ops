# Phase 6.3 — Skill Auto-Generation: Wiring Spec

*Version 1.0 — May 2026*
*Status: Ready for implementation via Codex*

---

## Problem Statement

`src/intelligence/skillGenerator.js` is fully implemented but is dead code — it is never imported
or called anywhere in the application. Separately, `src/learnings/extractor.js` is also never
invoked after a task completes. The result: the `learnings` table is always empty, and skills are
never auto-generated.

Phase 6.3 wires both into the post-task completion path, and replaces the brittle exact-string
pattern match in `skillGenerator.js` with a keyword-overlap similarity check that survives
LLM-generated text variation.

---

## Diagnosis: What is Missing

### Gap 1 — Post-task hook not wired in `geminiDriver.js`

`runTask()` in `src/brain/geminiDriver.js` (line ~183–298) reaches a `done` or `fail` branch and
returns `{ success, stepsCompleted, error }`. Before returning, it updates `orchestrator_model` and
`gemini_review_status` on the task row. But it never calls:

- `learningExtractor.extract(task, result)` → nothing is ever written to `learnings`
- `skillGenerator.checkAndGenerate(taskCategory)` → skills never triggered
- `skillManager.syncToDatabase()` → generated skill files never synced to DB

### Gap 2 — Pattern matching too strict to fire on LLM output

`skillGenerator.checkAndGenerate()` uses `patternKey(observation)` which is the raw first 80
characters of the observation string. It then requires an exact string match across ≥3 rows with
consecutive duplicates. LLM-generated observations for identical tasks will vary in wording —
this threshold will never be met in practice.

### Gap 3 — `taskCategory` is undefined at call site

`checkAndGenerate(taskCategory)` expects a category string like `"execution"` or `"planning"`.
The task object has no `category` field. The call site must derive it (e.g. from
`task.project_name` or a fixed value per task type).

---

## Target Behaviour After This Spec is Implemented

1. Every completed task (success or fail) triggers `learningExtractor.extract()` and saves
   1–4 learnings to the `learnings` table.
2. After each extraction, `skillGenerator.checkAndGenerate()` runs for the dominant learning
   category from that task.
3. If ≥3 learnings with ≥60% keyword overlap exist in that category (confidence ≥ 7), a skill
   JSON file is written to `skills/generated/<name>.json`.
4. `skillManager.syncToDatabase()` syncs any new files to the `skills` table.
5. All of steps 1–4 are non-blocking — a failure in any step logs a warning but does not affect
   the task's final status or throw.

---

## Files to Change

### 1. `src/brain/geminiDriver.js`

**What:** Accept `learningExtractor`, `skillGenerator`, and `skillManager` as optional dependencies
injected via the options object. Call the post-task hook after the task loop resolves.

**Where:** `createGeminiDriver(pool, options = {})` — destructure new options; add hook call just
before `return` at line ~292.

**Exact change (pseudocode — Codex to produce final JS):**

```js
// In createGeminiDriver(pool, options = {}):
const {
  workspaceRoot,
  geminiClient,
  learningExtractor = null,   // NEW
  skillGenerator = null,      // NEW
  skillManager = null,        // NEW
} = options;

// ... existing runTask logic unchanged ...

// After the pool.query that updates orchestrator_model (line ~280), before return:
const driverResult = taskSucceeded
  ? { success: true, stepsCompleted: stepNumber, error: null }
  : { success: false, stepsCompleted: stepNumber, error: lastError ?? 'unknown error' };

// --- Post-task hook (non-blocking) ---
if (learningExtractor) {
  try {
    const learnings = await learningExtractor.extract(task, {
      success: driverResult.success,
      steps,
      error: driverResult.error,
    });

    if (learnings.length > 0 && skillGenerator) {
      // Derive category from the highest-confidence learning
      const topCategory = learnings
        .sort((a, b) => b.confidenceScore - a.confidenceScore)[0].category;

      const genResult = await skillGenerator.checkAndGenerate(topCategory, learnings);

      if (genResult.generated && skillManager) {
        await skillManager.syncToDatabase();
      }
    }
  } catch (hookError) {
    console.warn('[geminiDriver] post-task hook failed (non-fatal):', hookError.message);
  }
}

return driverResult;
```

### 2. `src/learnings/extractor.js`

**What:** Update `buildPrompt` and the result shape to include the step list from `geminiDriver`
so the LLM has richer signal. Also update `extract(task, result)` signature to accept the new
result shape `{ success, steps, error }` instead of the old LocalClaw-shaped object.

**Current signature assumes:**
```js
result.plan?.summary
result.verification?.review?.status
result.publication?.attempted
result.repairState?.status
```

None of these fields exist on the result object `geminiDriver` would pass. The extractor will
always fall back to `buildFallback()` — which is functional but low-quality.

**New result shape from geminiDriver:**
```js
{
  success: boolean,
  stepsCompleted: number,
  error: string | null,
  steps: Array<{ step, tool, success?, summary?, reason? }>
}
```

**Changes needed in `extractor.js`:**

- `buildPrompt(task, result)`: replace all `result.plan?.summary` etc. with:
  ```
  Steps completed: ${result.stepsCompleted}
  Outcome: ${result.success ? 'success' : 'failed — ' + (result.error ?? 'unknown')}
  Tools used: ${[...new Set(result.steps?.map(s => s.tool) ?? [])].join(', ')}
  Failed steps: ${result.steps?.filter(s => s.success === false).map(s => s.tool).join(', ') || 'none'}
  ```
- `buildFallback(task, result)`: update to use `result.success` and `result.error`.
- Export signature remains `extract(task, result)` — no change to call site.

### 3. `src/intelligence/skillGenerator.js`

**What:** Replace exact-string `patternKey` matching with a keyword-overlap similarity function.
Accept an optional `learnings` parameter in `checkAndGenerate` to avoid a redundant DB query
when the caller already has fresh learnings in hand.

**Current pattern key (too strict):**
```js
function patternKey(observation) {
  return String(observation ?? '').trim().slice(0, 80);
}
```

**Replace with keyword-overlap similarity:**
```js
function extractKeywords(text) {
  return new Set(
    String(text ?? '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4)
  );
}

function similarityScore(obsA, obsB) {
  const a = extractKeywords(obsA);
  const b = extractKeywords(obsB);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter(w => b.has(w)).length;
  return intersection / Math.max(a.size, b.size);
}
```

**Update `checkAndGenerate(taskCategory, freshLearnings = null)`:**
- If `freshLearnings` is provided, skip the DB query and use those directly.
- Replace the `groups` Map logic: instead of exact key match, cluster rows where
  `similarityScore(rowA.observation, rowB.observation) >= 0.6`.
- A cluster qualifies if it has ≥3 members (instead of ≥3 exact duplicates + consecutive flag).
- Pick the cluster with the most members; use the observation with the highest `confidence_score`
  as `topObservation` for the skill definition.

**Remove `hasConsecutiveSuccesses` check** — it was a proxy for "same observation appeared
multiple times" that only worked for exact strings. The similarity cluster count replaces it.

### 4. `src/index.js` — Dependency Wiring

**What:** Pass `learningExtractor`, `skillGenerator`, and `skillManager` into `createGeminiDriver`.

**Where:** Around line 281 where `createGeminiDriver` is called:

```js
// Current (line ~281):
createGeminiDriver(pool, { workspaceRoot, geminiClient })

// New:
import { createLearningExtractor } from './learnings/extractor.js';
import { createSkillGenerator } from './intelligence/skillGenerator.js';

// In bootstrap(), after existing setup:
const learningExtractor = createLearningExtractor({
  client: ollamaClient,          // uses fast/local model — no Gemini call for learnings
  modelSelector,
});

const skillGenerator = createSkillGenerator(pool, {
  skillsDir: path.join(process.cwd(), 'skills', 'generated'),
});

// Pass into createGeminiDriver:
createGeminiDriver(pool, {
  workspaceRoot,
  geminiClient,
  learningExtractor,
  skillGenerator,
  skillManager,   // already constructed via createSkillManagerIfPresent()
})
```

Note: `skillManager` is already built at line ~92 via `createSkillManagerIfPresent()` but its
reference is local to that function. It must be lifted to the `bootstrap()` scope so it can be
passed to `createGeminiDriver`.

---

## DB: No Migration Needed

`learnings` and `skills` tables already exist (confirmed via `\dt`). `skill_runs` table also
exists. No new columns are required for this spec.

---

## Privacy Compliance

Per `docs/PRIVACY_AND_SECRETS.md` (Phase A — Ingress Scrubbing):

- `learningExtractor.extract()` result must be passed through `scrubSensitive(text)` before
  each `observation` is written to the `learnings` table.
- `skillGenerator` skill `description` field (derived from `topObservation`) must also be
  scrubbed before writing the `.json` file.
- `scrubSensitive` is not yet implemented — Codex should stub it as a pass-through
  (`return text`) and leave a `TODO(privacy): implement scrubSensitive` comment. The real
  implementation comes in the Privacy phase.

---

## Verification Steps (for Codex to run after implementation)

```bash
# 1. Restart Stallone
cd <your-workspace>/stallone && npm run dev

# 2. Submit one Spring Boot task
curl -s -X POST http://127.0.0.1:4174/v1/tasks/run \
  -H "Content-Type: application/json" \
  -H "x-control-token: stallone-control" \
  -d '{
    "version": "task_contract_v1",
    "projectName": "skill-test-1",
    "objective": "Create a minimal Spring Boot 3.4.x CLI app in the skill-test-1/ directory. Print exactly '\''Skill Test 1 running'\'' on startup. NOT a web app. Create 2 files: (1) skill-test-1/pom.xml — spring-boot-starter-parent 3.4.5, groupId com.example, artifactId skill-test-1, Java 21, spring-boot-starter only. (2) skill-test-1/src/main/java/com/example/SkillTestApp.java — CommandLineRunner printing '\''Skill Test 1 running'\''. After writing both files run: mvn compile -f skill-test-1/pom.xml -q 2>&1 | tail -20 via run_shell. Only call done after mvn compile exits 0.",
    "inScope": ["Create pom.xml", "Create SkillTestApp.java", "Verify with mvn compile"],
    "outOfScope": ["REST controllers", "tests", "git push"],
    "constraints": ["spring-boot-starter only", "Must run mvn compile via run_shell before done", "Must use GA release of spring-boot-starter-parent (no -M or -RC suffix)"],
    "successCriteria": ["pom.xml exists", "SkillTestApp.java exists", "mvn compile exits 0"],
    "priority": "high",
    "executionPolicy": "auto_local"
  }'

# 3. Wait for task to complete, then check learnings table
psql "postgresql://postgres:postgres@127.0.0.1:54329/localclaw" \
  -c "SET search_path TO stallone, public; SELECT category, LEFT(observation, 100), confidence_score FROM learnings ORDER BY created_at DESC LIMIT 5;"

# 4. Submit skill-test-2 and skill-test-3 (same structure, different project names)
# After all 3 complete, check for generated skill file:
ls <your-workspace>/stallone/skills/generated/

# 5. Check skills table
psql "postgresql://postgres:postgres@127.0.0.1:54329/localclaw" \
  -c "SET search_path TO stallone, public; SELECT name, source_type, LEFT(description, 80) FROM skills WHERE source_type = 'generated';"
```

**Pass criteria:**
- After task 1: ≥1 row in `learnings` table
- After tasks 1–3: at least one `.json` file in `skills/generated/` (may take a 4th run if
  similarity clustering needs more samples; this is acceptable)
- After skill file exists: matching row in `skills` table with `source_type = 'generated'`

---

## Out of Scope for This Spec

- Embedding-based similarity (keyword overlap is sufficient and avoids an extra Ollama call per
  task completion)
- Skill execution / `run_skill` tool wiring (already implemented in `skills/manager.js`)
- Telegram notification when a skill is generated (future nice-to-have)
- Privacy Phase A `scrubSensitive` full implementation (tracked in `PRIVACY_AND_SECRETS.md`)
