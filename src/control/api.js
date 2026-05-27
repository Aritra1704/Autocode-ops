import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { listActors } from './actors.js';
import { deriveExecutionControl, normalizeTaskContract } from './taskContract.js';
import { normalizePersonaSettings } from '../persona/artifacts.js';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
};

const runRequestSchema = z
  .object({
    contract: z.unknown(),
    approveExecution: z.boolean().default(false),
  })
  .strict();

const rejectExecutionSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).default('Execution rejected via control API'),
  })
  .partial()
  .strict();

const rejectApprovalSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).default('Rejected via control API'),
  })
  .partial()
  .strict();

const pauseSchema = z
  .object({
    reason: z.string().trim().min(1).max(300).default('Paused via control API'),
  })
  .partial()
  .strict();

const pruneMemorySchema = z
  .object({
    maxRows: z.number().int().positive().max(5000).optional(),
  })
  .partial()
  .strict();

const createChatSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    actor: z.string().trim().min(1).optional(),
    projectPath: z.string().trim().min(1).optional(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(12000),
    actor: z.string().trim().min(1).optional(),
  })
  .strict();

const draftTaskSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000).optional(),
    actor: z.string().trim().min(1).optional(),
  })
  .partial()
  .strict();

const planChatTaskSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000).optional(),
    contract: z.unknown().optional(),
  })
  .partial()
  .strict();

const approveChatTaskSchema = z
  .object({
    taskId: z.string().uuid(),
  })
  .strict();

const publishReviewDraftSchema = z
  .object({
    owner: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    issueNumber: z.number().int().positive(),
  })
  .strict();

const addProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rootPath: z.string().trim().min(1),
    githubRepoOwner: z.string().trim().min(1).max(120).optional(),
    githubRepoName: z.string().trim().min(1).max(120).optional(),
    railwayProjectId: z.string().trim().min(1).max(120).optional(),
    railwayEnvironmentId: z.string().trim().min(1).max(120).optional(),
    railwayServiceId: z.string().trim().min(1).max(120).optional(),
    railwayServiceName: z.string().trim().min(1).max(120).optional(),
    browserAllowedOrigins: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  })
  .strict();

