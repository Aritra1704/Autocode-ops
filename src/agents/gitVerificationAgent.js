import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export async function verifyAndCommit(input) {
  let diff = '';

  try {
    const diffResult = await runGit(['diff', 'HEAD', '--', input.filePath], input.workspaceRoot);
    diff = diffResult.stdout.slice(0, 8000);
  } catch (error) {
    return {
      verified: false,
      committed: false,
      commitHash: null,
      diff,
      error: error?.message ?? 'git diff failed',
    };
  }

  try {
    await runGit(['add', input.filePath], input.workspaceRoot);

    const stagedResult = await runGit(['diff', '--staged', '--stat'], input.workspaceRoot);
    if (!stagedResult.stdout) {
      return {
        verified: false,
        committed: false,
        commitHash: null,
        diff: '',
        error: 'nothing to commit',
      };
    }

    await runGit(['commit', '-m', input.commitMessage], input.workspaceRoot);
    const logResult = await runGit(['log', '-1', '--format=%H'], input.workspaceRoot);

    return {
      verified: true,
      committed: true,
      commitHash: logResult.stdout || null,
      diff,
      error: null,
    };
  } catch (error) {
    return {
      verified: false,
      committed: false,
      commitHash: null,
      diff,
      error: error?.message ?? 'git verification failed',
    };
  }
}
