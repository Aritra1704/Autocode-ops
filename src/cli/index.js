import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse as parseEnv } from 'dotenv';

import { deriveExecutionControl, normalizeTaskContract } from '../control/taskContract.js';

const execFileAsync = promisify(execFile);
const cliModuleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(cliModuleDir, '../..');

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      const key = raw.slice(0, separator);
      const value = raw.slice(separator + 1);
      options[key] = value;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[raw] = next;
      index += 1;
      continue;
    }

    options[raw] = true;
  }

  return { positionals, options };
}

function usage() {
  return [
    'Stallone CLI',
    '',
    'Commands:',
    '  stallone status',
    '  stallone doctor',
    '  stallone tasks [--limit 20]',
    '  stallone approvals [--limit 20]',
    '  stallone skills [--limit 20] [--include-disabled]',
    '  stallone ops hybrid-check',
    '  stallone ops prune-memory [--max-rows 200]',
    '  stallone projects list',
    '  stallone projects add <path> [--name <name>] [--github-owner <owner>] [--github-repo <repo>]',
    '  stallone chat [--project <path>] [--actor architect]',
    '  stallone pause [reason]',
    '  stallone resume',
    '  stallone approve <approval-id>',
    '  stallone reject <approval-id> [reason]',
    '  stallone task init [--file stallone.task.json]',
    '  stallone task plan --file <contract.json>',
    '  stallone task run --file <contract.json> [--approve]',
    '  stallone task approve <task-id>',
    '  stallone task reject <task-id> [reason]',
    '',
    'Global options:',
    '  --host 127.0.0.1',
    '  --port 4173',
    '  --token <CONTROL_API_TOKEN>',
  ].join('\n');
}

