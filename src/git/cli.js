import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from '../config.js';
import {
  collectWorkspaceJunk,
  ensureBaselineGitIgnore,
  removeWorkspaceJunk,
} from '../project/contract.js';

const execFileAsync = promisify(execFile);

async function runGit(args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    });

    return {
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
    };
  } catch (error) {
    const sanitizedStdout = options.sanitize
      ? options.sanitize(error.stdout ?? '')
      : error.stdout ?? '';
    const sanitizedStderr = options.sanitize
      ? options.sanitize(error.stderr ?? '')
      : error.stderr ?? '';
    const sanitizedMessage = options.sanitize
      ? options.sanitize(error.message ?? '')
      : error.message ?? 'Git command failed';

    const wrappedError = new Error(
      [sanitizedMessage, sanitizedStderr || sanitizedStdout].filter(Boolean).join('\n')
    );
    wrappedError.stdout = sanitizedStdout;
    wrappedError.stderr = sanitizedStderr;
    wrappedError.code = error.code;
    throw wrappedError;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalIdentity(cwd, options = {}) {
  const nameFallback = options.name ?? 'Stallone';
  const emailFallback =
    options.email ??
    (config.githubUsername
      ? `${config.githubUsername}@users.noreply.github.com`
      : 'stallone@users.noreply.github.com');

  const currentName = await runGit(['config', '--get', 'user.name'], { cwd }).catch(
    () => ({ stdout: '' })
  );
  const currentEmail = await runGit(['config', '--get', 'user.email'], { cwd }).catch(
    () => ({ stdout: '' })
  );

  if (!currentName.stdout) {
    await runGit(['config', 'user.name', nameFallback], { cwd });
  }

  if (!currentEmail.stdout) {
    await runGit(['config', 'user.email', emailFallback], { cwd });
  }
}

async function createAskPassScript() {
  const scriptPath = path.join(
    os.tmpdir(),
    `stallone-git-askpass-${process.pid}-${Date.now()}.sh`
  );
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s' "$LOCALCLAW_GIT_USERNAME" ;;
  *Password*) printf '%s' "$LOCALCLAW_GIT_TOKEN" ;;
  *) printf '' ;;
esac
`;

  await fs.writeFile(scriptPath, script, { mode: 0o700 });
  return scriptPath;
}

function createTokenSanitizer(token) {
  const patterns = [token];

  const basicToken = Buffer.from(`x-access-token:${token}`).toString('base64');
  patterns.push(basicToken);

  return (value) => {
    let sanitized = value;

    for (const pattern of patterns) {
      if (!pattern) {
        continue;
      }

      sanitized = sanitized.split(pattern).join('[REDACTED]');
    }

    return sanitized;
  };
}

export function createGitClient(options = {}) {
  const defaultBranch = options.defaultBranch ?? config.gitDefaultBranch;

  return {
    async initRepository(cwd, initOptions = {}) {
      const branch = initOptions.branch ?? defaultBranch;
      const gitDir = path.join(cwd, '.git');
      if (!(await pathExists(gitDir))) {
        await runGit(['init'], { cwd });
      }

      await runGit(['branch', '-M', branch], { cwd });
      await ensureLocalIdentity(cwd, options.identity);
    },

    async addAll(cwd) {
      await runGit(['add', '.'], { cwd });
    },

    async hasStagedOrWorkingChanges(cwd) {
      const result = await runGit(['status', '--porcelain'], { cwd });
      return result.stdout.length > 0;
    },

    async commitAll(cwd, message) {
      await ensureBaselineGitIgnore(cwd);
      const removedJunk = await removeWorkspaceJunk(cwd);
      const remainingJunk = await collectWorkspaceJunk(cwd);

      if (remainingJunk.length > 0) {
        throw new Error(
          `Workspace still contains ignored junk paths: ${remainingJunk
            .map((targetPath) => path.relative(cwd, targetPath))
            .join(', ')}`
        );
      }

      await this.addAll(cwd);

      if (removedJunk.length > 0) {
        await runGit(['add', '-A'], { cwd });
      }

      if (!(await this.hasStagedOrWorkingChanges(cwd))) {
        const shaResult = await runGit(['rev-parse', 'HEAD'], { cwd }).catch(() => ({
          stdout: '',
        }));
        return {
          createdCommit: false,
          commitSha: shaResult.stdout || null,
        };
      }

      await runGit(['commit', '-m', message], { cwd });
      const shaResult = await runGit(['rev-parse', 'HEAD'], { cwd });

      return {
        createdCommit: true,
        commitSha: shaResult.stdout,
      };
    },

    async ensureRemote(cwd, name, url) {
      const currentRemote = await runGit(['remote', 'get-url', name], { cwd }).catch(
        () => ({ stdout: '' })
      );

      if (!currentRemote.stdout) {
        await runGit(['remote', 'add', name, url], { cwd });
        return;
      }

      if (currentRemote.stdout !== url) {
        await runGit(['remote', 'set-url', name, url], { cwd });
      }
    },

    async pushBranch(cwd, options) {
      const {
        remoteName = 'origin',
        branch = defaultBranch,
        token,
        username = config.githubUsername || 'x-access-token',
      } = options;
      const args = ['push', '-u', remoteName, branch];
      const autoMergeArgs = [
        'pull',
        '--no-rebase',
        '--no-edit',
        '--allow-unrelated-histories',
        '-X',
        'ours',
        remoteName,
        branch,
      ];

      if (!token) {
        await runGit(args, { cwd });
        return;
      }

      const askPassScript = await createAskPassScript();
      const sanitize = createTokenSanitizer(token);
      const authEnv = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: askPassScript,
        LOCALCLAW_GIT_USERNAME: username,
        LOCALCLAW_GIT_TOKEN: token,
      };

      try {
        try {
          await runGit(args, {
            cwd,
            sanitize,
            env: authEnv,
          });
        } catch (error) {
          const details = `${error.message}\n${error.stderr ?? ''}\n${error.stdout ?? ''}`;
          const isNonFastForward =
            details.includes('fetch first') ||
            details.includes('non-fast-forward') ||
            details.includes('failed to push some refs');

          if (!isNonFastForward) {
            throw error;
          }

          await runGit(autoMergeArgs, {
            cwd,
            sanitize,
            env: authEnv,
          });

          await runGit(args, {
            cwd,
            sanitize,
            env: authEnv,
          });
        }
      } finally {
        await fs.unlink(askPassScript).catch(() => {});
      }
    },
  };
}
