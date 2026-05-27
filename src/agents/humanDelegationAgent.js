import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MINUTES = 60;
const POLL_INTERVAL_MS = 30_000;
const GIT_HEAD_ARGS = ['log', '-1', '--format=%H'];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getHeadCommitHash(workspaceRoot) {
  const result = await execFileAsync('git', GIT_HEAD_ARGS, {
    cwd: workspaceRoot,
    maxBuffer: 10 * 1024 * 1024,
  });

  return result.stdout?.trim() ?? '';
}

function buildNotificationMessage(input) {
  return `🛑 Human needed for task ${input.taskId}: ${input.stepDescription}. Push a commit to ${input.workspaceRoot} when done.`;
}

export async function delegateToHuman(input, options = {}) {
  try {
    const timeoutMinutes =
      Number.isFinite(input?.timeoutMinutes) && input.timeoutMinutes > 0
        ? input.timeoutMinutes
        : DEFAULT_TIMEOUT_MINUTES;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startedAt = Date.now();
    const initialHash = await getHeadCommitHash(input.workspaceRoot);
    const message = buildNotificationMessage(input);

    if (typeof options.onNotify === 'function') {
      await options.onNotify(message);
    } else {
      console.log(message);
    }

    while (Date.now() - startedAt < timeoutMs) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(remainingMs, 0)));

      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }

      const currentHash = await getHeadCommitHash(input.workspaceRoot);

      if (currentHash && currentHash !== initialHash) {
        return {
          completed: true,
          timedOut: false,
          newCommitHash: currentHash,
        };
      }
    }

    return {
      completed: false,
      timedOut: true,
      newCommitHash: null,
    };
  } catch {
    return {
      completed: false,
      timedOut: true,
      newCommitHash: null,
    };
  }
}
