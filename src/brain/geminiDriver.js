import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from '../config.js';
import { createGeminiClient } from '../llm/providers/gemini.js';
import { runOllamaSubAgent } from './ollamaSubAgent.js';
import { delegateToHuman } from '../agents/humanDelegationAgent.js';
import { computePresenceScore, isHumanOnline } from '../intelligence/onlineDetector.js';
import { checkAndEvictIfNeeded } from '../intelligence/modelResourceGuard.js';

const execFileAsync = promisify(execFile);

const STEP_BUDGET_BY_TYPE = {
  epic: 0,
  story: 0,
  task: 0,
  coordinator: 0,
  subtask: 15,
  standard: 15,
  testcase: 10,
  bug: 10,
};

function resolveStepBudget(task) {
  const fromDb = task.step_budget != null ? Number(task.step_budget) : null;
  if (fromDb !== null && fromDb > 0) return fromDb;
  return STEP_BUDGET_BY_TYPE[task.task_type] ?? 15;
}

const RECENT_RESULTS_MAX = 3;
const CAP_OLLAMA_RESULT = 2500;
const CAP_SHELL_RESULT = 3000;
const CAP_INSTRUCTION_LOG = 80;

// One-line summary per completed step. Includes first 80 chars of run_ollama instruction
// so the model has a hint of what was attempted when revisiting the same file.
function formatCompactLog(steps) {
  if (steps.length === 0) return '  (none yet)';
  return steps
    .map((s) => {
      if (s.tool === 'run_ollama') {
        const status = s.success ? `committed ${s.commitHash ?? '?'}` : `failed: ${s.error ?? '?'}`;
        const hint = s.instruction ? ` ("${s.instruction.slice(0, CAP_INSTRUCTION_LOG)}")` : '';
        return `  Step ${s.step} [run_ollama] ${s.filePath ?? 'file'}${hint} → ${status}`;
      }
      if (s.tool === 'run_shell') {
        const cmd = (s.command ?? '').slice(0, 60);
        return `  Step ${s.step} [run_shell] \`${cmd}\` → ${s.success ? 'succeeded' : 'failed'}`;
      }
      if (s.tool === 'ask_human') {
        return `  Step ${s.step} [ask_human] → ${s.skipped ? 'skipped (offline)' : s.completed ? 'completed' : 'timed out'}`;
      }
      return `  Step ${s.step} [${s.tool}]`;
    })
    .join('\n');
}

// Fresh single-turn prompt per step. Uses a ring buffer of the last N tool results
// so planning steps retain prior shell reads and debug loops retain prior errors.
function buildStepPrompt(task, context, steps, recentResults) {
  const parts = [
    `Task: ${task.title}`,
    ``,
    `Description: ${task.description}`,
    ``,
    `Project context:`,
    context,
    ``,
    `Steps completed so far (${steps.length}):`,
    formatCompactLog(steps),
  ];

  if (recentResults.length > 0) {
    parts.push(``, `Recent tool results (oldest → newest):`);
    recentResults.forEach((r, i) => {
      parts.push(`[${i + 1}] ${r}`);
    });
  }

  parts.push(``, `What is your next tool call? Respond with JSON only.`);
  return parts.join('\n');
}

