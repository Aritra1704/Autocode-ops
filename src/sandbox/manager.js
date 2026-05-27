import { exec } from 'node:child_process';
import util from 'node:util';
import pino from 'pino';
import { config } from '../config.js';

const execAsync = util.promisify(exec);
const logger = pino({ name: 'stallone-sandbox' });

/**
 * Executes a terminal command securely.
 * If DOCKER_SANDBOX_ENABLED is true, this routes to a secure container.
 * Otherwise, it falls back to native Mac execution with strict safeguards.
 */
export async function runTerminalCommand({ command, workspaceRoot, timeoutMs = 120000 }) {
  if (config.dockerSandboxEnabled) {
    logger.info({ command }, 'Executing command in Docker Sandbox');
    
    // We use a fresh container for each command to ensure total isolation and auto-cleanup
    // --rm: automatically remove container when done
    // -v: mount the local workspace into the container
    // --memory/--cpus: limit resources so your Mac stays responsive
    // -u: run as the non-root operator user defined in Dockerfile
    const dockerCmd = [
      'docker run --rm',
      `--memory="2g"`,
      `--cpus="2"`,
      `-v "${workspaceRoot}:/workspace"`,
      `-w /workspace`,
      `-u operator`,
      `node:20-slim`, // Fallback to base image if custom build is missing, or use stallone-sandbox
      `bash -c ${JSON.stringify(command)}`
    ].join(' ');

    try {
      const { stdout, stderr } = await execAsync(dockerCmd, { timeout: timeoutMs });
      return {
        output: `${stdout}\n${stderr}`.trim(),
        isError: false,
      };
    } catch (err) {
      // If docker is not running or image missing, provide helpful error
      if (err.message.includes('docker') || err.message.includes('daemon')) {
        logger.error('Docker Sandbox requested but Docker daemon is unreachable.');
        return {
          output: 'ERROR: Docker Sandbox enabled but Docker is not running on your Mac.',
          isError: true,
        };
      }
      return {
        output: `${err.stdout || ''}\n${err.stderr || ''}\nSandbox Failure: ${err.message}`.trim(),
        isError: true,
      };
    }
  }

  // Native execution barrier checks (Fallback path)
  const blockedCommands = ['rm -rf /', 'mkfs', 'dd if=', 'chmod -R 777 /'];
  if (blockedCommands.some(bad => command.includes(bad))) {
    return { output: 'CRITICAL ERROR: Command hit OS Safeguard blocklist.', isError: true };
  }

  logger.warn({ command }, 'Executing unrestricted native terminal command (Sandbox Disabled)');
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 15, // 15MB log constraint
    });
    return {
      output: `${stdout}\n${stderr}`.trim(),
      isError: false,
    };
  } catch (err) {
    return {
      output: `${err.stdout || ''}\n${err.stderr || ''}\nExecution Failed: ${err.message}`.trim(),
      isError: true,
    };
  }
}
