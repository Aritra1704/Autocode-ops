import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const projectNameSchema = z.string().trim().min(1).max(120);
const projectMetadataSchema = z
  .object({
    githubRepoOwner: z.string().trim().min(1).max(120).optional(),
    githubRepoName: z.string().trim().min(1).max(120).optional(),
    railwayProjectId: z.string().trim().min(1).max(120).optional(),
    railwayEnvironmentId: z.string().trim().min(1).max(120).optional(),
    railwayServiceId: z.string().trim().min(1).max(120).optional(),
    railwayServiceName: z.string().trim().min(1).max(120).optional(),
    browserAllowedOrigins: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  })
  .partial()
  .strict();

function normalizeRoot(value) {
  return path.resolve(value).replace(/\/+$/, '');
}

function isInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createProjectService({ pool, workspaceRoots = [], mcpRegistry = null }) {
  if (!pool) {
    throw new Error('Project service requires a database pool');
  }

  const allowedRoots = [...new Set(workspaceRoots.map(normalizeRoot))];
  if (allowedRoots.length === 0) {
    throw new Error('Project service requires at least one workspace root');
  }

  async function validateProjectPath(rawPath) {
    const resolved = normalizeRoot(rawPath);
    const allowedRoot = allowedRoots.find((root) => isInsideRoot(resolved, root));

    if (!allowedRoot) {
      throw new Error(
        `Project path is outside allowed workspace roots: ${allowedRoots.join(', ')}`
      );
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Project path does not exist or is not a directory: ${resolved}`);
    }

    return {
      rootPath: resolved,
      allowedRoot,
    };
  }

  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  return {
    allowedRoots,

    async listProjects() {
      const result = await callPostgresTool(
        'list_project_targets',
        {},
        () =>
          pool.query(
            `SELECT id, name, root_path, created_at, updated_at
                    , github_repo_owner, github_repo_name,
                      railway_project_id, railway_environment_id, railway_service_id, railway_service_name,
                      browser_allowed_origins
             FROM project_targets
             ORDER BY updated_at DESC, created_at DESC`
          )
      );

      return {
        allowedRoots,
        projects: result.rows,
      };
    },

    async addProject({ name, rootPath, metadata = {} }) {
      const validation = await validateProjectPath(rootPath);
      const resolvedName =
        name && `${name}`.trim()
          ? projectNameSchema.parse(name)
          : path.basename(validation.rootPath) || validation.rootPath;
      const parsedMetadata = projectMetadataSchema.parse(metadata);

      const result = await callPostgresTool(
        'upsert_project_target',
        {
          name: resolvedName,
          rootPath: validation.rootPath,
          metadata: parsedMetadata,
        },
        () =>
          pool.query(
            `INSERT INTO project_targets (
               name,
               root_path,
               github_repo_owner,
               github_repo_name,
               railway_project_id,
               railway_environment_id,
               railway_service_id,
               railway_service_name,
               browser_allowed_origins,
               updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
             ON CONFLICT (root_path)
             DO UPDATE SET
               name = EXCLUDED.name,
               github_repo_owner = EXCLUDED.github_repo_owner,
               github_repo_name = EXCLUDED.github_repo_name,
               railway_project_id = EXCLUDED.railway_project_id,
               railway_environment_id = EXCLUDED.railway_environment_id,
               railway_service_id = EXCLUDED.railway_service_id,
               railway_service_name = EXCLUDED.railway_service_name,
               browser_allowed_origins = EXCLUDED.browser_allowed_origins,
               updated_at = NOW()
             RETURNING id, name, root_path, created_at, updated_at,
               github_repo_owner, github_repo_name,
               railway_project_id, railway_environment_id, railway_service_id, railway_service_name,
               browser_allowed_origins`,
            [
              resolvedName,
              validation.rootPath,
              parsedMetadata.githubRepoOwner ?? null,
              parsedMetadata.githubRepoName ?? null,
              parsedMetadata.railwayProjectId ?? null,
              parsedMetadata.railwayEnvironmentId ?? null,
              parsedMetadata.railwayServiceId ?? null,
              parsedMetadata.railwayServiceName ?? null,
              JSON.stringify(parsedMetadata.browserAllowedOrigins ?? []),
            ]
          )
      );

      return result.rows[0];
    },

    async ensureProjectTarget(rootPath, options = {}) {
      if (!rootPath) {
        return null;
      }

      return this.addProject({
        name: options.name,
        rootPath,
        metadata: options.metadata,
      });
    },

    async getProject(id) {
      const result = await callPostgresTool(
        'get_project_target',
        { id },
        () =>
          pool.query(
            `SELECT id, name, root_path, created_at, updated_at,
                    github_repo_owner, github_repo_name,
                    railway_project_id, railway_environment_id, railway_service_id, railway_service_name,
                    browser_allowed_origins
             FROM project_targets
             WHERE id = $1`,
            [id]
          )
      );
      return result.rows[0] ?? null;
    },

    async getProjectByRootPath(rootPath) {
      const validation = await validateProjectPath(rootPath);
      const result = await callPostgresTool(
        'get_project_target_by_root_path',
        { rootPath: validation.rootPath },
        () =>
          pool.query(
            `SELECT id, name, root_path, created_at, updated_at,
                    github_repo_owner, github_repo_name,
                    railway_project_id, railway_environment_id, railway_service_id, railway_service_name,
                    browser_allowed_origins
             FROM project_targets
             WHERE root_path = $1`,
            [validation.rootPath]
          )
      );

      return result.rows[0] ?? null;
    },

    async deleteProject(id) {
      const result = await callPostgresTool(
        'delete_project_target',
        { id },
        () =>
          pool.query(
            `DELETE FROM project_targets
             WHERE id = $1
             RETURNING id, name, root_path, created_at, updated_at,
               github_repo_owner, github_repo_name,
               railway_project_id, railway_environment_id, railway_service_id, railway_service_name,
               browser_allowed_origins`,
            [id]
          )
      );

      return result.rows[0] ?? null;
    },

    validateProjectPath,
  };
}