// Ollama fallback — single-turn, same prompt structure as Gemini.
async function ollamaGenerate({ model, system, prompt, timeoutMs = 300_000 }) {
  const baseUrl = config.ollamaBaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await checkAndEvictIfNeeded();

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama /api/chat failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    return data?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

export function createGeminiDriver(pool, options = {}) {
  const {
    workspaceRoot = config.stalloneWorkspaceRoot ?? process.cwd(),
    geminiClient = createGeminiClient(),
    learningExtractor = null,
    skillGenerator = null,
  } = options;
  const gemini = geminiClient;

  return {
    async runTask(task, context, options = {}) {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const shortId = task.id?.slice(0, 8) ?? '?';

      const steps = [];
      const recentResults = []; // ring buffer — last RECENT_RESULTS_MAX tool outputs
      let stepNumber = 0;
      let lastError = null;
      let usedOllamaFallback = false;
      let usedEscalation = false;
      let taskSucceeded = false;
      let planAlreadyCalled = false;
      let consecutiveFailures = 0;

      const stepBudget = resolveStepBudget(task);
      const systemPrompt = [
        'You are Stallone, an autonomous coding agent.',
        'You work by calling tools in sequence until the task is complete.',
        '',
        'Available tools (call as JSON in your response):',
        '  { "tool": "run_ollama", "filePath": "relative/path/to/file.ext", "instruction": "...", "context": "..." }',
        '    filePath must be a path RELATIVE to the workspace root (e.g. "hello.txt", "src/index.js"). Never use an absolute path or a directory.',
        '    → delegates code generation to a local Ollama model',
        '  { "tool": "run_shell", "command": "...", "cwd": "relative/path" }',
        '    cwd is optional, relative to workspace root. command runs in a shell with a 60s timeout.',
        '    → runs a shell command to verify files exist, compile code, or run tests',
        '  { "tool": "plan", "tasks": [{ "title": "...", "description": "...", "task_type": "story|task|subtask|testcase|bug", "estimated_steps": N, "acceptance_criteria": "...", "children": [...] }] }',
        '    → creates child tasks in the DB and parks this coordinator task while they run.',
        '    Call this ONLY for high-level multi-phase goals. Read the project first with run_shell before calling plan.',
        '    Steps before calling plan:',
        '      1. run_shell: cat README.md (understand the project)',
        '      2. run_shell: ls src/ (see what is already built)',
        '      3. run_shell: cat docs/PHASES.md or equivalent spec (understand what needs to be done)',
        '      4. plan: create only the work that is NOT already complete',
        '    task_type guide: story = phase/feature area (has children), subtask = atomic code/config work, testcase = write+run a test, bug = targeted fix',
        '    BACKWARD COMPAT: "phases" array is also accepted (treated as stories without children).',
        '  { "tool": "ask_human", "question": "...", "context": "..." }',
        '    → parks the task and waits for the human to push a commit',
        '  { "tool": "done", "summary": "..." }',
        '    → marks the task as complete',
        '  { "tool": "fail", "reason": "..." }',
        '    → marks the task as failed',
        '',
        '━━━ ATOMIC UNIT RULE (non-negotiable) ━━━',
        `This task has a step budget of ${stepBudget} steps. You MUST complete within this budget.`,
        'Before planning any child task, estimate its steps. If estimated steps > 15, split it into smaller subtasks.',
        'NEVER combine multiple concerns into one task if total estimated steps exceed 15.',
        '',
        '━━━ TEST SPLITTING RULE (always apply) ━━━',
        'Any work involving "testing", "verifying", or "confirming" MUST be split into exactly two tasks:',
        '  1. task_type: "subtask" — title "Write <test file>" — only creates the pytest/jest file, no execution',
        '  2. task_type: "testcase" — title "Run <test file>" — runs the test command and reports pass/fail',
        'NEVER combine writing and running tests into a single task.',
        '',
        'Rules:',
        '- Call one tool per response.',
        '- After each tool result, decide the next tool.',
        '- Use run_ollama for all file edits and code generation.',
        '- If run_ollama fails, retry immediately with a clearer or simpler instruction. Do NOT skip a file and call done.',
        '- Only call done when EVERY file required by the task has been successfully written (run_ollama returned success for each one). Verify this before calling done.',
        '- After writing all files, use run_shell to verify they exist and that the code compiles. Fix any errors before calling done.',
        '- If the task description includes acceptance criteria, run the relevant verification command with run_shell and only call done once the acceptance criteria pass.',
        '- If run_ollama fails 3 consecutive times for the same file, call fail explaining which file could not be written.',
        '- Use ask_human only when you are genuinely stuck and retrying will not help.',
        '- Call plan at most once per task.',
        '- Never output plain text — always output a JSON tool call.',
      ].join('\n');

      const maxSteps = stepBudget > 0 ? stepBudget : 0;

      while (maxSteps > 0 && stepNumber < maxSteps) {
        stepNumber += 1;

        // Build a fresh single-turn prompt — no accumulated history.
        const stepPrompt = buildStepPrompt(task, context, steps, recentResults);

        // Pick model: escalate to Pro after 3 consecutive failures, otherwise use flash-lite.
        const stepModel = consecutiveFailures >= 3
          ? config.geminiEscalationModel
          : config.geminiStepModel;

        let responseText;
        try {
          if (config.geminiEnabled) {
            const geminiResponse = await gemini.generate({
              model: stepModel,
              system: systemPrompt,
              prompt: stepPrompt,
              format: 'json',
              retries: 1,
              options: { maxOutputTokens: config.geminiStepMaxOutputTokens },
            });
            responseText = geminiResponse.responseText;

            if (consecutiveFailures >= 3) usedEscalation = true;

            // Non-fatal token logging for cost tracking.
            const promptTokens = geminiResponse.promptEvalCount ?? 0;
            const outputTokens = geminiResponse.evalCount ?? 0;
            if (promptTokens + outputTokens > 0) {
              pool.query(
                `INSERT INTO agent_logs (task_id, step_number, step_type, model_used, status, input_summary, output_summary)
                 VALUES ($1, $2, 'llm_call', $3, 'success', $4, $5)`,
                [task.id, stepNumber, stepModel, String(promptTokens), String(outputTokens)]
              ).catch((err) => {
                console.warn('[geminiDriver] agent_logs insert failed:', err?.message);
              });
            }
          } else {
            responseText = await ollamaGenerate({
              model: config.ollamaModelOrchestrator,
              system: systemPrompt,
              prompt: stepPrompt,
            });
          }
        } catch (geminiError) {
          if (config.geminiEnabled) {
            try {
              usedOllamaFallback = true;
              responseText = await ollamaGenerate({
                model: config.ollamaModelOrchestrator,
                system: systemPrompt,
                prompt: stepPrompt,
              });
            } catch (ollamaError) {
              lastError = `Gemini failed: ${geminiError?.message}. Ollama fallback also failed: ${ollamaError?.message}`;
              break;
            }
          } else {
            lastError = geminiError?.message ?? 'Orchestrator LLM call failed';
            break;
          }
        }

        let toolCall;
        try {
          const cleaned = responseText.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
          toolCall = JSON.parse(cleaned);
        } catch {
          lastError = `Gemini returned unparseable response: ${responseText?.slice(0, 200)}`;
          break;
        }

        const toolName = toolCall?.tool;

        // --- Tool: done ---
        if (toolName === 'done') {
          steps.push({ step: stepNumber, tool: 'done' });
          taskSucceeded = true;
          consecutiveFailures = 0;
          break;
        }

        // --- Tool: fail ---
        if (toolName === 'fail') {
          lastError = toolCall.reason ?? 'Gemini called fail';
          steps.push({ step: stepNumber, tool: 'fail' });
          break;
        }

        // --- Tool: run_ollama ---
        if (toolName === 'run_ollama') {
          onProgress?.(`🛠 Step ${stepNumber}: writing \`${toolCall.filePath ?? 'file'}\`\nTask: ${task.title} (${shortId})`);
          const result = await runOllamaSubAgent({
            instruction: toolCall.instruction,
            filePath: toolCall.filePath,
            workspaceRoot: task.project_path ?? workspaceRoot,
            taskId: task.id,
            context: toolCall.context,
          });

          steps.push({
            step: stepNumber,
            tool: 'run_ollama',
            filePath: toolCall.filePath,
            instruction: toolCall.instruction,
            success: result.success,
            commitHash: result.commitHash,
            error: result.error,
          });

          const ollamaResult = result.success
            ? `run_ollama succeeded for ${toolCall.filePath}. Decision: ${result.decision}. Commit: ${result.commitHash}.\nDiff:\n${result.diff ?? ''}`.slice(0, CAP_OLLAMA_RESULT)
            : `run_ollama failed for ${toolCall.filePath} after ${result.attempts} attempts: ${result.error}`;

          recentResults.push(ollamaResult);
          if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();

          consecutiveFailures = result.success ? 0 : consecutiveFailures + 1;
          continue;
        }

        // --- Tool: run_shell ---
        if (toolName === 'run_shell') {
          onProgress?.(`⚙️ Step ${stepNumber}: running shell\n\`${(toolCall.command ?? '').slice(0, 120)}\`\nTask: ${task.title} (${shortId})`);
          const shellCwd = path.resolve(task.project_path ?? workspaceRoot, toolCall.cwd ?? '.');
          let succeeded = false;

          let shellResult;
          try {
            const { stdout, stderr } = await execFileAsync('sh', ['-c', toolCall.command ?? 'true'], {
              cwd: shellCwd,
              timeout: 60_000,
              maxBuffer: 100_000,
            });
            const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, CAP_SHELL_RESULT);
            shellResult = `run_shell succeeded.\n${output || '(no output)'}`;
            succeeded = true;
          } catch (error) {
            const output = [error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, CAP_SHELL_RESULT);
            shellResult = `run_shell failed (exit ${error.code ?? 'unknown'}).\n${output || error.message}`;
          }

          recentResults.push(shellResult);
          if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();

          steps.push({
            step: stepNumber,
            tool: 'run_shell',
            command: toolCall.command,
            success: succeeded,
          });

          consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
          continue;
        }

        // --- Tool: plan ---
        if (toolName === 'plan') {
          if (planAlreadyCalled) {
            recentResults.push('plan already called — you can only plan once.');
            if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();
            continue;
          }

          planAlreadyCalled = true;

          const rawItems = Array.isArray(toolCall.tasks)
            ? toolCall.tasks
            : Array.isArray(toolCall.phases)
              ? toolCall.phases.map((p) => ({ ...p, task_type: 'story' }))
              : [];

          const client = await pool.connect();

          function budgetForType(taskType) {
            return STEP_BUDGET_BY_TYPE[taskType] ?? 15;
          }

          async function insertTaskTree(itemData, parentId, parentDepth, sequencePreviousId) {
            const title = String(itemData.title ?? '').trim();
            const description = String(itemData.description ?? '').trim();
            const acceptanceCriteria = String(itemData.acceptance_criteria ?? '').trim();
            const taskType = String(itemData.task_type ?? 'subtask').trim();
            const estimatedSteps = itemData.estimated_steps != null ? Number(itemData.estimated_steps) : null;
            const children = Array.isArray(itemData.children) ? itemData.children : [];
            const isParent = children.length > 0;
            const depth = parentDepth + 1;

            const initialStatus = isParent ? 'waiting_children' : 'pending';
            const effectiveType =
              isParent && !['epic', 'story', 'task', 'coordinator'].includes(taskType)
                ? 'task'
                : taskType;
            const budget = isParent ? 0 : budgetForType(effectiveType);

            const fullDescription = acceptanceCriteria
              ? `${description}\n\n## Acceptance Criteria\n${acceptanceCriteria}`
              : description;

            const insert = await client.query(
              `INSERT INTO tasks (
                 title, description, priority, source, status,
                 task_type, parent_task_id, depends_on,
                 project_name, project_path,
                 depth, estimated_steps, step_budget
               )
               VALUES ($1, $2, 'medium', 'coordinator', $3, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING id`,
              [
                title || 'Untitled task',
                fullDescription,
                initialStatus,
                effectiveType,
                parentId,
                sequencePreviousId ?? null,
                task.project_name ?? null,
                task.project_path ?? null,
                depth,
                estimatedSteps,
                budget,
              ]
            );

            const insertedId = insert.rows[0]?.id ?? null;

            if (isParent && insertedId) {
              let prevChildId = null;
              for (const child of children) {
                prevChildId = await insertTaskTree(child, insertedId, depth, prevChildId);
              }
            }

            return insertedId;
          }

          try {
            await client.query('BEGIN');

            let previousId = null;
            let insertedCount = 0;

            for (const item of rawItems) {
              if (!item.title) throw new Error('plan task is missing a title');
              previousId = await insertTaskTree(item, task.id, task.depth ?? 0, previousId);
              insertedCount += 1;
            }

            await client.query(
              `UPDATE tasks
               SET status = 'waiting_children',
                   task_type = CASE
                     WHEN task_type IN ('standard', 'subtask', 'testcase', 'bug') THEN 'coordinator'
                     ELSE task_type
                   END
               WHERE id = $1`,
              [task.id]
            );

            await client.query('COMMIT');
            onProgress?.(`📋 Project plan created\n${task.title}\n${insertedCount} top-level tasks queued`);

            return {
              success: true,
              stepsCompleted: stepNumber,
              error: null,
              isCoordinator: true,
            };
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            lastError = error?.message ?? 'plan tool failed';
            steps.push({ step: stepNumber, tool: 'plan', success: false });
            break;
          } finally {
            client.release();
          }
        }

        // --- Tool: ask_human ---
        if (toolName === 'ask_human') {
          onProgress?.(`🙋 Step ${stepNumber}: asking for your input\n${toolCall.question ?? ''}\nTask: ${task.title} (${shortId})`);
          const presence = await computePresenceScore(pool, workspaceRoot).catch(() => ({ score: 0 }));
          const online = isHumanOnline(presence.score);

          if (!online) {
            const skipMsg = `ask_human skipped: human not online (score: ${presence.score.toFixed(2)}). Continuing autonomously.`;
            steps.push({ step: stepNumber, tool: 'ask_human', skipped: true });
            recentResults.push(skipMsg);
            if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();
            continue;
          }

          const delegationResult = await delegateToHuman({
            taskId: task.id,
            stepDescription: toolCall.question,
            workspaceRoot: task.project_path ?? workspaceRoot,
            timeoutMinutes: 60,
          });

          steps.push({
            step: stepNumber,
            tool: 'ask_human',
            completed: delegationResult.completed,
          });

          recentResults.push(
            delegationResult.completed
              ? `Human completed the step. New commit: ${delegationResult.newCommitHash}`
              : `Human delegation timed out after 60 minutes.`
          );
          if (recentResults.length > RECENT_RESULTS_MAX) recentResults.shift();
          continue;
        }

        // Unknown tool
        lastError = `Gemini called unknown tool: ${toolName}`;
        break;
      }

      const hitBudget = maxSteps > 0 && stepNumber >= maxSteps && !taskSucceeded && !lastError;
      if (hitBudget) {
        const completedSummary = steps
          .map((s) =>
            s.tool === 'run_ollama'
              ? `wrote ${s.filePath}`
              : s.tool === 'run_shell'
                ? `ran shell`
                : s.tool
          )
          .join(', ');
        return {
          success: false,
          needsReplan: true,
          stepsCompleted: stepNumber,
          error: `Hit step budget (${maxSteps}) without completing the task`,
          completedStepsSummary: completedSummary || 'no steps recorded',
        };
      }

      const orchestratorModel = usedEscalation
        ? config.geminiEscalationModel
        : usedOllamaFallback
          ? config.ollamaModelOrchestrator
          : config.geminiStepModel;

      await pool.query(
        `UPDATE tasks
         SET orchestrator_model = $1,
             gemini_review_status = $2
         WHERE id = $3`,
        [
          orchestratorModel,
          usedOllamaFallback ? 'pending' : null,
          task.id,
        ]
      );

      const driverResult = taskSucceeded
        ? { success: true, stepsCompleted: stepNumber, error: null }
        : { success: false, stepsCompleted: stepNumber, error: lastError ?? 'unknown error' };

      if (learningExtractor) {
        try {
          const learnings = await learningExtractor.extract(task, {
            success: driverResult.success,
            stepsCompleted: driverResult.stepsCompleted,
            error: driverResult.error,
            steps,
          });

          if (learnings.length > 0 && skillGenerator) {
            const topCategory = [...learnings].sort(
              (a, b) => b.confidenceScore - a.confidenceScore
            )[0]?.category;

            if (topCategory) {
              const generationResult = await skillGenerator.checkAndGenerate(topCategory);
              if (generationResult.generated) await skillGenerator.syncToDatabase();
            }
          }
        } catch (hookError) {
          console.warn('[geminiDriver] post-task hook failed (non-fatal):', hookError?.message ?? hookError);
        }
      }

      return driverResult;
    },
  };
}
