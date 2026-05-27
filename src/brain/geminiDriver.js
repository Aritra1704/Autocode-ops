import { config } from '../config.js';
import { createGeminiClient } from '../llm/providers/gemini.js';
import { runOllamaSubAgent } from './ollamaSubAgent.js';
import { delegateToHuman } from '../agents/humanDelegationAgent.js';
import { computePresenceScore, isHumanOnline } from '../intelligence/onlineDetector.js';
import { createTokenBudget } from '../intelligence/tokenBudget.js';
import { createContextCompactor } from '../context/compactor.js';

const MAX_STEPS = 30;

export function createGeminiDriver(pool, options = {}) {
  const gemini = options.geminiClient ?? createGeminiClient();
  const workspaceRoot = options.workspaceRoot ?? config.stalloneWorkspaceRoot ?? process.cwd();

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

      // Build the system prompt
      const systemPrompt = [
        'You are Stallone, an autonomous coding agent.',
        'You work by calling tools in sequence until the task is complete.',
        'Available tools (call as JSON in your response):',
        '  { "tool": "run_ollama", "filePath": "...", "instruction": "...", "context": "..." }',
        '    → delegates code generation to a local Ollama model',
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
        '- Use ask_human only when you are genuinely stuck.',
        '- Call done when all steps in the task are complete.',
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

        // Call Gemini
        let responseText;
        try {
          const geminiResponse = await gemini.generate({
            model: config.geminiDefaultModel,
            system: systemPrompt,
            prompt: messages[messages.length - 1].content,
            format: 'json',
            retries: 1,
          });
          responseText = geminiResponse.responseText;

          // Track tokens
          const tokensUsed =
            (geminiResponse.promptEvalCount ?? 0) + (geminiResponse.evalCount ?? 0);
          if (tokensUsed > 0) budget.add(tokensUsed);
        } catch (error) {
          lastError = error?.message ?? 'Gemini call failed';
          break;
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
          return { success: true, stepsCompleted: stepNumber, error: null };
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

      return {
        success: false,
        stepsCompleted: stepNumber,
        error: lastError ?? 'unknown error',
      };
    },
  };
}
