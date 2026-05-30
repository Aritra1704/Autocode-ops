import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pino from 'pino';

import { config } from './config.js';
import { getPool, checkDatabaseConnection, closePool } from './db/client.js';
import * as migrateModule from './db/migrate.js';
import { createRagIngestor } from './rag/ingestor.js';
import { createGeminiDriver } from './brain/geminiDriver.js';
import { createGeminiClient } from './llm/providers/gemini.js';
import { createOllamaClient } from './llm/ollama.js';
import { loadTaskContext } from './context/loader.js';
import { buildTaskTitleFromContract, buildTaskDescriptionFromContract } from './control/taskContract.js';
import { startGeminiReviewLoop } from './intelligence/geminiReviewLoop.js';
import { createLearningExtractor } from './learnings/extractor.js';
import { createSkillGenerator } from './intelligence/skillGenerator.js';

const logger = pino({ name: 'stallone' });

const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_TASKS = 3;

let pollTimer = null;
let pollInFlight = false;
let shuttingDown = false;

function withTimeout(promise, timeoutMs, label) {
  let timer;

  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function moduleExists(relativePath) {
  try {
    const absolutePath = fileURLToPath(new URL(relativePath, import.meta.url));
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function startSubsystem(name, factory, options = {}) {
  const fatal = options.fatal === true;

  try {
    return await withTimeout(factory(), BOOT_TIMEOUT_MS, name);
  } catch (error) {
    logger.error({ err: error, subsystem: name }, 'Subsystem failed to start');
    if (fatal) {
      throw error;
    }
    return null;
  }
}

async function loadSoulIfPresent(pool, workspaceRoot) {
  if (!(await moduleExists('./memory/soul.js'))) {
    logger.info('Soul module not found; skipping soul load');
    return null;
  }

  return startSubsystem('soul', async () => {
    const soulModule = await import('./memory/soul.js');
    if (typeof soulModule.loadSoul !== 'function') {
      throw new Error('Soul module does not export loadSoul');
    }

    return soulModule.loadSoul({ pool, logger, workspaceRoot });
  });
}

async function createSkillManagerIfPresent(pool, workspaceRoot) {
  if (!(await moduleExists('./skills/manager.js'))) {
    logger.info('Skills manager module not found; skipping skills initialization');
    return null;
  }

  return startSubsystem('skills_manager', async () => {
    const skillsModule = await import('./skills/manager.js');
    if (typeof skillsModule.createSkillManager !== 'function') {
      throw new Error('Skills manager module does not export createSkillManager');
    }

    const manager = await skillsModule.createSkillManager({ pool, logger, workspaceRoot });

    if (typeof manager?.initialize === 'function') {
      await manager.initialize();
    } else if (typeof manager?.init === 'function') {
      await manager.init();
    }

    return manager;
  });
}

function createControlOrchestrator(activeTaskIds, pool) {
  const base = {
    async recordPresencePing() {
      await pool.query(
        `INSERT INTO presence_log (source, score, recorded_at) VALUES ('dashboard', 0.8, NOW())`
      );
    },
    async getStatusSnapshot() {
      return {
        activeTaskIds: [...activeTaskIds],
        activeTaskCount: activeTaskIds.size,
        mode: config.geminiEnabled ? 'hybrid' : 'local',
        workspace: config.stalloneWorkspaceRoot,
      };
    },
    getMcpStatus() {
      return { servers: [] };
    },
    async pruneMemoryArtifacts() {
      return { pruned: 0 };
    },
    async getPersonaSettings() {
      return {
        voice: 'stallone',
        channels: {},
        controls: {},
      };
    },
    async updatePersonaSettings(next) {
      return next;
    },
    async getPersonaPreferenceProfile() {
      return {};
    },
    async updatePersonaPreferenceProfile(next) {
      return next;
    },
    async listTasks() {
      return [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listSkills() {
      return [];
    },
    async createTask(description, options) {
      // Simple task creation from plain text (used by Telegram plain-text handler).
      // Derives a short title from the first 80 chars of the description.
      const title = String(description ?? '').trim().slice(0, 80);
      const result = await pool.query(
        `INSERT INTO tasks (title, description, priority, source, status)
         VALUES ($1, $2, 'medium', $3, 'pending')
         RETURNING *`,
        [title, description, options?.source ?? 'manual']
      );
      return result.rows[0];
    },
    async createPlannedTask(contract, options) {
      const title = buildTaskTitleFromContract(contract);
      const description = buildTaskDescriptionFromContract(contract);
      const projectPath = contract.projectName
        ? path.join(config.stalloneWorkspaceRoot, contract.projectName)
        : null;
      const result = await pool.query(
        `INSERT INTO tasks (title, description, priority, source, project_name, project_path, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [title, description, contract.priority ?? 'medium', options?.source ?? 'manual', contract.projectName, projectPath]
      );
      const task = result.rows[0];
      return { task, execution: null, executionApproval: null };
    },
  };

  return new Proxy(base, {
    get(target, property) {
      if (property in target) {
        return target[property];
      }

      return async () => null;
    },
  });
}

async function leaseNextPendingTask(pool) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT *
       FROM tasks
       WHERE status = 'pending'
         AND (scheduled_at IS NULL OR scheduled_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    const task = result.rows[0] ?? null;

    if (!task) {
      await client.query('COMMIT');
      return null;
    }

    await client.query(
      `UPDATE tasks
       SET status = 'in_progress',
           started_at = NOW()
       WHERE id = $1`,
      [task.id]
    );
    await client.query('COMMIT');

    return task;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function completeTask(pool, taskId, result) {
  await pool.query(
    `UPDATE tasks
     SET status = $2,
         completed_at = NOW(),
         result = $3::jsonb
     WHERE id = $1`,
    [
      taskId,
      result.success ? 'done' : 'failed',
      JSON.stringify({
        success: result.success,
        stepsCompleted: result.stepsCompleted,
        error: result.error,
      }),
    ]
  );
}

async function failTask(pool, taskId, error) {
  await pool.query(
    `UPDATE tasks
     SET status = 'failed',
         completed_at = NOW(),
         result = $2::jsonb
     WHERE id = $1`,
    [
      taskId,
      JSON.stringify({
        success: false,
        stepsCompleted: 0,
        error: error?.message ?? 'Unhandled task error',
      }),
    ]
  );
}

async function bootstrap() {
  const migrate = migrateModule.migrate ?? migrateModule.runMigrations;
  if (typeof migrate !== 'function') {
    throw new Error('Migration module does not export migrate or runMigrations');
  }

  await startSubsystem('db_migrations', () => migrate(), { fatal: true });

  const pool = getPool();
  const dbHealth = await startSubsystem('database', () => checkDatabaseConnection(), {
    fatal: true,
  });
  logger.info({ dbHealth }, 'Database connection verified');

  const workspaceRoot = config.stalloneWorkspaceRoot ?? process.cwd();
  const activeTaskIds = new Set();
  const geminiClient = createGeminiClient();
  const ollamaClient = createOllamaClient();
  // Minimal model selector for the learning extractor — uses the existing coder model
  // (avoids pulling in the full createModelSelector which expects different config field names)
  const learningModelSelector = { select: () => `ollama::${config.ollamaModelCoder}` };
  const learningExtractor = createLearningExtractor({
    client: ollamaClient,
    modelSelector: learningModelSelector,
    pool,
  });
  const skillGenerator = createSkillGenerator(pool, {
    skillsDir: path.join(process.cwd(), 'skills', 'generated'),
  });

  await loadSoulIfPresent(pool, workspaceRoot);

  await startSubsystem('rag_corpus_sync', async () => {
    const ingestor = createRagIngestor({ pool, logger });
    const summary = await ingestor.ingestProjectDocuments({ projectRoot: workspaceRoot });
    logger.info({ summary }, 'RAG corpus sync initialized');
    return ingestor;
  });

  const skillManager = await createSkillManagerIfPresent(pool, workspaceRoot);

  const geminiDriver = await startSubsystem('gemini_driver', async () =>
    createGeminiDriver(pool, {
      workspaceRoot,
      geminiClient,
      learningExtractor,
      skillGenerator,
      skillManager,
    })
  );

  let telegramBot = null;
  if (config.telegramBotToken) {
    telegramBot = await startSubsystem('telegram_bot', async () => {
      const telegramModule = await import('./telegram/bot.js');
      const createTelegramBot =
        telegramModule.createTelegramBot ?? telegramModule.startTelegramBot;

      if (typeof createTelegramBot !== 'function') {
        throw new Error('Telegram module does not export createTelegramBot or startTelegramBot');
      }

      return createTelegramBot({
        logger,
        pool,
        geminiDriver,
        workspaceRoot,
        orchestrator: createControlOrchestrator(activeTaskIds, pool),
      });
    });
  }

  let controlApi = null;
  if (config.controlApiEnabled) {
    controlApi = await startSubsystem('control_api', async () => {
      const controlModule = await import('./control/api.js');
      const createControlApi =
        controlModule.createControlApi ?? controlModule.createControlApiServer;

      if (typeof createControlApi !== 'function') {
        throw new Error('Control API module does not export createControlApi or createControlApiServer');
      }

      const api = createControlApi({
        orchestrator: createControlOrchestrator(activeTaskIds, pool),
        logger,
        host: config.controlApiHost,
        port: config.controlApiPort,
        token: process.env.CONTROL_API_TOKEN ?? 'stallone-control',
      });

      if (typeof api?.start === 'function') {
        const address = await api.start();
        logger.info({ address }, 'Control API started');
      }

      return api;
    });
  }

  startGeminiReviewLoop(pool, geminiClient, logger);

  function tgNotify(text) {
    if (telegramBot && typeof telegramBot.sendMessage === 'function') {
      telegramBot.sendMessage(text).catch((err) => {
        logger.warn({ err }, 'Failed to send Telegram progress notification');
      });
    }
  }

  async function runTask(task) {
    const shortId = task.id?.slice(0, 8) ?? '?';
    try {
      logger.info({ taskId: task.id, title: task.title }, 'Starting task');
      tgNotify(`🧠 Architecting task\n*${task.title}*\nID: ${shortId}`);

      const context = await loadTaskContext(task, {
        workspaceRoot: task.project_path ?? workspaceRoot,
      });

      function onProgress(message) {
        tgNotify(message);
      }

      const result = geminiDriver
        ? await geminiDriver.runTask(task, context.context, { onProgress })
        : {
            success: false,
            stepsCompleted: 0,
            error: 'Gemini driver is unavailable',
          };

      await completeTask(pool, task.id, result);
      logger.info(
        { taskId: task.id, success: result.success, stepsCompleted: result.stepsCompleted },
        'Task finished'
      );

      if (result.success) {
        tgNotify(`✅ Task done\nTitle: ${task.title}\nID: ${shortId}\nSteps completed: ${result.stepsCompleted}`);
      } else {
        tgNotify(`❌ Task failed\nTitle: ${task.title}\nID: ${shortId}\nReason: ${result.error ?? 'unknown'}`);
      }
    } catch (error) {
      logger.error({ err: error, taskId: task.id }, 'Task execution failed');
      tgNotify(`❌ Task crashed\nTitle: ${task.title}\nID: ${shortId}\nError: ${error?.message ?? 'unknown'}`);
      await failTask(pool, task.id, error).catch((updateError) => {
        logger.error(
          { err: updateError, taskId: task.id },
          'Failed to mark task as failed after execution error'
        );
      });
    } finally {
      activeTaskIds.delete(task.id);
    }
  }

  async function pollOnce() {
    if (pollInFlight || shuttingDown) {
      return;
    }

    pollInFlight = true;

    try {
      while (!shuttingDown && activeTaskIds.size < MAX_CONCURRENT_TASKS) {
        const task = await leaseNextPendingTask(pool);
        if (!task) {
          break;
        }

        activeTaskIds.add(task.id);
        void runTask(task);
      }
    } catch (error) {
      logger.error({ err: error }, 'Polling loop iteration failed');
    } finally {
      pollInFlight = false;
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'Shutting down Stallone');

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (typeof controlApi?.stop === 'function') {
      await controlApi.stop().catch((error) => {
        logger.error({ err: error }, 'Failed to stop control API cleanly');
      });
    }

    if (typeof telegramBot?.stop === 'function') {
      await telegramBot.stop().catch((error) => {
        logger.error({ err: error }, 'Failed to stop Telegram bot cleanly');
      });
    }

    await closePool().catch((error) => {
      logger.error({ err: error }, 'Failed to close database pool cleanly');
    });
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });

  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  void pollOnce();

  logger.info(
    {
      mode: config.geminiEnabled ? 'hybrid' : 'local',
      workspace: config.stalloneWorkspaceRoot,
    },
    'Stallone is running'
  );
}

bootstrap().catch(async (error) => {
  logger.fatal({ err: error }, 'Fatal boot failure');
  await closePool().catch(() => {});
  process.exit(1);
});
