import { config } from '../config.js';
import { routeFileEdit } from '../agents/fileEditRouter.js';
import { writeFile } from '../agents/fileWriter.js';
import { patchFile } from '../agents/filePatcher.js';
import { verifyAndCommit } from '../agents/gitVerificationAgent.js';

function buildCommitMessage(instruction) {
  const summary = String(instruction ?? '').slice(0, 72).trim();
  return summary ? `feat: ${summary}` : 'feat: update file';
}

export async function runOllamaSubAgent(input) {
  const retries = input?.retries ?? config.ollamaMaxRetries ?? 3;
  const maxAttempts = retries + 1;
  const commitMessage = input?.commitMessage ?? buildCommitMessage(input?.instruction);
  let lastDecision = 'patch';
  let lastDiff = '';
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const routed = await routeFileEdit({
        filePath: input.filePath,
        taskDescription: input.instruction,
        workspaceRoot: input.workspaceRoot,
      });
      const decision = routed?.decision === 'write' ? 'write' : 'patch';
      lastDecision = decision;

      if (decision === 'write') {
        await writeFile({
          filePath: input.filePath,
          taskDescription: input.instruction,
          workspaceRoot: input.workspaceRoot,
          context: input.context,
        });
      } else {
        await patchFile({
          filePath: input.filePath,
          taskDescription: input.instruction,
          workspaceRoot: input.workspaceRoot,
          context: input.context,
        });
      }

      const verification = await verifyAndCommit({
        filePath: input.filePath,
        workspaceRoot: input.workspaceRoot,
        commitMessage,
        taskId: input.taskId,
      });

      lastDiff = verification?.diff ?? '';
      lastError = verification?.error ?? null;

      if (verification?.committed) {
        return {
          success: true,
          decision,
          committed: true,
          commitHash: verification.commitHash ?? null,
          diff: lastDiff,
          error: null,
          attempts: attempt,
        };
      }

      console.error(
        `runOllamaSubAgent attempt ${attempt} failed to commit: ${lastError ?? 'unknown error'}`
      );
    } catch (error) {
      lastError = error?.message ?? 'unknown error';
      lastDiff = '';
      console.error(`runOllamaSubAgent attempt ${attempt} errored: ${lastError}`);
    }
  }

  return {
    success: false,
    decision: lastDecision,
    committed: false,
    commitHash: null,
    diff: lastDiff,
    error: lastError,
    attempts: maxAttempts,
  };
}