const personaSettingsSchema = z
  .object({
    voice: z.string().trim().min(1).max(120).optional(),
    channels: z
      .object({
        telegram: z
          .object({
            verbosity: z.enum(['concise', 'detailed']).optional(),
            teachingDepth: z.enum(['low', 'medium', 'high']).optional(),
          })
          .partial()
          .optional(),
        ui: z
          .object({
            verbosity: z.enum(['concise', 'detailed']).optional(),
            teachingDepth: z.enum(['low', 'medium', 'high']).optional(),
          })
          .partial()
          .optional(),
        github: z
          .object({
            verbosity: z.enum(['concise', 'detailed']).optional(),
            teachingDepth: z.enum(['low', 'medium', 'high']).optional(),
            mode: z.enum(['draft_or_approval_gated', 'approval_gated_only']).optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    controls: z
      .object({
        proactiveObservations: z.boolean().optional(),
        githubVoiceEnabled: z.boolean().optional(),
      })
      .partial()
      .optional(),
  })
  .partial()
  .strict();

const personaPreferenceProfileSchema = z
  .object({
    explicit: z
      .object({
        verbosity: z.object({ value: z.enum(['concise', 'detailed']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
        explanationDepth: z.object({ value: z.enum(['low', 'medium', 'high']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
        planningStyle: z.object({ value: z.enum(['stepwise', 'conversational']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
        interactionMode: z.object({ value: z.enum(['execution_oriented', 'discussion_oriented']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
        reviewTone: z.object({ value: z.enum(['direct', 'neutral', 'supportive']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
        commentNoise: z.object({ value: z.enum(['low', 'medium', 'high']), evidence: z.string().trim().max(160).optional() }).strict().nullable().optional(),
      })
      .partial()
      .optional(),
    inferred: z
      .object({
        verbosity: z.object({ value: z.enum(['concise', 'detailed']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
        explanationDepth: z.object({ value: z.enum(['low', 'medium', 'high']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
        planningStyle: z.object({ value: z.enum(['stepwise', 'conversational']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
        interactionMode: z.object({ value: z.enum(['execution_oriented', 'discussion_oriented']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
        reviewTone: z.object({ value: z.enum(['direct', 'neutral', 'supportive']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
        commentNoise: z.object({ value: z.enum(['low', 'medium', 'high']), confidence: z.number().min(0).max(1).optional(), evidence: z.string().trim().max(160).optional(), expiresAt: z.string().datetime().optional() }).strict().nullable().optional(),
      })
      .partial()
      .optional(),
  })
  .partial()
  .strict();

const staticTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);
const controlModuleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(controlModuleDir, '../..');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function sendValidationError(res, error) {
  sendJson(res, 400, {
    error: 'validation_error',
    message: 'Request validation failed',
    details: error?.issues ?? [],
  });
}

function parseLimit(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
    return fallback;
  }

  return parsed;
}

async function readJsonBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 1_000_000) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function extractToken(req) {
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string') {
    const match = bearer.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }

  const headerToken = req.headers['x-control-token'];
  if (typeof headerToken === 'string') {
    return headerToken.trim();
  }

  if (Array.isArray(headerToken) && headerToken.length > 0) {
    return `${headerToken[0]}`.trim();
  }

  return null;
}

function normalizeContractPayload(body) {
  const candidate = body?.contract ?? body;
  return normalizeTaskContract(candidate);
}

function isMutatingRequest(req) {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

async function sendStaticFile(req, res, uiConfig, pathname) {
  if (!uiConfig?.enabled || !uiConfig.distDir) {
    return false;
  }

  const distRoot = path.isAbsolute(uiConfig.distDir)
    ? uiConfig.distDir
    : path.resolve(repoRoot, uiConfig.distDir);
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.resolve(distRoot, `.${requestPath}`);
  const relative = path.relative(distRoot, candidate);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  let filePath = candidate;
  let data = await fs.readFile(filePath).catch(() => null);

  if (!data && !path.extname(candidate)) {
    filePath = path.join(distRoot, 'index.html');
    data = await fs.readFile(filePath).catch(() => null);
  }

  if (!data) {
    return false;
  }

  res.writeHead(200, {
    'content-type': staticTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

export function createControlApiServer({
  orchestrator,
  logger,
  host,
  port,
  token,
  chatService = null,
  projectService = null,
  uiConfig = null,
}) {
  if (!orchestrator) {
    throw new Error('Control API requires an orchestrator instance');
  }

  if (!token) {
    throw new Error('Control API requires a token for mutating endpoints');
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    try {
      if (pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (isMutatingRequest(req)) {
        const providedToken = extractToken(req);
        if (!providedToken || providedToken !== token) {
          sendJson(res, 401, {
            error: 'unauthorized',
            message: 'Missing or invalid control API token',
          });
          return;
        }
      }

      if (pathname === '/v1/status' && req.method === 'GET') {
        const snapshot = await orchestrator.getStatusSnapshot();
        sendJson(res, 200, { data: snapshot });
        return;
      }

      if (pathname === '/v1/maintenance/prune-memory' && req.method === 'POST') {
        const parsed = pruneMemorySchema.parse(await readJsonBody(req));
        const summary = await orchestrator.pruneMemoryArtifacts({
          runMode: 'operator',
          maxRows: parsed.maxRows,
        });
        sendJson(res, 200, { data: summary });
        return;
      }

      if (pathname === '/v1/mcp' && req.method === 'GET') {
        sendJson(res, 200, { data: orchestrator.getMcpStatus() });
        return;
      }

      if (pathname === '/v1/persona/settings' && req.method === 'GET') {
        sendJson(res, 200, { data: await orchestrator.getPersonaSettings() });
        return;
      }

      if (pathname === '/v1/persona/settings' && req.method === 'PUT') {
        const parsed = personaSettingsSchema.parse(await readJsonBody(req));
        const current = await orchestrator.getPersonaSettings();
        const next = normalizePersonaSettings({
          ...current,
          ...parsed,
          channels: {
            ...current.channels,
            ...(parsed.channels ?? {}),
            telegram: {
              ...current.channels.telegram,
              ...(parsed.channels?.telegram ?? {}),
            },
            ui: {
              ...current.channels.ui,
              ...(parsed.channels?.ui ?? {}),
            },
            github: {
              ...current.channels.github,
              ...(parsed.channels?.github ?? {}),
            },
          },
          controls: {
            ...current.controls,
            ...(parsed.controls ?? {}),
          },
        });
        sendJson(res, 200, { data: await orchestrator.updatePersonaSettings(next) });
        return;
      }

      if (pathname === '/v1/persona/preference-profile' && req.method === 'GET') {
        sendJson(res, 200, { data: await orchestrator.getPersonaPreferenceProfile() });
        return;
      }

      if (pathname === '/v1/persona/preference-profile' && req.method === 'PUT') {
        const parsed = personaPreferenceProfileSchema.parse(await readJsonBody(req));
        sendJson(res, 200, { data: await orchestrator.updatePersonaPreferenceProfile(parsed) });
        return;
      }

      if (pathname === '/v1/tasks' && req.method === 'GET') {
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const tasks = await orchestrator.listTasks(limit);
        sendJson(res, 200, { data: tasks });
        return;
      }

      if (pathname === '/v1/approvals' && req.method === 'GET') {
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const approvals = await orchestrator.listPendingApprovals(limit);
        sendJson(res, 200, { data: approvals });
        return;
      }

      if (pathname === '/v1/skills' && req.method === 'GET') {
        const includeDisabled =
          requestUrl.searchParams.get('includeDisabled') === 'true';
        const limit = parseLimit(requestUrl.searchParams.get('limit'), 20);
        const skills = await orchestrator.listSkills({ includeDisabled, limit });
        sendJson(res, 200, { data: skills });
        return;
      }

      if (pathname === '/v1/chat/actors' && req.method === 'GET') {
        sendJson(res, 200, { data: listActors() });
        return;
      }

      if (pathname === '/v1/projects' && req.method === 'GET') {
        if (!projectService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Project service is not configured',
          });
          return;
        }

        sendJson(res, 200, { data: await projectService.listProjects() });
        return;
      }

      if (pathname === '/v1/projects' && req.method === 'POST') {
        if (!projectService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Project service is not configured',
          });
          return;
        }

        const parsed = addProjectSchema.parse(await readJsonBody(req));
        const project = await projectService.addProject({
          name: parsed.name,
          rootPath: parsed.rootPath,
          metadata: {
            githubRepoOwner: parsed.githubRepoOwner,
            githubRepoName: parsed.githubRepoName,
            railwayProjectId: parsed.railwayProjectId,
            railwayEnvironmentId: parsed.railwayEnvironmentId,
            railwayServiceId: parsed.railwayServiceId,
            railwayServiceName: parsed.railwayServiceName,
            browserAllowedOrigins: parsed.browserAllowedOrigins,
          },
        });
        sendJson(res, 201, { data: project });
        return;
      }

      const projectMatch = pathname.match(/^\/v1\/projects\/([0-9a-f-]{36})$/i);
      if (projectMatch && req.method === 'DELETE') {
        if (!projectService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Project service is not configured',
          });
          return;
        }

        const project = await projectService.deleteProject(projectMatch[1]);
        if (!project) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Project not found',
          });
          return;
        }

        sendJson(res, 200, { data: project });
        return;
      }

      if (pathname === '/v1/chat/sessions' && req.method === 'GET') {
        if (!chatService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Chat service is not configured',
          });
          return;
        }

        const limit = parseLimit(requestUrl.searchParams.get('limit'), 30);
        sendJson(res, 200, { data: await chatService.listSessions(limit) });
        return;
      }

      if (pathname === '/v1/chat/sessions' && req.method === 'POST') {
        if (!chatService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Chat service is not configured',
          });
          return;
        }

        const parsed = createChatSessionSchema.parse(await readJsonBody(req));
        const session = await chatService.createSession(parsed);
        sendJson(res, 201, { data: session });
        return;
      }

      const chatSessionMatch = pathname.match(/^\/v1\/chat\/sessions\/([0-9a-f-]{36})$/i);
      if (chatSessionMatch && req.method === 'GET') {
        if (!chatService) {
          sendJson(res, 503, {
            error: 'unavailable',
            message: 'Chat service is not configured',
          });
          return;
        }

        const session = await chatService.getSession(chatSessionMatch[1]);
        if (!session) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Chat session not found',
          });
          return;
        }

        sendJson(res, 200, { data: session });
        return;
      }

      const chatMessagesMatch = pathname.match(
        /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/messages$/i
      );
      if (chatMessagesMatch && req.method === 'POST') {
        const parsed = chatMessageSchema.parse(await readJsonBody(req));
        const result = await chatService?.appendMessage(chatMessagesMatch[1], parsed);
        if (!result) {
          sendJson(res, chatService ? 404 : 503, {
            error: chatService ? 'not_found' : 'unavailable',
            message: chatService ? 'Chat session not found' : 'Chat service is not configured',
          });
          return;
        }

        sendJson(res, 201, { data: result });
        return;
      }

      const draftTaskMatch = pathname.match(
        /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/draft-task$/i
      );
      if (draftTaskMatch && req.method === 'POST') {
        const parsed = draftTaskSchema.parse(await readJsonBody(req));
        const result = await chatService?.draftTask(draftTaskMatch[1], parsed);
        if (!result) {
          sendJson(res, chatService ? 404 : 503, {
            error: chatService ? 'not_found' : 'unavailable',
            message: chatService ? 'Chat session not found' : 'Chat service is not configured',
          });
          return;
        }

        sendJson(res, 201, { data: result });
        return;
      }

      const planTaskMatch = pathname.match(
        /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/plan-task$/i
      );
      if (planTaskMatch && req.method === 'POST') {
        const parsed = planChatTaskSchema.parse(await readJsonBody(req));
        const result = await chatService?.planTask(planTaskMatch[1], parsed);
        if (!result) {
          sendJson(res, chatService ? 404 : 503, {
            error: chatService ? 'not_found' : 'unavailable',
            message: chatService ? 'Chat session not found' : 'Chat service is not configured',
          });
          return;
        }

        sendJson(res, 201, { data: result });
        return;
      }

      const approveChatTaskMatch = pathname.match(
        /^\/v1\/chat\/sessions\/([0-9a-f-]{36})\/approve-task$/i
      );
      if (approveChatTaskMatch && req.method === 'POST') {
        const parsed = approveChatTaskSchema.parse(await readJsonBody(req));
        const result = await chatService?.approveTask(approveChatTaskMatch[1], parsed);
        if (!result) {
          sendJson(res, chatService ? 409 : 503, {
            error: chatService ? 'conflict' : 'unavailable',
            message: chatService
              ? 'Task is not waiting execution approval'
              : 'Chat service is not configured',
          });
          return;
        }

        sendJson(res, 200, { data: result });
        return;
      }

      const taskIdMatch = pathname.match(/^\/v1\/tasks\/([0-9a-f-]{36})$/i);
      if (taskIdMatch && req.method === 'GET') {
        const taskDetails = await orchestrator.getTaskDetails(taskIdMatch[1]);
        if (!taskDetails) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Task not found',
          });
          return;
        }

        sendJson(res, 200, { data: taskDetails });
        return;
      }

      if (pathname === '/v1/tasks/plan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const contract = normalizeContractPayload(body);
        const execution = deriveExecutionControl(contract);
        const plannedTask = await orchestrator.createPlannedTask(contract, {
          source: 'control_api',
        });

        sendJson(res, 201, {
          data: {
            ...plannedTask,
            execution,
          },
        });
        return;
      }

      if (pathname === '/v1/tasks/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = runRequestSchema.parse({
          contract: body?.contract ?? body,
          approveExecution: body?.approveExecution,
        });

        const contract = normalizeTaskContract(parsed.contract);
        const execution = deriveExecutionControl(contract);
        const plannedTask = await orchestrator.createPlannedTask(contract, {
          source: 'control_api',
          autoApproveExecution: true,
          approvalSource: 'control_api',
          approvalNote: 'Execution queued immediately by /v1/tasks/run',
        });

        const executionApproval = plannedTask.executionApproval ?? {
          status: 'approved',
          task_id: plannedTask.task.id,
          approvalRequired: false,
          autoStarted: true,
        };

        sendJson(res, 201, {
          data: {
            ...plannedTask,
            execution: plannedTask.execution ?? execution,
            executionApproval,
          },
        });
        return;
      }

      const approveExecutionMatch = pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]{36})\/approve-execution$/i
      );
      if (approveExecutionMatch && req.method === 'POST') {
        const approved = await orchestrator.approveTaskExecution(approveExecutionMatch[1], {
          respondedVia: 'control_api',
        });

        if (!approved) {
          sendJson(res, 409, {
            error: 'conflict',
            message: 'Task is not waiting execution approval',
          });
          return;
        }

        sendJson(res, 200, { data: approved });
        return;
      }

      const publishReviewDraftMatch = pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]{36})\/publish-review-draft$/i
      );
      if (publishReviewDraftMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = publishReviewDraftSchema.parse(body);
        const published = await orchestrator.publishTaskReviewDraft(
          publishReviewDraftMatch[1],
          parsed
        );

        if (!published) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Task not found',
          });
          return;
        }

        sendJson(res, 200, { data: published });
        return;
      }

      const rejectExecutionMatch = pathname.match(
        /^\/v1\/tasks\/([0-9a-f-]{36})\/reject-execution$/i
      );
      if (rejectExecutionMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = rejectExecutionSchema.parse(body);
        const rejected = await orchestrator.rejectTaskExecution(rejectExecutionMatch[1], {
          respondedVia: 'control_api',
          reason: parsed.reason,
        });

        if (!rejected) {
          sendJson(res, 409, {
            error: 'conflict',
            message: 'Task is not waiting execution approval',
          });
          return;
        }

        sendJson(res, 200, { data: rejected });
        return;
      }

      const approveMatch = pathname.match(/^\/v1\/approvals\/([0-9a-f-]{36})\/approve$/i);
      if (approveMatch && req.method === 'POST') {
        const approval = await orchestrator.approveApproval(approveMatch[1], {
          respondedVia: 'control_api',
        });

        if (!approval) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Approval not found or already handled',
          });
          return;
        }

        sendJson(res, 200, { data: approval });
        return;
      }

      const rejectMatch = pathname.match(/^\/v1\/approvals\/([0-9a-f-]{36})\/reject$/i);
      if (rejectMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = rejectApprovalSchema.parse(body);
        const approval = await orchestrator.rejectApproval(rejectMatch[1], {
          respondedVia: 'control_api',
          reason: parsed.reason,
        });

        if (!approval) {
          sendJson(res, 404, {
            error: 'not_found',
            message: 'Approval not found or already handled',
          });
          return;
        }

        sendJson(res, 200, { data: approval });
        return;
      }

      if (pathname === '/v1/pause' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = pauseSchema.parse(body);
        await orchestrator.pause(parsed.reason);
        sendJson(res, 200, { data: { status: 'paused', reason: parsed.reason } });
        return;
      }

      if (pathname === '/v1/resume' && req.method === 'POST') {
        await orchestrator.resume();
        sendJson(res, 200, { data: { status: 'running' } });
        return;
      }

      // Presence ping — dashboard calls this to record its activity in presence_log
      if (pathname === '/v1/presence/ping' && req.method === 'POST') {
        try {
          await orchestrator.recordPresencePing?.();
        } catch {
          // best-effort — don't fail the request if pool is unavailable
        }
        sendJson(res, 200, { data: { recorded: true, source: 'dashboard', ts: new Date().toISOString() } });
        return;
      }

      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        !pathname.startsWith('/v1/') &&
        (await sendStaticFile(req, res, uiConfig, pathname))
      ) {
        return;
      }

      sendJson(res, 404, {
        error: 'not_found',
        message: 'Endpoint not found',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendValidationError(res, error);
        return;
      }

      if (error instanceof SyntaxError) {
        sendJson(res, 400, {
          error: 'invalid_json',
          message: 'Request body must be valid JSON',
        });
        return;
      }

      logger?.error?.({ err: error, path: pathname, method: req.method }, 'Control API request failed');
      sendJson(res, 500, {
        error: 'internal_error',
        message: error.message,
      });
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      return {
        host,
        port: typeof address === 'object' && address ? address.port : port,
      };
    },

    async stop() {
      if (!server.listening) {
        return;
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    get server() {
      return server;
    },
  };
}
