import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
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
      // Nothing staged — check if the file actually exists on disk.
      // If it does, the write succeeded — git just has no new changes to commit.
      // Treat this as success so Gemini does not retry a file that is already written.
      const resolvedPath = path.resolve(input.workspaceRoot, input.filePath);
      try {
        await fs.access(resolvedPath);
        const logResult = await runGit(['log', '-1', '--format=%H'], input.workspaceRoot).catch(() => ({ stdout: null }));
        return {
          verified: true,
          committed: true,
          commitHash: logResult.stdout || null,
          diff,
          error: null,
        };
      } catch {
        return {
          verified: false,
          committed: false,
          commitHash: null,
          diff: '',
          error: 'nothing to commit and file does not exist',
        };
      }
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
