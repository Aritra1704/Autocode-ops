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

const MAX_STEPS = 30;

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
    async runTask(task, context) {
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

      // Build the system prompt
      const systemPrompt = [
        'You are Stallone, an autonomous coding agent.',
        'You work by calling tools in sequence until the task is complete.',
        'Available tools (call as JSON in your response):',
        '  { "tool": "run_ollama", "filePath": "relative/path/to/file.ext", "instruction": "...", "context": "..." }',
        '    filePath must be a path RELATIVE to the workspace root (e.g. "hello.txt", "src/index.js"). Never use an absolute path or a directory.',
        '    → delegates code generation to a local Ollama model',
        '  { "tool": "run_shell", "command": "...", "cwd": "relative/path" }',
        '    cwd is optional, relative to workspace root. command runs in a shell with a 60s timeout.',
        '    → runs a shell command to verify files exist, compile code, or run tests',
        '  { "tool": "ask_human", "question": "...", "context": "..." }',
        '    → parks the task and waits for the human to push a commit',
        '  { "tool": "done", "summary": "..." }',
        '    → marks the task as complete',
        '  { "tool": "fail", "reason": "..." }',
        '    → marks the task as failed',
        '',
        'Rules:',
        '- Call one tool per response.',
        '- After each tool result, decide the next tool.',
        '- Use run_ollama for all file edits and code generation.',
        '- If run_ollama fails, retry immediately with a clearer or simpler instruction. Do NOT skip a file and call done.',
        '- Only call done when EVERY file required by the task has been successfully written (run_ollama returned success for each one). Verify this before calling done.',
        '- After writing all files, use run_shell to verify they exist and that the code compiles. Fix any errors before calling done.',
        '- If run_ollama fails 3 consecutive times for the same file, call fail explaining which file could not be written.',
        '- Use ask_human only when you are genuinely stuck and retrying will not help.',
        '- Never output plain text — always output a JSON tool call.',
      ].join('\n');

      // Build the conversation history
      const messages = [
        {
          role: 'user',
          content: `Task: ${task.title}\n\nDescription: ${task.description}\n\nContext:\n${context}`,
        },
      ];

      // Main loop
      while (stepNumber < MAX_STEPS) {
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
            const tokensUsed =
              (geminiResponse.promptEvalCount ?? 0) + (geminiResponse.evalCount ?? 0);
            if (tokensUsed > 0) budget.add(tokensUsed);
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

        // --- Tool: ask_human ---
        if (toolName === 'ask_human') {
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

      if (stepNumber >= MAX_STEPS && !lastError) {
        lastError = `Reached maximum steps (${MAX_STEPS}) without completing the task`;
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