function templateContract() {
  return {
    version: 'task_contract_v1',
    projectName: 'safe-commit',
    objective:
      'Implement the requested feature with tests and keep it local unless publish or deploy is explicitly requested.',
    inScope: ['Update source code', 'Add or update tests', 'Update docs if behavior changes'],
    outOfScope: ['Infrastructure migration', 'Unrelated refactors'],
    constraints: ['Use existing architecture', 'Do not publish or deploy unless explicitly requested'],
    successCriteria: ['Tests pass', 'Changes are reviewable and production-safe'],
    priority: 'medium',
    skillHints: [],
    executionPolicy: 'external_only',
    repoIntent: {
      publish: false,
      deploy: false,
    },
    notes: 'Optional operator notes',
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findNearestEnv(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, '.env');
    if (await fileExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function readEnvFile(filePath) {
  if (!filePath || !(await fileExists(filePath))) {
    return {};
  }

  return parseEnv(await fs.readFile(filePath));
}

async function readHomeConfig(homeDir) {
  const configPath = path.join(homeDir, '.stallone', 'config.json');
  if (!(await fileExists(configPath))) {
    return {};
  }

  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}

async function resolveCliConfig(options, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const nearestEnvPath = await findNearestEnv(cwd);
  const repoEnvPath = path.join(repoRoot, '.env');
  const homeConfig = await readHomeConfig(deps.homeDir ?? os.homedir()).catch(() => ({}));
  const repoEnv = await readEnvFile(repoEnvPath);
  const nearestEnv = await readEnvFile(nearestEnvPath);

  const merged = {
    ...homeConfig,
    ...repoEnv,
    ...nearestEnv,
    ...process.env,
  };

  return {
    host: options.host ?? merged.CONTROL_API_HOST ?? '127.0.0.1',
    port: options.port ?? merged.CONTROL_API_PORT ?? '4173',
    token: options.token ?? merged.CONTROL_API_TOKEN ?? '',
    ollamaBaseUrl: options.ollamaBaseUrl ?? merged.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    envPath: nearestEnvPath ?? ((await fileExists(repoEnvPath)) ? repoEnvPath : null),
    loadedTokenFromEnv: Boolean(options.token ?? merged.CONTROL_API_TOKEN),
  };
}

function resolveBaseUrl(cliConfig) {
  const host = cliConfig.host ?? '127.0.0.1';
  const port = cliConfig.port ?? '4173';
  return `http://${host}:${port}`;
}

function resolveWaitMs(options) {
  const rawValue = options['wait-ms'] ?? process.env.CONTROL_API_WAIT_MS ?? '30000';
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30000;
  }

  return Math.min(parsed, 300000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makePrinter(io) {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;

  return {
    out(message) {
      stdout.write(`${message}\n`);
    },
    err(message) {
      stderr.write(`${message}\n`);
    },
  };
}

function formatPlanOutput(plan) {
  const lines = [];
  const summary = typeof plan?.summary === 'string' ? plan.summary.trim() : '';
  if (summary) {
    lines.push(`Plan: ${summary}`);
  }

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length > 0) {
    lines.push('Steps:');
    for (const step of steps) {
      const stepNumber = step?.stepNumber ?? '?';
      const objective = `${step?.objective ?? 'No objective'}`.trim();
      const tool = `${step?.tool ?? 'unspecified'}`.trim();
      lines.push(`${stepNumber}. ${objective} [${tool}]`);
    }
  }

  return lines.join('\n');
}

function formatProviderSummary(status = {}) {
  const providers = status?.llmRuntime?.providers ?? {};
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    return 'none';
  }

  return entries
    .map(([name, provider]) => {
      const state = provider?.configured
        ? provider?.ok
          ? 'ok'
          : provider?.disabled
            ? 'disabled'
            : 'degraded'
        : 'not-configured';
      const missing =
        Array.isArray(provider?.missingModels) && provider.missingModels.length > 0
          ? ` missing=${provider.missingModels.join(',')}`
          : '';
      return `${name}=${state}${missing}`;
    })
    .join(' | ');
}

function formatMemoryRetentionSummary(status = {}) {
  const retention = status?.memoryRetention ?? {};
  const counts = retention.counts ?? {};
  const policy = retention.policy ?? {};

  return [
    `enabled=${policy.enabled === false ? 'no' : 'yes'}`,
    `active=${counts.active_count ?? 0}`,
    `expired=${counts.expired_count ?? 0}`,
    `archived=${counts.archived_count ?? 0}`,
    `last_run=${retention.lastRun?.updatedAt ?? 'never'}`,
  ].join(' | ');
}

function formatTaskProgressOutput(taskDetail) {
  const task = taskDetail?.task ?? {};
  const runtime = taskDetail?.runtime ?? {};
  const lines = [
    `[task ${task.id}] ${task.status ?? 'unknown'} | ${runtime.phaseLabel ?? runtime.phase ?? 'unknown'}`,
  ];

  if (runtime.currentStep?.objective) {
    lines.push(`Step: ${runtime.currentStep.objective} [${runtime.currentStep.tool ?? 'unspecified'}]`);
  }

  if (runtime.detail) {
    lines.push(`Detail: ${runtime.detail}`);
  }

  if (task.status === 'blocked' || task.status === 'failed') {
    const reason = task.blocked_reason || runtime.detail;
    if (reason) {
      lines.push(`Reason: ${reason}`);
    }
  }

  if (
    task.status === 'waiting_approval' &&
    task.result?.publication?.published === true &&
    task.repo_url
  ) {
    lines.push(`Repo: ${task.repo_url}`);
  }

  return lines.join('\n');
}

function formatTaskHeartbeatOutput(taskDetail) {
  const task = taskDetail?.task ?? {};
  const runtime = taskDetail?.runtime ?? {};
  const stepObjective = `${runtime.currentStep?.objective ?? ''}`.trim();
  let phrase = 'still working...';

  if (task.status === 'pending' || runtime.phase === 'queued') {
    phrase = 'still queued... waiting for an executor slot.';
  } else if (runtime.phase === 'preparing') {
    phrase = 'still preparing the workspace...';
  } else if (runtime.phase === 'planning') {
    phrase = 'still planning the task...';
  } else if (runtime.phase === 'acting') {
    phrase = stepObjective
      ? `still working... ${stepObjective}.`
      : 'still executing the plan...';
  } else if (runtime.phase === 'verifying') {
    phrase = 'still verifying the result...';
  } else if (runtime.detail) {
    phrase = `still working... ${runtime.detail}`;
  }

  return `[task ${task.id}] ${phrase}`;
}

function taskWatchSignature(taskDetail) {
  return JSON.stringify({
    status: taskDetail?.task?.status ?? null,
    approvalStatus: taskDetail?.task?.result?.preExecutionPlan?.status ?? null,
    runtimePhase: taskDetail?.runtime?.phase ?? null,
    runtimeDetail: taskDetail?.runtime?.detail ?? null,
    currentStep: taskDetail?.runtime?.currentStep?.stepNumber ?? null,
    blockedReason: taskDetail?.task?.blocked_reason ?? null,
    repoUrl: taskDetail?.task?.repo_url ?? null,
  });
}

function shouldStopWatchingTask(taskDetail) {
  const status = taskDetail?.task?.status;
  const executionApprovalStatus = taskDetail?.task?.result?.preExecutionPlan?.status ?? null;
  const publishWaiting =
    status === 'waiting_approval' && taskDetail?.task?.result?.publication?.published === true;

  if (status === 'done' || status === 'failed' || status === 'blocked') {
    return true;
  }

  if (publishWaiting) {
    return true;
  }

  if (status === 'waiting_approval' && executionApprovalStatus === 'pending') {
    return true;
  }

  return false;
}

async function reconcileLocalAutoStartPlan({
  plan,
  fetchImpl,
  baseUrl,
  waitMs,
  sleepImpl,
}) {
  if (!plan?.task?.id) {
    return plan;
  }

  if (plan.executionApproval?.status === 'approved') {
    return plan;
  }

  if (plan.execution?.executionClass !== 'local_only' || plan.execution?.approvalRequired === true) {
    return plan;
  }

  const detail = await requestJson({
    fetchImpl,
    baseUrl,
    pathName: `/v1/tasks/${plan.task.id}`,
    waitMs,
    sleepImpl,
  });

  const liveTask = detail?.task ?? null;
  const liveApprovalStatus = liveTask?.result?.preExecutionPlan?.status ?? null;
  const autoStarted =
    liveApprovalStatus === 'approved' || (liveTask?.status && liveTask.status !== 'waiting_approval');

  if (!liveTask || !autoStarted) {
    return plan;
  }

  return {
    ...plan,
    task: {
      ...plan.task,
      ...liveTask,
      status: liveTask.status ?? plan.task.status,
    },
    executionApproval: {
      ...(plan.executionApproval ?? {}),
      task_id: plan.task.id,
      status: 'approved',
      approvalRequired: false,
      autoStarted: true,
    },
  };
}

async function watchTaskProgress({
  taskId,
  logger,
  fetchImpl,
  baseUrl,
  waitMs,
  sleepImpl,
}) {
  let previousSignature = null;
  let unchangedPolls = 0;

  while (true) {
    const detail = await requestJson({
      fetchImpl,
      baseUrl,
      pathName: `/v1/tasks/${taskId}`,
      waitMs,
      sleepImpl,
    });

    const signature = taskWatchSignature(detail);
    if (signature !== previousSignature) {
      logger.out(formatTaskProgressOutput(detail));
      previousSignature = signature;
      unchangedPolls = 0;
    } else {
      unchangedPolls += 1;
      if (unchangedPolls >= 2 && !shouldStopWatchingTask(detail)) {
        logger.out(formatTaskHeartbeatOutput(detail));
        unchangedPolls = 0;
      }
    }

    if (shouldStopWatchingTask(detail)) {
      return detail;
    }

    await sleepImpl(2000);
  }
}

function shouldRetryFetch(error) {
  const code = error?.cause?.code;
  return (
    error?.name === 'TypeError' ||
    error?.message === 'fetch failed' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH'
  );
}

async function fetchWithStartupRetry({
  fetchImpl,
  url,
  options,
  waitMs,
  sleepImpl,
  baseUrl,
}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt <= waitMs) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      if (!shouldRetryFetch(error)) {
        throw error;
      }

      lastError = error;
      await sleepImpl(1000);
    }
  }

  throw new Error(
    `Control API is not reachable at ${baseUrl}. Confirm Stallone is running and /health returns ok. Last error: ${lastError?.message ?? 'unknown'}`
  );
}

