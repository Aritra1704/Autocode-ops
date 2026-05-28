import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  STALLONE_NAME: z.string().min(1).default('Stallone'),
  STALLONE_WORKSPACE_ROOT: z
    .string()
    .min(1)
    .default('/Users/aritrarpal/Documents/workspace_biz'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a valid PostgreSQL schema name')
    .default('stallone'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  GITHUB_PAT: z.string().optional(),
  GITHUB_USERNAME: z.string().optional(),
  GITHUB_REPO_OWNER: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),
  GITHUB_REPO_VISIBILITY: z.enum(['private', 'public']).default('private'),
  GITHUB_AUTO_PUBLISH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GIT_DEFAULT_BRANCH: z.string().min(1).default('main'),
  RAILWAY_API_TOKEN: z.string().optional(),
  RAILWAY_GRAPHQL_ENDPOINT: z
    .string()
    .url()
    .default('https://backboard.railway.com/graphql/v2'),
  RAILWAY_PROJECT_ID: z.string().optional(),
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  RAILWAY_SERVICE_ID: z.string().optional(),
  RAILWAY_DEPLOY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RAILWAY_DEPLOY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  RAILWAY_DEPLOY_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_DEFAULT_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_ESCALATION_MODEL: z.string().default('gemini-2.5-pro'),
  GEMINI_TASK_TOKEN_BUDGET: z.coerce.number().int().positive().default(50000),
  GEMINI_API_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_KEEP_ALIVE: z.string().default('30s'),
  OLLAMA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  OLLAMA_WARMUP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OLLAMA_WARMUP_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  OLLAMA_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(3),
  OLLAMA_MODEL_ORCHESTRATOR: z.string().default('qwen2.5-coder:14b'),
  OLLAMA_MODEL_CODER: z.string().default('qwen2.5-coder:7b'),
  OLLAMA_MODEL_ROUTER: z.string().default('llama3.2:3b'),
  OLLAMA_MODEL_VERIFIER: z.string().default('qwen2.5-coder:7b'),
  OLLAMA_MODEL_EMBED: z.string().default('nomic-embed-text:latest'),
  TASK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  TASK_TIMEOUT_HOURS: z.coerce.number().positive().default(4),
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  DOCKER_SANDBOX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  REPAIR_AUTO_APPROVE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  DEPLOY_AUTO_APPROVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
  SOUL_EVOLUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SKILLS_BUILTIN_DIR: z.string().default('skills/builtin'),
  SKILLS_ALLOW_GENERATED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SKILLS_AUTO_GENERATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  SKILLS_AUTO_GENERATE_MIN_PATTERN_COUNT: z.coerce.number().int().positive().default(3),
  SKILLS_AUTO_GENERATE_MIN_SUCCESSES: z.coerce.number().int().positive().default(2),
  MEMORY_RETENTION_ACTIVE_DAYS: z.coerce.number().int().positive().default(14),
  MEMORY_RETENTION_ARCHIVED_DAYS: z.coerce.number().int().positive().default(3),
  MEMORY_RETENTION_ORPHAN_DAYS: z.coerce.number().int().positive().default(7),
  MEMORY_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(7200000),
  MEMORY_RETENTION_MAX_PRUNE: z.coerce.number().int().positive().default(200),
  PRESENCE_ONLINE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  PRESENCE_WINDOW_MINUTES: z.coerce.number().positive().default(30),
  CONTROL_API_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CONTROL_API_HOST: z
    .string()
    .default('127.0.0.1')
    .refine(
      (value) => value === '127.0.0.1' || value === 'localhost',
      'CONTROL_API_HOST must be localhost or 127.0.0.1'
    ),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(4173),
  UI_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  UI_DIST_DIR: z.string().default('web/dist'),
  UI_DEV_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const formattedErrors = parsedEnv.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid Stallone configuration:\n${formattedErrors}`);
}

const env = parsedEnv.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  stalloneName: env.STALLONE_NAME,
  stalloneWorkspaceRoot: env.STALLONE_WORKSPACE_ROOT,
  databaseUrl: env.DATABASE_URL,
  databaseSchema: env.DATABASE_SCHEMA,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  githubPat: env.GITHUB_PAT ?? '',
  githubUsername: env.GITHUB_USERNAME ?? '',
  githubRepoOwner: env.GITHUB_REPO_OWNER ?? env.GITHUB_USERNAME ?? '',
  githubApiBaseUrl: env.GITHUB_API_BASE_URL,
  githubRepoVisibility: env.GITHUB_REPO_VISIBILITY,
  githubAutoPublish: env.GITHUB_AUTO_PUBLISH,
  gitDefaultBranch: env.GIT_DEFAULT_BRANCH,
  railwayApiToken: env.RAILWAY_API_TOKEN ?? '',
  railwayGraphqlEndpoint: env.RAILWAY_GRAPHQL_ENDPOINT,
  railwayProjectId: env.RAILWAY_PROJECT_ID ?? '',
  railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID ?? '',
  railwayServiceId: env.RAILWAY_SERVICE_ID ?? '',
  railwayDeployEnabled: env.RAILWAY_DEPLOY_ENABLED,
  railwayDeployPollIntervalMs: env.RAILWAY_DEPLOY_POLL_INTERVAL_MS,
  railwayDeployTimeoutMs: env.RAILWAY_DEPLOY_TIMEOUT_MS,
  geminiApiKey: env.GEMINI_API_KEY ?? '',
  geminiDefaultModel: env.GEMINI_DEFAULT_MODEL,
  geminiEscalationModel: env.GEMINI_ESCALATION_MODEL,
  geminiTaskTokenBudget: env.GEMINI_TASK_TOKEN_BUDGET,
  geminiApiBaseUrl: env.GEMINI_API_BASE_URL,
  geminiRequestTimeoutMs: env.GEMINI_REQUEST_TIMEOUT_MS,
  geminiMaxRetries: env.GEMINI_MAX_RETRIES,
  ollamaBaseUrl: env.OLLAMA_BASE_URL,
  ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE,
  ollamaRequestTimeoutMs: env.OLLAMA_REQUEST_TIMEOUT_MS,
  ollamaWarmupEnabled: env.OLLAMA_WARMUP_ENABLED,
  ollamaWarmupTimeoutMs: env.OLLAMA_WARMUP_TIMEOUT_MS,
  ollamaMaxRetries: env.OLLAMA_MAX_RETRIES,
  ollamaModelOrchestrator: env.OLLAMA_MODEL_ORCHESTRATOR,
  ollamaModelCoder: env.OLLAMA_MODEL_CODER,
  ollamaModelRouter: env.OLLAMA_MODEL_ROUTER,
  ollamaModelVerifier: env.OLLAMA_MODEL_VERIFIER,
  ollamaModelEmbed: env.OLLAMA_MODEL_EMBED,
  taskPollIntervalMs: env.TASK_POLL_INTERVAL_MS,
  taskTimeoutHours: env.TASK_TIMEOUT_HOURS,
  maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
  dockerSandboxEnabled: env.DOCKER_SANDBOX_ENABLED,
  repairAutoApprove: env.REPAIR_AUTO_APPROVE,
  deployAutoApprove: env.DEPLOY_AUTO_APPROVE,
  heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
  soulEvolutionEnabled: env.SOUL_EVOLUTION_ENABLED,
  skillsBuiltinDir: env.SKILLS_BUILTIN_DIR,
  skillsAllowGenerated: env.SKILLS_ALLOW_GENERATED,
  skillsAutoGenerate: env.SKILLS_AUTO_GENERATE,
  skillsAutoGenerateMinPatternCount: env.SKILLS_AUTO_GENERATE_MIN_PATTERN_COUNT,
  skillsAutoGenerateMinSuccesses: env.SKILLS_AUTO_GENERATE_MIN_SUCCESSES,
  memoryRetentionActiveDays: env.MEMORY_RETENTION_ACTIVE_DAYS,
  memoryRetentionArchivedDays: env.MEMORY_RETENTION_ARCHIVED_DAYS,
  memoryRetentionOrphanDays: env.MEMORY_RETENTION_ORPHAN_DAYS,
  memoryRetentionIntervalMs: env.MEMORY_RETENTION_INTERVAL_MS,
  memoryRetentionMaxPrune: env.MEMORY_RETENTION_MAX_PRUNE,
  presenceOnlineThreshold: env.PRESENCE_ONLINE_THRESHOLD,
  presenceWindowMinutes: env.PRESENCE_WINDOW_MINUTES,
  controlApiEnabled: env.CONTROL_API_ENABLED,
  controlApiHost: env.CONTROL_API_HOST,
  controlApiPort: env.CONTROL_API_PORT,
  uiEnabled: env.UI_ENABLED,
  uiDistDir: env.UI_DIST_DIR,
  uiDevOrigin: env.UI_DEV_ORIGIN,
};

config.geminiEnabled = config.geminiApiKey.length > 0;

export function requireConfig(...keys) {
  const missing = keys.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required Stallone config values: ${missing.join(', ')}`);
  }
}
