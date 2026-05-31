import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from '../config.js';
import { createGeminiClient } from '../llm/providers/gemini.js';
import { runOllamaSubAgent } from './ollamaSubAgent.js';
import { delegateToHuman } from '../agents/humanDelegationAgent.js';
import { computePresenceScore, isHumanOnline } from '../intelligence/onlineDetector.js';
import { createTokenBudget } from '../intelligence/tokenBudget.js';
import { createContextCompactor } from '../context/compactor.js';
import { checkAndEvictIfNeeded } from '../intelligence/modelResourceGuard.js';

const execFileAsync = promisify(execFile);

// Default step budgets by task type. Coordinators (epic/story/task) never
// execute steps directly — they call plan and park. Leaf types get hard limits.
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

// Calls Ollama /api/chat with a full message history and returns the response text.
async function ollamaChat({ model, system, messages, timeoutMs = 300_000 }) {
  const baseUrl = config.ollamaBaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = [{ role: 'system', content: system }, ...messages];

  try {
    await checkAndEvictIfNeeded();

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: payload,
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
    skillManager = null,
  } = options;
  const gemini = geminiClient;

  return {
    async runTask(task, context, options = {}) {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const shortId = task.id?.slice(0, 8) ?? '?';
      // task: { id, title, description, project_path, project_name }
      // context: string  (assembled by loadTaskContext)
      //
      // Returns: { success: boolean, stepsCompleted: number, error: string | null }

      const budget = createTokenBudget(config.geminiTaskTokenBudget ?? 50000);
      const compactor = createContextCompactor(pool);
      const steps = [];
      let stepNumber = 0;
      let lastError = null;
      let usedOllamaFallback = false;
      let taskSucceeded = false;
      let planAlreadyCalled = false;

      // Build the system prompt
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

      // Build the conversation history
      const messages = [
        {
          role: 'user',
          content: `Task: ${task.title}\n\nDescription: ${task.description}\n\nContext:\n${context}`,
        },
      ];

      // Main loop — honour per-task step budget (0 = coordinator, never enters loop)
      const maxSteps = stepBudget > 0 ? stepBudget : 0;
      while (maxSteps > 0 && stepNumber < maxSteps) {
        stepNumber += 1;

        // Check token budget — checkpoint at 70%
        if (budget.isNearLimit()) {
          await compactor.saveCheckpoint(task.id, {
            windowNumber: stepNumber,
            stepsCompleted: steps,
            stepsRemaining: [],
            fileHashes: {},
            keyDecisions: steps.map((s) => s.summary ?? '').filter(Boolean),
            tokensUsed: budget.getUsed(),
          });
          // Continue — compaction is logged, loop goes on
        }

        // Call the orchestrator LLM (Ollama locally, or Gemini if API key is set)
        let responseText;
        try {
          if (config.geminiEnabled) {
            const geminiResponse = await gemini.generate({
              model: config.geminiDefaultModel,
              system: systemPrompt,
              prompt: messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
              format: 'json',
              retries: 1,
            });
            responseText = geminiResponse.responseText;
            const promptTokens = geminiResponse.promptEvalCount ?? 0;
            const outputTokens = geminiResponse.evalCount ?? 0;
            const tokensUsed = promptTokens + outputTokens;
            if (tokensUsed > 0) budget.add(tokensUsed);

            // Persist token usage to agent_logs for cost tracking
            if (tokensUsed > 0) {
              pool.query(
                `INSERT INTO agent_logs (task_id, step_number, step_type, model_used, status, input_summary, output_summary)
                 VALUES ($1, $2, 'llm_call', $3, 'success', $4, $5)`,
                [
                  task.id,
                  stepNumber,
                  config.geminiDefaultModel,
                  String(promptTokens),
                  String(outputTokens),
                ]
              ).catch((err) => {
                // Non-fatal — never let logging break task execution
                console.warn('[geminiDriver] agent_logs insert failed:', err?.message);
              });
            }
          } else {
            // Local-only: use Ollama /api/chat with full conversation history
            responseText = await ollamaChat({
              model: config.ollamaModelOrchestrator,
              system: systemPrompt,
              messages,
            });
          }
        } catch (geminiError) {
          if (config.geminiEnabled) {
            // Gemini failed (rate limit, network, high demand) — fall back to local Ollama for this step
            try {
              usedOllamaFallback = true;
              responseText = await ollamaChat({
                model: config.ollamaModelOrchestrator,
                system: systemPrompt,
                messages,
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

        // Parse the tool call from Gemini's response
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
          steps.push({ step: stepNumber, tool: 'done', summary: toolCall.summary });
          taskSucceeded = true;
          break;
        }

        // --- Tool: fail ---
        if (toolName === 'fail') {
          lastError = toolCall.reason ?? 'Gemini called fail';
          steps.push({ step: stepNumber, tool: 'fail', reason: lastError });
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

          const toolResultMessage = result.success
            ? `run_ollama succeeded. Decision: ${result.decision}. Commit: ${result.commitHash}. Diff:\n${result.diff}`
            : `run_ollama failed after ${result.attempts} attempts: ${result.error}`;

          steps.push({ step: stepNumber, tool: 'run_ollama', success: result.success, summary: toolResultMessage });
          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: toolResultMessage });
          continue;
        }

        // --- Tool: run_shell ---
        if (toolName === 'run_shell') {
          onProgress?.(`⚙️ Step ${stepNumber}: running shell\n\`${(toolCall.command ?? '').slice(0, 120)}\`\nTask: ${task.title} (${shortId})`);
          const shellCwd = path.resolve(task.project_path ?? workspaceRoot, toolCall.cwd ?? '.');
          let toolResultMessage;
          try {
            const { stdout, stderr } = await execFileAsync('sh', ['-c', toolCall.command ?? 'true'], {
              cwd: shellCwd,
              timeout: 60_000,
              maxBuffer: 100_000,
            });
            const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, 3000);
            toolResultMessage = `run_shell succeeded.\n${output || '(no output)'}`;
            steps.push({ step: stepNumber, tool: 'run_shell', success: true });
          } catch (error) {
            const output = [error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, 3000);
            toolResultMessage = `run_shell failed (exit ${error.code ?? 'unknown'}).\n${output || error.message}`;
            steps.push({ step: stepNumber, tool: 'run_shell', success: false });
          }
          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: toolResultMessage });
          continue;
        }

        // --- Tool: plan ---
        if (toolName === 'plan') {
          if (planAlreadyCalled) {
            messages.push({ role: 'assistant', content: responseText });
            messages.push({
              role: 'user',
              content: 'plan already called — you can only plan once.',
            });
            continue;
          }

          planAlreadyCalled = true;

          // Support both new "tasks" format and legacy "phases" format
          const rawItems = Array.isArray(toolCall.tasks)
            ? toolCall.tasks
            : Array.isArray(toolCall.phases)
              ? toolCall.phases.map((p) => ({ ...p, task_type: 'story' }))
              : [];

          const client = await pool.connect();

          // Returns step_budget for a given task_type
          function budgetForType(taskType) {
            return STEP_BUDGET_BY_TYPE[taskType] ?? 15;
          }

          // Recursively inserts a task and its children. Returns the inserted id.
          async function insertTaskTree(itemData, parentId, parentDepth, sequencePreviousId) {
            const title = String(itemData.title ?? '').trim();
            const description = String(itemData.description ?? '').trim();
            const acceptanceCriteria = String(itemData.acceptance_criteria ?? '').trim();
            const taskType = String(itemData.task_type ?? 'subtask').trim();
            const estimatedSteps = itemData.estimated_steps != null ? Number(itemData.estimated_steps) : null;
            const children = Array.isArray(itemData.children) ? itemData.children : [];
            const isParent = children.length > 0;
            const depth = parentDepth + 1;

            // Parent tasks (those with children) wait for their children
            const initialStatus = isParent ? 'waiting_children' : 'pending';
            // Parent tasks are coordinators by nature
            const effectiveType = isParent && !['epic', 'story', 'task', 'coordinator'].includes(taskType)
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

            // Insert children sequentially (each depends on the previous sibling)
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
              if (!item.title) {
                throw new Error('plan task is missing a title');
              }
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
            steps.push({ step: stepNumber, tool: 'plan', success: false, reason: lastError });
            break;
          } finally {
            client.release();
          }
        }

        // --- Tool: ask_human ---
        if (toolName === 'ask_human') {
          onProgress?.(`🙋 Step ${stepNumber}: asking for your input\n${toolCall.question ?? ''}\nTask: ${task.title} (${shortId})`);
          // Check if human is actually online before delegating
          const presence = await computePresenceScore(pool, workspaceRoot).catch(() => ({ score: 0 }));
          const online = isHumanOnline(presence.score);

          if (!online) {
            const skipMessage = `ask_human skipped: human not online (score: ${presence.score.toFixed(2)}). Continuing autonomously.`;
            messages.push({ role: 'assistant', content: responseText });
            messages.push({ role: 'user', content: skipMessage });
            steps.push({ step: stepNumber, tool: 'ask_human', skipped: true, reason: skipMessage });
            continue;
          }

          const delegationResult = await delegateToHuman({
            taskId: task.id,
            stepDescription: toolCall.question,
            workspaceRoot: task.project_path ?? workspaceRoot,
            timeoutMinutes: 60,
          });

          const humanMessage = delegationResult.completed
            ? `Human completed the step. New commit: ${delegationResult.newCommitHash}`
            : `Human delegation timed out after 60 minutes.`;

          steps.push({ step: stepNumber, tool: 'ask_human', completed: delegationResult.completed, summary: humanMessage });
          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: humanMessage });
          continue;
        }

        // Unknown tool
        lastError = `Gemini called unknown tool: ${toolName}`;
        break;
      }

      const hitBudget = maxSteps > 0 && stepNumber >= maxSteps && !taskSucceeded && !lastError;
      if (hitBudget) {
        // Graceful replan — not a hard failure
        const completedSummary = steps.map((s) => s.summary ?? s.tool).filter(Boolean).join('; ');
        return {
          success: false,
          needsReplan: true,
          stepsCompleted: stepNumber,
          error: `Hit step budget (${maxSteps}) without completing the task`,
          completedStepsSummary: completedSummary || 'no steps recorded',
        };
      }

      await pool.query(
        `UPDATE tasks
         SET orchestrator_model = $1,
             gemini_review_status = $2
         WHERE id = $3`,
        [
          usedOllamaFallback ? config.ollamaModelOrchestrator : config.geminiDefaultModel,
          usedOllamaFallback ? 'pending' : null,
          task.id,
        ]
      );

      const driverResult = taskSucceeded
        ? { success: true, stepsCompleted: stepNumber, error: null }
        : {
            success: false,
            stepsCompleted: stepNumber,
            error: lastError ?? 'unknown error',
          };

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
              (left, right) => right.confidenceScore - left.confidenceScore
            )[0]?.category;

            if (topCategory) {
              // Always query DB (which already has current task's learnings persisted) so the
              // cluster includes historical learnings across all tasks, not just this one.
              const generationResult = await skillGenerator.checkAndGenerate(topCategory);

              if (generationResult.generated) {
                await skillGenerator.syncToDatabase();
              }
            }
          }
        } catch (hookError) {
          console.warn(
            '[geminiDriver] post-task hook failed (non-fatal):',
            hookError?.message ?? hookError
          );
        }
      }

      return driverResult;
    },
  };
}