async function waitForControlApi({ fetchImpl, baseUrl, waitMs, sleepImpl }) {
  const response = await fetchWithStartupRetry({
    fetchImpl,
    url: `${baseUrl}/health`,
    options: { method: 'GET' },
    waitMs,
    sleepImpl,
    baseUrl,
  });

  if (!response.ok) {
    throw new Error(`Control API health check failed: ${response.status} ${response.statusText}`);
  }
}

async function requestJson({
  fetchImpl,
  baseUrl,
  pathName,
  method = 'GET',
  token = '',
  body,
  waitMs = 30000,
  sleepImpl = sleep,
}) {
  const headers = {
    'content-type': 'application/json',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    await waitForControlApi({ fetchImpl, baseUrl, waitMs, sleepImpl });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetchWithStartupRetry({
    fetchImpl,
    url: `${baseUrl}${pathName}`,
    options: {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    },
    waitMs,
    sleepImpl,
    baseUrl,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message ?? `${response.status} ${response.statusText}`);
  }

  return payload.data;
}

async function requestHealth({ fetchImpl, baseUrl, waitMs, sleepImpl }) {
  const response = await fetchWithStartupRetry({
    fetchImpl,
    url: `${baseUrl}/health`,
    options: { method: 'GET' },
    waitMs,
    sleepImpl,
    baseUrl,
  });

  return {
    ok: response.ok,
    status: response.status,
  };
}

async function readContractFromFile(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return normalizeTaskContract(JSON.parse(content));
}

function ensureArg(value, message) {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

export async function runCli(argv, io = {}, deps = {}) {
  const { positionals, options } = parseArgs(argv);
  const logger = makePrinter(io);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    logger.err('Global fetch is not available in this runtime.');
    return 1;
  }

  const cliConfig = await resolveCliConfig(options, deps);
  const baseUrl = resolveBaseUrl(cliConfig);
  const token = cliConfig.token;
  const waitMs = resolveWaitMs(options);
  const sleepImpl = deps.sleepImpl ?? sleep;
  const execFileImpl = deps.execFileImpl ?? execFileAsync;

  const command = positionals[0];

  try {
    if (!command || command === 'help' || command === '--help') {
      logger.out(usage());
      return 0;
    }

    if (command === 'doctor') {
      const checks = [];

      checks.push({
        name: '.env',
        ok: Boolean(cliConfig.envPath),
        detail: cliConfig.envPath ?? 'not found',
      });
      checks.push({
        name: 'control token',
        ok: Boolean(token),
        detail: token ? 'present' : 'missing',
      });

      try {
        const health = await requestHealth({ fetchImpl, baseUrl, waitMs, sleepImpl });
        checks.push({
          name: 'control API health',
          ok: health.ok,
          detail: `${baseUrl}/health -> ${health.status}`,
        });
      } catch (error) {
        checks.push({
          name: 'control API health',
          ok: false,
          detail: error.message,
        });
      }

      try {
        const status = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/status',
          waitMs,
          sleepImpl,
        });
        checks.push({
          name: 'database/status',
          ok: true,
          detail: `boot=${status.bootPhase}, polling=${status.pollingActive ? 'yes' : 'no'}, planner=${status.llmRuntime?.mode ?? 'local'}`,
        });
        checks.push({
          name: 'providers',
          ok: Object.values(status.llmRuntime?.providers ?? {}).every(
            (provider) => provider?.configured !== true || provider?.ok === true || provider?.disabled === true
          ),
          detail: formatProviderSummary(status),
        });
        checks.push({
          name: 'memory retention',
          ok: true,
          detail: formatMemoryRetentionSummary(status),
        });
      } catch (error) {
        checks.push({
          name: 'database/status',
          ok: false,
          detail: error.message,
        });
        checks.push({
          name: 'providers',
          ok: false,
          detail: 'status unavailable',
        });
        checks.push({
          name: 'memory retention',
          ok: false,
          detail: 'status unavailable',
        });
      }

      try {
        const response = await fetchImpl(`${cliConfig.ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`);
        checks.push({
          name: 'ollama',
          ok: response.ok,
          detail: `${response.status}`,
        });
      } catch (error) {
        checks.push({
          name: 'ollama',
          ok: false,
          detail: error.message,
        });
      }

      try {
        const result = await execFileImpl('pm2', ['jlist']);
        const processes = JSON.parse(result.stdout || '[]');
        const stallone = processes.find((processInfo) => processInfo.name === 'stallone');
        checks.push({
          name: 'pm2',
          ok: Boolean(stallone),
          detail: stallone ? `stallone=${stallone.pm2_env?.status ?? 'unknown'}` : 'stallone not found',
        });
      } catch (error) {
        checks.push({
          name: 'pm2',
          ok: false,
          detail: `optional check failed: ${error.message}`,
        });
      }

      logger.out(
        checks
          .map((check) => `${check.ok ? 'OK ' : 'FAIL'} ${check.name}: ${check.detail}`)
          .join('\n')
      );
      return checks.some((check) => !check.ok && check.name !== 'pm2') ? 1 : 0;
    }

    if (command === 'status') {
      const status = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/status',
        waitMs,
        sleepImpl,
      });
      logger.out(
        [
          `Status: ${status.status}`,
          `Boot phase: ${status.bootPhase}`,
          `Polling active: ${status.pollingActive ? 'yes' : 'no'}`,
          `Planner mode: ${status.llmRuntime?.mode ?? 'local'}`,
          `Providers: ${formatProviderSummary(status)}`,
          `Graph backend: ${status.graphRuntime?.backend ?? 'native'}`,
          `Memory retention: ${formatMemoryRetentionSummary(status)}`,
          `Pending: ${status.queue.pending_count}`,
          `In progress: ${status.queue.in_progress_count}`,
          `Blocked: ${status.queue.blocked_count}`,
          `Waiting approval: ${status.queue.waiting_approval_count}`,
          `Current task: ${status.currentTask?.title ?? 'none'}`,
        ].join('\n')
      );
      return 0;
    }

    if (command === 'tasks') {
      const limit = Number(options.limit ?? 20);
      const tasks = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/tasks?limit=${Number.isInteger(limit) ? limit : 20}`,
        waitMs,
        sleepImpl,
      });

      if (tasks.length === 0) {
        logger.out('No active tasks.');
        return 0;
      }

      logger.out(
        tasks
          .map((task) => `${task.id} | ${task.status} | ${task.priority} | ${task.title}`)
          .join('\n')
      );
      return 0;
    }

    if (command === 'approvals') {
      const limit = Number(options.limit ?? 20);
      const approvals = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals?limit=${Number.isInteger(limit) ? limit : 20}`,
        waitMs,
        sleepImpl,
      });

      if (approvals.length === 0) {
        logger.out('No pending deploy approvals.');
        return 0;
      }

      logger.out(
        approvals
          .map((approval) => `${approval.id} | ${approval.task_title} | ${approval.target_env}`)
          .join('\n')
      );
      return 0;
    }

    if (command === 'skills') {
      const includeDisabled =
        options['include-disabled'] === true || options.includeDisabled === 'true';
      const limit = Number(options.limit ?? 20);
      const skills = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/skills?limit=${Number.isInteger(limit) ? limit : 20}&includeDisabled=${includeDisabled}`,
        waitMs,
        sleepImpl,
      });

      if (skills.length === 0) {
        logger.out('No registered skills.');
        return 0;
      }

      logger.out(
        skills
          .map(
            (skill) =>
              `${skill.name} (v${skill.version}) | enabled=${skill.is_enabled ? 'yes' : 'no'} | runs=${skill.total_runs}`
          )
          .join('\n')
      );
      return 0;
    }

    if (command === 'ops') {
      const subcommand = positionals[1];

      if (subcommand === 'hybrid-check') {
        const status = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/status',
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Planner mode: ${status.llmRuntime?.mode ?? 'local'}`,
            `Providers: ${formatProviderSummary(status)}`,
            `Graph backend: ${status.graphRuntime?.backend ?? 'native'}`,
            `Graphify index: ${status.graphRuntime?.graphifyIndexPath ?? 'n/a'}`,
            `Selected models: ${Object.entries(status.llmRuntime?.selectedModels ?? {})
              .map(([role, model]) => `${role}=${model}`)
              .join(' | ') || 'none'}`,
            `Memory retention: ${formatMemoryRetentionSummary(status)}`,
            `Current task: ${status.currentTask?.title ?? 'none'}`,
          ].join('\n')
        );
        return 0;
      }

      if (subcommand === 'prune-memory') {
        const maxRows = Number(options['max-rows'] ?? options.maxRows ?? 0);
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/maintenance/prune-memory',
          method: 'POST',
          token,
          body: Number.isInteger(maxRows) && maxRows > 0 ? { maxRows } : {},
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Memory prune completed at ${response.updatedAt ?? 'unknown'}`,
            `Archived: ${response.archivedCount ?? 0}`,
            `Expired: ${response.expiredCount ?? 0}`,
            `Deleted: ${response.deletedCount ?? 0}`,
            response.counts
              ? `Counts: active=${response.counts.active_count ?? 0} expired=${response.counts.expired_count ?? 0} archived=${response.counts.archived_count ?? 0} total=${response.counts.total_count ?? 0}`
              : null,
          ]
            .filter(Boolean)
            .join('\n')
        );
        return 0;
      }

      throw new Error('Unknown ops subcommand. Use: hybrid-check | prune-memory');
    }

    if (command === 'projects') {
      const subcommand = positionals[1] ?? 'list';

      if (subcommand === 'list') {
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/projects',
          waitMs,
          sleepImpl,
        });

        const projects = response.projects ?? [];
        const roots = response.allowedRoots ?? [];
        logger.out(
          [
            `Allowed roots: ${roots.length > 0 ? roots.join(', ') : 'none'}`,
            projects.length === 0
              ? 'No project targets.'
              : projects.map((project) => `${project.id} | ${project.name} | ${project.root_path}`).join('\n'),
          ].join('\n')
        );
        return 0;
      }

      if (subcommand === 'add') {
        const rootPath = ensureArg(positionals[2], 'Usage: stallone projects add <path> [--name <name>]');
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/projects',
          method: 'POST',
          token,
          body: {
            rootPath,
            name: options.name,
            githubRepoOwner: options['github-owner'],
            githubRepoName: options['github-repo'],
            railwayProjectId: options['railway-project-id'],
            railwayEnvironmentId: options['railway-environment-id'],
            railwayServiceId: options['railway-service-id'],
            railwayServiceName: options['railway-service-name'],
            browserAllowedOrigins:
              typeof options['browser-origins'] === 'string'
                ? options['browser-origins']
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean)
                : undefined,
          },
          waitMs,
          sleepImpl,
        });
        logger.out(`Project added: ${response.name} | ${response.root_path}`);
        return 0;
      }

      throw new Error('Unknown projects subcommand. Use: list | add');
    }

    if (command === 'chat') {
      const session = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/chat/sessions',
        method: 'POST',
        token,
        body: {
          title: options.title ?? 'Stallone chat',
          actor: options.actor ?? 'architect',
          projectPath: options.project,
        },
        waitMs,
        sleepImpl,
      });

      logger.out(`Chat session: ${session.id}`);
      logger.out(`Actor: ${session.actor}`);
      if (session.project_path) {
        logger.out(`Project: ${session.project_path}`);
      }
      logger.out(
        'Type /exit to quit, /draft <objective> to draft a task, /plan <objective> to create and run a task, and /status [task-id] to inspect progress.'
      );

      const input = deps.input ?? process.stdin;
      const output = deps.output ?? process.stdout;
      const rl = readline.createInterface({ input, output });
      let lastPlannedTaskId = null;

      try {
        while (true) {
          let line;
          try {
            line = (await rl.question('stallone> ')).trim();
          } catch (error) {
            if (error?.message === 'readline was closed' || error?.code === 'ERR_USE_AFTER_CLOSE') {
              break;
            }
            throw error;
          }
          if (!line || line === '/exit' || line === '/quit') {
            break;
          }

          if (line.startsWith('/draft')) {
            const objective = line.slice('/draft'.length).trim();
            const draft = await requestJson({
              fetchImpl,
              baseUrl,
              pathName: `/v1/chat/sessions/${session.id}/draft-task`,
              method: 'POST',
              token,
              body: objective ? { objective } : {},
              waitMs,
              sleepImpl,
            });
            logger.out(JSON.stringify(draft.contract, null, 2));
            continue;
          }

          if (line.startsWith('/plan')) {
            const objective = line.slice('/plan'.length).trim();
            let plan = await requestJson({
              fetchImpl,
              baseUrl,
              pathName: `/v1/chat/sessions/${session.id}/plan-task`,
              method: 'POST',
              token,
              body: objective ? { objective } : {},
              waitMs,
              sleepImpl,
            });
            plan = await reconcileLocalAutoStartPlan({
              plan,
              fetchImpl,
              baseUrl,
              waitMs,
              sleepImpl,
            });
            logger.out(`Task: ${plan.task.id}`);
            logger.out(`Status: ${plan.task.status}`);
            logger.out(formatPlanOutput(plan.plan));
            lastPlannedTaskId = plan.task.id;
            if (plan.executionApproval?.status === 'approved') {
              logger.out('Execution started automatically.');
              logger.out('Watching task progress...');
              await watchTaskProgress({
                taskId: plan.task.id,
                logger,
                fetchImpl,
                baseUrl,
                waitMs,
                sleepImpl,
              });
              continue;
            }
            if (plan.executionApproval?.status === 'pending' || plan.task.status === 'waiting_approval') {
              logger.out('Execution is waiting for approval. Use /approve or reply yes in chat.');
            } else {
              logger.out('Execution has been queued. Use /status to inspect progress.');
            }
            continue;
          }

          if (line.startsWith('/approve')) {
            const requestedTaskId = line.slice('/approve'.length).trim();
            let taskId = requestedTaskId || lastPlannedTaskId;

            if (!taskId) {
              const sessionDetail = await requestJson({
                fetchImpl,
                baseUrl,
                pathName: `/v1/chat/sessions/${session.id}`,
                waitMs,
                sleepImpl,
              });
              taskId =
                sessionDetail.tasks?.find((task) => task.status === 'waiting_approval')?.id ?? null;
            }

            taskId = ensureArg(
              taskId,
              'No task is ready to approve in this session. Use /plan first or pass /approve <task-id>.'
            );

            const approval = await requestJson({
              fetchImpl,
              baseUrl,
              pathName: `/v1/chat/sessions/${session.id}/approve-task`,
              method: 'POST',
              token,
              body: { taskId },
              waitMs,
              sleepImpl,
            });

            logger.out(`Execution approved: ${approval.task_id}`);
            lastPlannedTaskId = approval.task_id;
            logger.out('Watching task progress...');
            await watchTaskProgress({
              taskId: approval.task_id,
              logger,
              fetchImpl,
              baseUrl,
              waitMs,
              sleepImpl,
            });
            continue;
          }

          if (line.startsWith('/status')) {
            const requestedTaskId = line.slice('/status'.length).trim();
            const taskId = ensureArg(
              requestedTaskId || lastPlannedTaskId,
              'No task selected. Use /status <task-id> or create a plan first.'
            );

            const detail = await requestJson({
              fetchImpl,
              baseUrl,
              pathName: `/v1/tasks/${taskId}`,
              waitMs,
              sleepImpl,
            });
            logger.out(formatTaskProgressOutput(detail));
            continue;
          }

          const response = await requestJson({
            fetchImpl,
            baseUrl,
            pathName: `/v1/chat/sessions/${session.id}/messages`,
            method: 'POST',
            token,
            body: {
              content: line,
              actor: options.actor,
            },
            waitMs,
            sleepImpl,
          });
          logger.out(`\n\x1b[1;32mStallone\x1b[0m\n${response.assistant.content}\n`);
          const assistantMetadata = response.assistant?.metadata ?? {};
          const approvedTaskId = assistantMetadata.executionApproval?.task_id ?? null;
          const plannedTaskId = assistantMetadata.taskId ?? null;

          if (plannedTaskId) {
            lastPlannedTaskId = plannedTaskId;
          }

          if (
            assistantMetadata.executionPending === true &&
            plannedTaskId &&
            assistantMetadata.executionApproval?.status !== 'approved'
          ) {
            logger.out(`Task: ${plannedTaskId}`);
            if (assistantMetadata.taskStatus) {
              logger.out(`Status: ${assistantMetadata.taskStatus}`);
            }
            if (assistantMetadata.plan) {
              logger.out(formatPlanOutput(assistantMetadata.plan));
            }
            logger.out('Execution has been queued. Use /status to inspect progress.');
          }

          if (approvedTaskId) {
            lastPlannedTaskId = approvedTaskId;
            logger.out('Watching task progress...');
            await watchTaskProgress({
              taskId: approvedTaskId,
              logger,
              fetchImpl,
              baseUrl,
              waitMs,
              sleepImpl,
            });
          }
        }
      } finally {
        rl.close();
      }

      return 0;
    }

    if (command === 'pause') {
      const reason = positionals.slice(1).join(' ').trim() || 'Paused via CLI';
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/pause',
        method: 'POST',
        token,
        body: { reason },
        waitMs,
        sleepImpl,
      });
      logger.out(`Paused: ${response.reason}`);
      return 0;
    }

    if (command === 'resume') {
      await requestJson({
        fetchImpl,
        baseUrl,
        pathName: '/v1/resume',
        method: 'POST',
        token,
        waitMs,
        sleepImpl,
      });
      logger.out('Resumed.');
      return 0;
    }

    if (command === 'approve') {
      const approvalId = ensureArg(positionals[1], 'Usage: stallone approve <approval-id>');
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals/${approvalId}/approve`,
        method: 'POST',
        token,
        waitMs,
        sleepImpl,
      });
      logger.out(`Approved deploy: ${response.id}`);
      return 0;
    }

    if (command === 'reject') {
      const approvalId = ensureArg(positionals[1], 'Usage: stallone reject <approval-id> [reason]');
      const reason = positionals.slice(2).join(' ').trim() || 'Rejected via CLI';
      const response = await requestJson({
        fetchImpl,
        baseUrl,
        pathName: `/v1/approvals/${approvalId}/reject`,
        method: 'POST',
        token,
        body: { reason },
        waitMs,
        sleepImpl,
      });
      logger.out(`Rejected deploy: ${response.id}`);
      return 0;
    }

    if (command === 'task') {
      const subcommand = positionals[1];

      if (subcommand === 'init') {
        const filePath = path.resolve(options.file ?? 'stallone.task.json');
        await fs.writeFile(filePath, `${JSON.stringify(templateContract(), null, 2)}\n`, 'utf8');
        logger.out(`Task template written: ${filePath}`);
        return 0;
      }

      if (subcommand === 'plan') {
        const filePath = path.resolve(
          ensureArg(options.file, 'Usage: stallone task plan --file <contract.json>')
        );
        const contract = await readContractFromFile(filePath);
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/tasks/plan',
          method: 'POST',
          token,
          body: { contract },
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Task: ${response.task.id}`,
            `Status: ${response.task.status}`,
            response.execution?.executionClass
              ? `Execution class: ${response.execution.executionClass}`
              : null,
            formatPlanOutput(response.plan),
          ]
            .filter(Boolean)
            .join('\n')
        );
        return 0;
      }

      if (subcommand === 'run') {
        const filePath = path.resolve(
          ensureArg(options.file, 'Usage: stallone task run --file <contract.json> [--approve]')
        );
        const contract = await readContractFromFile(filePath);
        const execution = deriveExecutionControl(contract);
        const approveExecution = options.approve === true || execution.autoStartAllowed;
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: '/v1/tasks/run',
          method: 'POST',
          token,
          body: {
            contract,
            approveExecution,
          },
          waitMs,
          sleepImpl,
        });

        logger.out(
          [
            `Task: ${response.task.id}`,
            `Status: ${approveExecution ? 'pending' : response.task.status}`,
            `Execution approval: ${response.executionApproval.status}`,
            response.execution?.executionClass
              ? `Execution class: ${response.execution.executionClass}`
              : null,
          ]
            .filter(Boolean)
            .join('\n')
        );
        return 0;
      }

      if (subcommand === 'approve') {
        const taskId = ensureArg(positionals[2], 'Usage: stallone task approve <task-id>');
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: `/v1/tasks/${taskId}/approve-execution`,
          method: 'POST',
          token,
          waitMs,
          sleepImpl,
        });
        logger.out(`Execution approved: ${response.task_id}`);
        return 0;
      }

      if (subcommand === 'reject') {
        const taskId = ensureArg(positionals[2], 'Usage: stallone task reject <task-id> [reason]');
        const reason = positionals.slice(3).join(' ').trim() || 'Rejected via CLI';
        const response = await requestJson({
          fetchImpl,
          baseUrl,
          pathName: `/v1/tasks/${taskId}/reject-execution`,
          method: 'POST',
          token,
          body: { reason },
          waitMs,
          sleepImpl,
        });
        logger.out(`Execution rejected: ${response.task_id}`);
        return 0;
      }

      throw new Error('Unknown task subcommand. Use: init | plan | run | approve | reject');
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    logger.err(error.message);
    return 1;
  }
}
