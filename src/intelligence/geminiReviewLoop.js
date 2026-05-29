import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const REVIEW_INTERVAL_MS = 600_000;

function cleanJsonResponse(text) {
  return `${text ?? ''}`.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
}

async function getCommittedOutput(projectPath) {
  const recentCommits = await execFileAsync('git', ['log', '--oneline', '-5'], {
    cwd: projectPath,
    timeout: 60_000,
    maxBuffer: 200_000,
  });
  const headShow = await execFileAsync('git', ['show', 'HEAD'], {
    cwd: projectPath,
    timeout: 60_000,
    maxBuffer: 400_000,
  });

  return `Recent commits:\n${recentCommits.stdout.trim()}\n\nHEAD:\n${headShow.stdout.trim()}`.trim();
}

async function runReviewCycle(pool, geminiClient, logger) {
  if (!config.geminiEnabled) {
    return;
  }

  try {
    await geminiClient.generate({
      model: config.geminiDefaultModel,
      prompt: 'ping',
      retries: 0,
      options: { maxOutputTokens: 10 },
    });
  } catch (error) {
    logger.debug({ err: error }, 'Gemini unavailable, skipping review cycle');
    return;
  }

  const pendingTasksResult = await pool.query(
    `SELECT id, title, description, result
     FROM tasks
     WHERE gemini_review_status = 'pending'
     ORDER BY priority DESC, completed_at ASC
     LIMIT 3`
  );

  for (const task of pendingTasksResult.rows) {
    try {
      const taskDetailsResult = await pool.query(
        `SELECT priority, project_path
         FROM tasks
         WHERE id = $1`,
        [task.id]
      );
      const taskDetails = taskDetailsResult.rows[0] ?? {};
      const committedOutput = taskDetails.project_path
        ? await getCommittedOutput(taskDetails.project_path)
        : 'not available';
      const prompt = [
        'Review this completed task.',
        `Objective: ${task.description ?? ''}`,
        `Committed output (git diff): ${committedOutput || 'not available'}`,
        'Was the objective fully and correctly implemented?',
        "Reply with JSON only: { verdict: 'approved' | 'needs_fix', issues: ['...'] }",
        'If approved, issues must be an empty array.',
      ].join('\n');
      const response = await geminiClient.generate({
        model: config.geminiDefaultModel,
        prompt,
        format: 'json',
        retries: 0,
      });
      const review = JSON.parse(cleanJsonResponse(response.responseText));
      const issues = Array.isArray(review?.issues)
        ? review.issues.map((issue) => `${issue}`).filter(Boolean)
        : [];

      if (review?.verdict === 'approved') {
        await pool.query(
          `UPDATE tasks
           SET gemini_review_status = 'approved'
           WHERE id = $1`,
          [task.id]
        );
      } else if (review?.verdict === 'needs_fix') {
        await pool.query(
          `UPDATE tasks
           SET gemini_review_status = 'needs_fix'
           WHERE id = $1`,
          [task.id]
        );
        await pool.query(
          `INSERT INTO tasks (title, description, source, priority, status)
           VALUES ($1, $2, 'gemini_review', $3, 'pending')`,
          [
            `Fix: ${`${task.title ?? ''}`.slice(0, 75)}`.slice(0, 80),
            `Gemini review found issues with task ${task.id}:\n${issues.join('\n')}`,
            taskDetails.priority ?? 'medium',
          ]
        );
      } else {
        throw new Error(`Unexpected Gemini review verdict: ${review?.verdict ?? 'unknown'}`);
      }

      logger.info({ taskId: task.id, verdict: review.verdict }, 'Gemini review completed');
    } catch (error) {
      logger.error({ err: error, taskId: task.id }, 'Gemini review failed for task');
    }
  }
}

export function startGeminiReviewLoop(pool, geminiClient, logger) {
  const timer = setInterval(() => {
    void runReviewCycle(pool, geminiClient, logger).catch((error) => {
      logger.error({ err: error }, 'Gemini review cycle failed');
    });
  }, REVIEW_INTERVAL_MS);

  return timer;
}
