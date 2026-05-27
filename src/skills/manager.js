import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { config } from '../config.js';
import { getPool } from '../db/client.js';

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;

const skillStepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

const skillDefinitionSchema = z.object({
  name: z.string().regex(SKILL_NAME_PATTERN),
  version: z.number().int().positive().default(1),
  description: z.string().min(1).max(300),
  sourceType: z.enum(['builtin', 'generated', 'manual']).default('builtin'),
  isEnabled: z.boolean().default(true),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  inputDefaults: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(skillStepSchema).min(1).max(20),
});

function extractKeywords(text, limit = 10) {
  return [...new Set(
    `${text ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  )].slice(0, limit);
}

function normalizeSkillDefinition(raw) {
  const parsed = skillDefinitionSchema.parse(raw ?? {});

  if (parsed.steps.some((step) => step.tool === 'run_skill')) {
    throw new Error(
      `Skill ${parsed.name} is invalid: nested run_skill recursion is not allowed.`
    );
  }

  return parsed;
}

function renderTemplateString(value, variables) {
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, variableName) => {
    const variable = variables[variableName];

    if (variable === null || typeof variable === 'undefined') {
      return '';
    }

    if (typeof variable === 'string') {
      return variable;
    }

    if (typeof variable === 'number' || typeof variable === 'boolean') {
      return String(variable);
    }

    return JSON.stringify(variable);
  });
}

function renderTemplateValue(value, variables) {
  if (typeof value === 'string') {
    return renderTemplateString(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, variables));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, variables)])
    );
  }

  return value;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createSkillManager(options = {}) {
  const pool = options.pool ?? getPool();
  const logger = options.logger ?? null;
  const mcpRegistry = options.mcpRegistry ?? null;
  const rawBuiltInDirectory = options.builtInDirectory ?? config.skillsBuiltinDir;
  const builtInDirectory = path.isAbsolute(rawBuiltInDirectory)
    ? rawBuiltInDirectory
    : path.resolve(process.cwd(), rawBuiltInDirectory);
  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;

  let cachedSkills = [];

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  async function loadBuiltInDefinitions() {
    if (!(await pathExists(builtInDirectory))) {
      return [];
    }

    const entries = await fs.readdir(builtInDirectory, { withFileTypes: true });
    const definitions = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const absolutePath = path.join(builtInDirectory, entry.name);
      const raw = await fs.readFile(absolutePath, 'utf8');
      const parsed = normalizeSkillDefinition(JSON.parse(raw));
      definitions.push(parsed);
    }

    return definitions.sort((left, right) => left.name.localeCompare(right.name));
  }

  async function refreshCache() {
    const result = await callPostgresTool(
      'list_skills_catalog',
      {
        includeDisabled: true,
        includeDefinition: true,
        includeMetrics: false,
        limit: 1000,
      },
      () =>
        pool.query(
          `SELECT
             id,
             name,
             version,
             source_type,
             description,
             definition,
             is_enabled,
             updated_at
           FROM skills
           ORDER BY name ASC`
        )
    );

    cachedSkills = result.rows;
    return cachedSkills;
  }

  return {
    async syncRegistry() {
      const builtInSkills = await loadBuiltInDefinitions();
      let upserted = 0;

      for (const skill of builtInSkills) {
        const existingResult = await callPostgresTool(
          'get_skill_by_name',
          { name: skill.name },
          () =>
            pool.query(
              `SELECT id, version
               FROM skills
               WHERE name = $1
               LIMIT 1`,
              [skill.name]
            )
        );
        const existing = existingResult.rows[0] ?? null;

        await callPostgresTool(
          'upsert_skill_definition',
          {
            id: existing?.id ?? null,
            name: skill.name,
            version: Math.max(existing?.version ?? 0, skill.version),
            sourceType: 'builtin',
            description: skill.description,
            definition: {
              ...skill,
              version: Math.max(existing?.version ?? 0, skill.version),
            },
            isEnabled: skill.isEnabled,
          },
          () =>
            pool.query(
              `INSERT INTO skills (
                 name,
                 version,
                 source_type,
                 description,
                 definition,
                 is_enabled,
                 updated_at
               )
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
               ON CONFLICT (name)
               DO UPDATE
               SET
                 version = GREATEST(skills.version, EXCLUDED.version),
                 source_type = EXCLUDED.source_type,
                 description = EXCLUDED.description,
                 definition = EXCLUDED.definition,
                 updated_at = NOW()`,
              [
                skill.name,
                skill.version,
                'builtin',
                skill.description,
                JSON.stringify(skill),
                skill.isEnabled,
              ]
            )
        );

        upserted += 1;
      }

      await refreshCache();

      return {
        builtInDirectory,
        builtInsDiscovered: builtInSkills.length,
        builtInsUpserted: upserted,
        cachedSkills: cachedSkills.length,
      };
    },

    async listSkills(options = {}) {
      const includeDisabled = options.includeDisabled ?? true;
      const sourceType = options.sourceType ?? null;
      const limit = options.limit ?? 20;

      const result = await callPostgresTool(
        'list_skills_catalog',
        {
          includeDisabled,
          sourceType,
          limit,
          includeMetrics: true,
          includeDefinition: false,
        },
        () =>
          pool.query(
            `SELECT
               skills.id,
               skills.name,
               skills.version,
               skills.source_type,
               skills.description,
               skills.is_enabled,
               skills.updated_at,
               COALESCE(metrics.total_runs, 0)::int AS total_runs,
               COALESCE(metrics.success_runs, 0)::int AS success_runs,
               COALESCE(metrics.failed_runs, 0)::int AS failed_runs,
               metrics.last_run_at
             FROM skills
             LEFT JOIN (
               SELECT
                 skill_id,
                 COUNT(*) AS total_runs,
                 COUNT(*) FILTER (WHERE status = 'success') AS success_runs,
                 COUNT(*) FILTER (WHERE status = 'error') AS failed_runs,
                 MAX(created_at) AS last_run_at
               FROM skill_runs
               GROUP BY skill_id
             ) AS metrics
             ON metrics.skill_id = skills.id
             WHERE ($1::boolean OR skills.is_enabled = TRUE)
               AND ($2::text IS NULL OR skills.source_type = $2)
             ORDER BY skills.name ASC
             LIMIT $3`,
            [includeDisabled, sourceType, limit]
          )
      );

      return result.rows;
    },

    plannerSkillSummary(limit = 6) {
      const enabled = cachedSkills
        .filter((skill) => skill.is_enabled)
        .slice(0, limit)
        .map((skill) => `${skill.name} (v${skill.version}) - ${skill.description}`);

      if (enabled.length === 0) {
        return 'No enabled skills are currently registered.';
      }

      return enabled.map((line) => `- ${line}`).join('\n');
    },

    async setSkillEnabled(name, enabled) {
      const result = await callPostgresTool(
        'set_skill_enabled',
        { name, enabled },
        () =>
          pool.query(
            `UPDATE skills
             SET
               is_enabled = $2,
               updated_at = NOW()
             WHERE name = $1
             RETURNING id, name, source_type, version, is_enabled`,
            [name, enabled]
          )
      );

      const row = result.rows[0] ?? null;
      if (!row) {
        return null;
      }

      await refreshCache();
      return row;
    },

    async createGeneratedSkill(input = {}) {
      if (!config.skillsAllowGenerated) {
        throw new Error(
          'Generated skill creation is disabled. Set SKILLS_ALLOW_GENERATED=true to enable it.'
        );
      }

      if (input.confirmation !== 'ALLOW_GENERATED_SKILL') {
        throw new Error(
          'Generated skill creation requires explicit confirmation token: ALLOW_GENERATED_SKILL'
        );
      }

      const definition = normalizeSkillDefinition({
        ...input.definition,
        name: input.name,
        description: input.description,
        sourceType: 'generated',
        isEnabled: Boolean(input.enableRequested),
      });

      const existing = await callPostgresTool(
        'get_skill_by_name',
        { name: definition.name },
        () =>
          pool.query(
            `SELECT id, version
             FROM skills
             WHERE name = $1`,
            [definition.name]
          )
      );

      const previous = existing.rows[0] ?? null;
      const nextVersion = previous ? previous.version + 1 : 1;

      const result = await callPostgresTool(
        'upsert_skill_definition',
        {
          id: previous?.id ?? null,
          name: definition.name,
          version: nextVersion,
          sourceType: 'generated',
          description: definition.description,
          definition: { ...definition, version: nextVersion },
          isEnabled: Boolean(input.enableRequested),
        },
        () =>
          pool.query(
            `INSERT INTO skills (
               id,
               name,
               version,
               source_type,
               description,
               definition,
               is_enabled,
               updated_at
             )
             VALUES (
               COALESCE($1::uuid, gen_random_uuid()),
               $2,
               $3,
               'generated',
               $4,
               $5::jsonb,
               $6,
               NOW()
             )
             ON CONFLICT (name)
             DO UPDATE
             SET
               version = EXCLUDED.version,
               source_type = EXCLUDED.source_type,
               description = EXCLUDED.description,
               definition = EXCLUDED.definition,
               is_enabled = EXCLUDED.is_enabled,
               updated_at = NOW()
             RETURNING id, name, version, source_type, is_enabled`,
            [
              previous?.id ?? null,
              definition.name,
              nextVersion,
              definition.description,
              JSON.stringify({ ...definition, version: nextVersion }),
              Boolean(input.enableRequested),
            ]
          )
      );

      await refreshCache();
      return result.rows[0];
    },

    async suggestSkillsForTask(task, options = {}) {
      const queryText = `${task.title ?? ''} ${task.description ?? ''}`.trim();
      const keywords = extractKeywords(queryText, options.keywordLimit ?? 8);
      if (keywords.length === 0) {
        return [];
      }

      const patterns = keywords.map((keyword) => `%${keyword}%`);
      const limit = options.limit ?? 4;
      const result = await callPostgresTool(
        'search_enabled_skills',
        { patterns, limit },
        () =>
          pool.query(
            `SELECT
               name,
               version,
               description,
               source_type
             FROM skills
             WHERE is_enabled = TRUE
               AND (
                 name ILIKE ANY($1::text[])
                 OR description ILIKE ANY($1::text[])
                 OR definition::text ILIKE ANY($1::text[])
               )
             ORDER BY
               CASE source_type
                 WHEN 'builtin' THEN 1
                 WHEN 'manual' THEN 2
                 WHEN 'generated' THEN 3
                 ELSE 4
               END,
               updated_at DESC
             LIMIT $2`,
            [patterns, limit]
          )
      );

      return result.rows;
    },

    async executeSkill(input = {}) {
      const skillName = `${input.name ?? ''}`.trim();
      if (!skillName) {
        throw new Error('run_skill requires a non-empty skill name.');
      }

      const result = await callPostgresTool(
        'get_skill_by_name',
        { name: skillName },
        () =>
          pool.query(
            `SELECT
               id,
               name,
               version,
               source_type,
               definition,
               is_enabled
             FROM skills
             WHERE name = $1
             LIMIT 1`,
            [skillName]
          )
      );

      const skill = result.rows[0];
      if (!skill) {
        throw new Error(`Skill not found: ${skillName}`);
      }

      if (!skill.is_enabled) {
        throw new Error(`Skill is disabled: ${skillName}`);
      }

      if (skill.source_type === 'generated' && !config.skillsAllowGenerated) {
        throw new Error(
          `Generated skill blocked by policy: ${skillName}. Enable SKILLS_ALLOW_GENERATED explicitly.`
        );
      }

      const definition = normalizeSkillDefinition(skill.definition);
      const inputPayload = input.input ?? {};
      const variables = {
        ...definition.inputDefaults,
        ...inputPayload,
      };

      if (
        (typeof inputPayload.port === 'number' || typeof inputPayload.port === 'string') &&
        (inputPayload.servicePort === null || typeof inputPayload.servicePort === 'undefined')
      ) {
        variables.servicePort = String(inputPayload.port);
      }

      if (
        typeof inputPayload.projectName === 'string' &&
        inputPayload.projectName.trim().length > 0 &&
        (inputPayload.serviceRoot === null || typeof inputPayload.serviceRoot === 'undefined')
      ) {
        variables.serviceRoot = inputPayload.projectName.trim();
      }

      const startedAt = Date.now();
      const stepSummaries = [];
      const artifacts = [];
      let failure = null;

      try {
        for (const step of definition.steps) {
          const renderedArgs = renderTemplateValue(step.args, variables);
          const stepResult = await input.toolRunner(step.tool, renderedArgs, {
            workspaceRoot: input.workspaceRoot,
            taskId: input.taskId ?? null,
            invokedBySkill: definition.name,
          });

          stepSummaries.push(`${step.tool}: ${stepResult.summary}`);
          if (Array.isArray(stepResult.artifacts)) {
            artifacts.push(...stepResult.artifacts);
          }
        }
      } catch (error) {
        failure = error;
      }

      const durationMs = Date.now() - startedAt;
      const status = failure ? 'error' : 'success';
      const outputSummary =
        stepSummaries.length > 0
          ? stepSummaries.join(' | ').slice(0, 1400)
          : failure
            ? null
            : `Executed skill ${definition.name}`;

      await callPostgresTool(
        'insert_skill_run',
        {
          skillId: skill.id,
          taskId: input.taskId ?? null,
          skillVersion: skill.version,
          status,
          durationMs,
          errorMessage: failure?.message ?? null,
          inputPayload: input.input ?? {},
          outputSummary,
        },
        () =>
          pool.query(
            `INSERT INTO skill_runs (
               skill_id,
               task_id,
               skill_version,
               status,
               duration_ms,
               error_message,
               input_payload,
               output_summary,
               updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())`,
            [
              skill.id,
              input.taskId ?? null,
              skill.version,
              status,
              durationMs,
              failure?.message ?? null,
              JSON.stringify(input.input ?? {}),
              outputSummary,
            ]
          )
      );

      if (failure) {
        logger?.warn(
          { err: failure, skillName: definition.name, taskId: input.taskId ?? null },
          'Skill execution failed'
        );
        throw failure;
      }

      return {
        summary: `Executed skill ${definition.name}`,
        output: {
          skill: definition.name,
          version: skill.version,
          stepCount: definition.steps.length,
          stepSummaries,
        },
        artifacts,
      };
    },
  };
}
