import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const TOOL_DEFINITIONS = [
  {
    name: 'make_dir',
    description: 'Create a directory inside the workspace.',
    plannerArgs: '{"path":"docs"}',
    argsSchema: z.object({
      path: z.string().min(1),
    }),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 file inside the workspace.',
    plannerArgs:
      '{"path":"README.md","content":"Full file contents here","overwrite":true}',
    argsSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().default(true),
    }),
  },
  {
    name: 'append_file',
    description: 'Append UTF-8 content to an existing or new file inside the workspace.',
    plannerArgs: '{"path":"README.md","content":"Additional text"}',
    argsSchema: z.object({
      path: z.string().min(1),
      content: z.string().min(1),
    }),
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace.',
    plannerArgs: '{"path":"README.md","maxChars":4000}',
    argsSchema: z.object({
      path: z.string().min(1),
      maxChars: z.number().int().positive().max(50000).default(8000),
    }),
  },
  {
    name: 'list_files',
    description: 'List files and directories inside the workspace.',
    plannerArgs: '{"path":".","recursive":true,"limit":50}',
    argsSchema: z.object({
      path: z.string().default('.'),
      recursive: z.boolean().default(false),
      limit: z.number().int().positive().max(200).default(50),
    }),
  },
  {
    name: 'run_skill',
    description:
      'Execute an enabled stallone skill from the governed skill registry.',
    plannerArgs:
      '{"name":"scaffold_node_http_service","input":{"projectName":"phase4-sample-app"}}',
    argsSchema: z.object({
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
  },
  {
    name: 'surf_web',
    description: 'Fetch and extract text content from a public URL.',
    plannerArgs: '{"url":"https://example.com/docs"}',
    argsSchema: z.object({
      url: z.string().url(),
    }),
  },
  {
    name: 'run_terminal_command',
    description: 'Execute a bash command to fetch dependencies, run tests, or manage packages locally.',
    plannerArgs: '{"command":"npm install"}',
    argsSchema: z.object({
      command: z.string().min(1),
    }),
  },
  {
    name: 'browser_automate',
    description:
      'Drive an isolated browser profile for local UI testing with navigation, click/fill actions, screenshots, console capture, and DOM assertions.',
    plannerArgs:
      '{"url":"http://127.0.0.1:3000","actions":[{"type":"wait_for","selector":"body"},{"type":"assert_text","selector":"body","value":"Hello"}],"captureScreenshot":true}',
    argsSchema: z.object({
      url: z.string().url(),
      actions: z
        .array(
          z.object({
            type: z.enum(['click', 'fill', 'press', 'wait_for', 'assert_text']),
            selector: z.string().min(1),
            value: z.string().optional(),
            timeoutMs: z.number().int().positive().max(120000).optional(),
          })
        )
        .max(50)
        .default([]),
      screenshotPath: z.string().min(1).optional(),
      captureScreenshot: z.boolean().default(true),
      headless: z.boolean().default(true),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
      timeoutMs: z.number().int().positive().max(120000).optional(),
    }),
  },
  {
    name: 'bootstrap_model',
    description: 'Safely download massive external neural network weights (Civitai/HF) to the secure external SSD.',
    plannerArgs: '{"url":"https://civitai.com/api/...", "filename":"AnimeArt.safetensors"}',
    argsSchema: z.object({
      url: z.string().url(),
      filename: z.string().min(1),
    }),
  },
  {
    name: 'system_prune',
    description: 'Clean up temporary files, old logs, and build artifacts to free up disk space.',
    plannerArgs: '{"target":"logs","days":7}',
    argsSchema: z.object({
    target: z.enum(['logs', 'build_artifacts', 'temp_workspaces', 'backups']),
    days: z.number().int().positive().default(7),
    }),
    },
    {
      name: 'spawn_subtask',
      description: 'Create a new independent task in the stallone queue. Useful for decomposing a large HLD into smaller LLD stages.',
      plannerArgs: '{"title":"Implement User Auth","description":"Create the user login and registration endpoints as defined in the LLD."}',
      argsSchema: z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
        projectPath: z.string().optional(),
      }),
    },
    {
      name: 'schedule_task',
      description: 'Schedule a task to run in the future (e.g., at a specific ISO time or in a relative duration like "in 5 minutes").',
      plannerArgs: '{"title":"Security Scan","description":"Perform a full codebase audit.","runAt":"2026-05-20T09:00:00Z","priority":"medium"}',
      argsSchema: z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        runAt: z.string().min(1),
        priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
        projectPath: z.string().optional(),
      }),
    },
    {
      name: 'register_project',
      description: 'Register a local directory as a stallone project target. Idempotent - safe to call on an already-registered path.',
      plannerArgs: '{"name":"my-app","rootPath":"my-app"}',
      argsSchema: z.object({
        name: z.string().min(1).max(120),
        rootPath: z.string().min(1),
        githubRepoOwner: z.string().optional(),
        githubRepoName: z.string().optional(),
      }),
    },
    {
      name: 'search_files',
      description: 'Search for files in the workspace by name pattern or content string. Returns matching file paths.',
      plannerArgs: '{"pattern":"*.js","content_match":"createToolRegistry","root":"src"}',
      argsSchema: z.object({
        pattern: z.string().min(1),
        content_match: z.string().optional(),
        root: z.string().optional(),
      }),
    },
    {
      name: 'call_ollama_agent',
      description: 'Delegate a focused code generation or reasoning task to a local Ollama model. Returns the model\'s text response.',
      plannerArgs:
        '{"model":"qwen2.5-coder:7b","prompt":"Write a function to parse .env files","system_prompt":"You are a precise coding assistant.","temperature":0.2}',
      argsSchema: z.object({
        model: z.string().min(1),
        prompt: z.string().min(1),
        system_prompt: z.string().optional(),
        temperature: z.number().min(0).max(1).default(0.2),
      }),
    },
    {
      name: 'ask_human',
      description: 'Park the current task step and send a question to the human operator via Telegram. Returns after human responds or times out. Use only when genuinely stuck or the decision requires human judgment.',
      plannerArgs:
        '{"question":"Should I upgrade the production database first?","context":"The migration changes an indexed column type.","timeout_minutes":60}',
      argsSchema: z.object({
        question: z.string().min(1),
        context: z.string().optional(),
        timeout_minutes: z.number().positive().default(60),
      }),
    },
    {
      name: 'pull_ollama_model',
      description: 'Pull (download) an Ollama model if not already installed. Returns status.',
      plannerArgs: '{"model":"qwen2.5-coder:7b"}',
      argsSchema: z.object({
        model: z.string().min(1),
      }),
    },
    {
      name: 'patch_file',
      description: 'Replace an exact string in an existing file. Use this instead of write_file when modifying an existing source file — only the changed region is rewritten. Fails explicitly if oldContent is not found.',
      plannerArgs: '{"path":"src/index.js","oldContent":"app.listen(3000","newContent":"app.listen(process.env.PORT ?? 3000"}',
      argsSchema: z.object({
        path: z.string().min(1),
        oldContent: z.string().min(1),
        newContent: z.string(),
        encoding: z.enum(['utf8']).default('utf8'),
      }),
    },
    {
      name: 'git_status',
      description: 'List modified, staged, and untracked files in the project git repo. Call this before committing to confirm scope.',
      plannerArgs: '{}',
      argsSchema: z.object({}),
    },
    {
      name: 'git_diff',
      description: 'Show unstaged or staged changes as a unified diff. Use before committing to verify the exact lines changed.',
      plannerArgs: '{"staged":false}',
      argsSchema: z.object({
        staged: z.boolean().default(false),
        path: z.string().optional(),
        maxChars: z.number().int().positive().max(20000).default(8000),
      }),
    },
    {
      name: 'git_log',
      description: 'List recent commits with hash, author, and subject. Use to understand recent changes before planning edits.',
      plannerArgs: '{"limit":10}',
      argsSchema: z.object({
        limit: z.number().int().positive().max(50).default(10),
      }),
    },
    {
      name: 'get_task_status',
      description: 'Check the current status and result of a previously spawned task.',
      plannerArgs: '{"taskId":"uuid-here"}',
      argsSchema: z.object({
        taskId: z.string().uuid(),
      }),
    },
  ];
export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

export async function collectWorkspaceSnapshot(workspaceRoot, options = {}) {
  const { collectWorkspaceSnapshot: collectFilesystemSnapshot } = await import(
    '../mcp/filesystemServer.js'
  );
  return collectFilesystemSnapshot(workspaceRoot, options);
}

export function createToolRegistry(options = {}) {
  const skillManager = options.skillManager ?? null;
  let browserAutomation = options.browserAutomation ?? null;
  let orchestrator = options.orchestrator ?? null;
  let filesystemServer =
    options.filesystemServer ?? options.mcpRegistry?.getServer?.('filesystem') ?? null;
  const toolMap = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  const filesystemToolNames = new Set([
    'make_dir',
    'write_file',
    'append_file',
    'read_file',
    'list_files',
  ]);

  async function getFilesystemServer() {
    if (!filesystemServer) {
      const { createFilesystemMcpServer } = await import('../mcp/filesystemServer.js');
      filesystemServer = createFilesystemMcpServer();
    }
    return filesystemServer;
  }

  async function getBrowserAutomation() {
    if (!browserAutomation) {
      const { createBrowserAutomation } = await import('../browser/automation.js');
      browserAutomation = createBrowserAutomation();
    }
    return browserAutomation;
  }

  async function getRunTerminalCommand() {
    const { runTerminalCommand } = await import('../sandbox/manager.js');
    return runTerminalCommand;
  }

  async function getConfig() {
    const { config } = await import('../config.js');
    return config;
  }

  async function runGitInWorkspace(args, cwd) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return result.stdout?.trim() ?? '';
  }

  async function resolveSearchRoot(workspaceRoot, requestedRoot) {
    const resolvedConfig = await getConfig().catch(() => null);
    const defaultRoot =
      resolvedConfig?.stalloneWorkspaceRoot ??
      process.env.STALLONE_WORKSPACE_ROOT ??
      workspaceRoot;
    const searchRoot = requestedRoot
      ? path.isAbsolute(requestedRoot)
        ? requestedRoot
        : path.resolve(workspaceRoot, requestedRoot)
      : defaultRoot;
    return path.resolve(searchRoot);
  }

  async function collectMatchingFiles(searchRoot, pattern, limit = 50) {
    const normalizedPattern = pattern.toLowerCase();
    const results = [];
    const stack = [searchRoot];
    const wildcardToRegex = (value) =>
      new RegExp(
        `^${value
          .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/,/g, '\\,')}$`,
        'i'
      );
    const patternRegex = pattern.includes('*') ? wildcardToRegex(pattern) : null;
    const ignoredDirs = new Set(['.git', 'node_modules']);

    while (stack.length > 0 && results.length < limit) {
      const currentDir = stack.pop();
      let entries = [];
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (results.length >= limit) break;
        const absolutePath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name)) {
            stack.push(absolutePath);
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const relativePath = path.relative(searchRoot, absolutePath);
        const matchesPath = patternRegex
          ? patternRegex.test(relativePath) || patternRegex.test(entry.name)
          : relativePath.toLowerCase().includes(normalizedPattern);

        if (matchesPath) {
          results.push({ absolutePath, relativePath });
        }
      }
    }

    return results;
  }

  async function postJson(url, payload, timeoutMs) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(errorBody || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async function runBuiltInTool(name, args, context) {
    const workspaceRoot = context.workspaceRoot;

    if (filesystemToolNames.has(name)) {
      const server = await getFilesystemServer();
      return filesystemServer.callTool(name, args, { workspaceRoot });
    }

    switch (name) {
      case 'git_status': {
        const output = await runGitInWorkspace(['status', '--porcelain=v1'], workspaceRoot);
        const lines = output.split('\n').filter(Boolean).map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }));
        return { files: lines, count: lines.length };
      }

      case 'git_diff': {
        const { staged, path: diffPath, maxChars } = args;
        const diffArgs = ['diff'];
        if (staged) diffArgs.push('--staged');
        if (diffPath) diffArgs.push('--', diffPath);
        const output = await runGitInWorkspace(diffArgs, workspaceRoot);
        return { diff: output.slice(0, maxChars), truncated: output.length > maxChars };
      }

      case 'git_log': {
        const { limit } = args;
        const output = await runGitInWorkspace(['log', `--max-count=${limit}`, '--oneline', '--no-decorate'], workspaceRoot);
        const commits = output.split('\n').filter(Boolean).map((line) => ({
          hash: line.slice(0, 7),
          subject: line.slice(8),
        }));
        return { commits };
      }
      case 'spawn_subtask': {
        if (!orchestrator) {
          throw new Error('Orchestrator is not connected to tool registry.');
        }
        const task = await orchestrator.createTask(args.description, {
          title: args.title,
          priority: args.priority,
          projectPath: args.projectPath || workspaceRoot,
          source: 'spawn_tool',
        });
        return {
          summary: `Spawned sub-task: ${task.title} (ID: ${task.id})`,
          output: JSON.stringify({ taskId: task.id, status: task.status }),
          artifacts: [],
        };
      }

      case 'schedule_task': {
        if (!orchestrator) {
          throw new Error('Orchestrator is not connected to tool registry.');
        }

        let scheduledAt = new Date(args.runAt);
        if (isNaN(scheduledAt.getTime())) {
          // Simple relative parsing: "in 5 minutes", "in 2 hours"
          const match = args.runAt.match(/in (\d+) (minute|hour|day)s?/i);
          if (match) {
            const amount = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();
            const now = new Date();
            if (unit.startsWith('minute')) now.setMinutes(now.getMinutes() + amount);
            else if (unit.startsWith('hour')) now.setHours(now.getHours() + amount);
            else if (unit.startsWith('day')) now.setDate(now.getDate() + amount);
            scheduledAt = now;
          } else {
            throw new Error(`Invalid date or duration format: ${args.runAt}`);
          }
        }

        const task = await orchestrator.createTask(args.description, {
          title: args.title,
          priority: args.priority,
          projectPath: args.projectPath || workspaceRoot,
          source: 'schedule_tool',
          scheduledAt,
        });

        return {
          summary: `Scheduled task: ${task.title} for ${scheduledAt.toISOString()} (ID: ${task.id})`,
          output: JSON.stringify({
            taskId: task.id,
            status: task.status,
            scheduledAt: scheduledAt.toISOString(),
          }),
          artifacts: [],
        };
      }

      case 'get_task_status': {
        if (!orchestrator) {
          throw new Error('Orchestrator is not connected to tool registry.');
        }
        const task = await orchestrator.getTaskDetails(args.taskId);
        if (!task) {
          throw new Error(`Task not found: ${args.taskId}`);
        }
        return {
          summary: `Task ${args.taskId} status: ${task.status}`,
          output: JSON.stringify({
            taskId: task.id,
            status: task.status,
            completedAt: task.completed_at,
            result: task.result,
          }),
          artifacts: [],
        };
      }

      case 'register_project': {
        const { name: projectName, rootPath, githubRepoOwner, githubRepoName } = args;
        const absRoot = path.isAbsolute(rootPath)
          ? rootPath
          : path.resolve(workspaceRoot, rootPath);

        const projectService = orchestrator?.projectService ?? null;
        if (!projectService) {
          throw new Error('register_project: projectService is not wired to the tool registry');
        }

        const record = await projectService.addProject({
          name: projectName,
          rootPath: absRoot,
          metadata: {
            ...(githubRepoOwner ? { githubRepoOwner } : {}),
            ...(githubRepoName ? { githubRepoName } : {}),
          },
        });

        return {
          summary: `Registered project: ${record.name} (ID: ${record.id})`,
          output: JSON.stringify({ registered: true, id: record.id, name: record.name, rootPath: record.root_path }),
          artifacts: [],
        };
      }

      case 'search_files': {
        const searchRoot = await resolveSearchRoot(workspaceRoot, args.root);
        const matches = await collectMatchingFiles(searchRoot, args.pattern, 50);
        const filteredMatches = [];

        for (const match of matches) {
          if (!args.content_match) {
            filteredMatches.push(match.relativePath);
            continue;
          }

          try {
            const fileContent = await fs.readFile(match.absolutePath, 'utf8');
            if (fileContent.includes(args.content_match)) {
              filteredMatches.push(match.relativePath);
            }
          } catch {
            // Ignore unreadable or non-UTF8 files.
          }

          if (filteredMatches.length >= 50) break;
        }

        return {
          root: searchRoot,
          matches: filteredMatches.slice(0, 50),
        };
      }

      case 'call_ollama_agent': {
        try {
          const resolvedConfig = await getConfig();
          const baseUrl = resolvedConfig.ollamaBaseUrl.replace(/\/$/, '');
          const data = await postJson(
            `${baseUrl}/api/generate`,
            {
              model: args.model,
              prompt: args.prompt,
              system: args.system_prompt,
              options: {
                temperature: args.temperature,
              },
              stream: false,
            },
            120000
          );
          return data.response ?? '';
        } catch (error) {
          throw new Error(error.message);
        }
      }

      case 'ask_human': {
        console.log(`[ask_human] Question: ${args.question}`);
        return {
          status: 'stub',
          message: 'Telegram delegation not yet wired - question logged only.',
        };
      }

      case 'pull_ollama_model': {
        const resolvedConfig = await getConfig();
        const baseUrl = resolvedConfig.ollamaBaseUrl.replace(/\/$/, '');
        await postJson(
          `${baseUrl}/api/pull`,
          {
            name: args.model,
            stream: false,
          },
          600000
        );

        return {
          pulled: true,
          model: args.model,
        };
      }

      case 'patch_file': {
        const { path: relPath, oldContent, newContent } = args;
        const absPath = path.resolve(workspaceRoot, relPath);

        // Safety: path must stay inside workspace
        const rel = path.relative(workspaceRoot, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`patch_file: path escapes workspace root: ${relPath}`);
        }

        const original = await fs.readFile(absPath, 'utf8');

        if (!original.includes(oldContent)) {
          throw new Error(
            `patch_file: oldContent not found in ${relPath}. ` +
            `First 120 chars of file: ${original.slice(0, 120).replace(/\n/g, '\\n')}`
          );
        }

        // Only replace the first occurrence — explicit and auditable
        const patched = original.replace(oldContent, newContent);
        await fs.writeFile(absPath, patched, 'utf8');

        return {
          patched: true,
          path: relPath,
          bytesChanged: newContent.length - oldContent.length,
        };
      }

      case 'surf_web': {
        try {
          const response = await fetch(args.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          const cleanText = text
            .replace(/<style[^>]*>.*<\/style>/gis, '')
            .replace(/<script[^>]*>.*<\/script>/gis, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 15000);
            
          return {
            summary: `Fetched text from ${args.url}`,
            output: cleanText || 'No visible text found on page.',
            artifacts: [],
          };
        } catch (error) {
          throw new Error(`Failed to surf web: ${error.message}`);
        }
      }

      case 'run_terminal_command': {
        const runTerminalCommand = await getRunTerminalCommand();
        const result = await runTerminalCommand({
          command: args.command,
          workspaceRoot,
        });
        return {
          summary: `Executed terminal command: ${args.command}`,
          output: result.output.length > 8000 ? result.output.slice(0, 8000) + '... (truncated)' : result.output,
          artifacts: [],
        };
      }

      case 'browser_automate': {
        const automation = await getBrowserAutomation();
        return automation.runScenario(args, {
          workspaceRoot,
          projectTarget: context.projectTarget ?? null,
          taskId: context.taskId ?? null,
        });
      }

      case 'bootstrap_model': {
        const ssdPath = process.env.OLLAMA_MODELS || '/Volumes/Ari_SSD_01/ollama-models';
        const absolutePath = path.join(ssdPath, args.filename);

        const command = `curl -L "${args.url}" -o "${absolutePath}"`;
        const runTerminalCommand = await getRunTerminalCommand();
        const result = await runTerminalCommand({
          command,
          workspaceRoot,
          timeoutMs: 900000, 
        });

        return {
          summary: `Downloaded external model to ${absolutePath}`,
          output: result.output,
          artifacts: [],
        };
      }

      case 'system_prune': {
        let count = 0;
        const now = Date.now();
        const maxAgeMs = args.days * 24 * 60 * 60 * 1000;

        const cleanupDir = async (dirPath, filter = () => true) => {
          try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dirPath, entry.name);
              const stats = await fs.stat(fullPath);
              if (now - stats.mtimeMs > maxAgeMs && filter(entry, fullPath)) {
                await fs.rm(fullPath, { recursive: true, force: true });
                count++;
              }
            }
          } catch (err) {
            // Ignore missing directories
          }
        };

        if (args.target === 'logs') {
          await cleanupDir(path.join(process.cwd(), 'logs'), (e) => e.name.endsWith('.log'));
        } else if (args.target === 'backups') {
          await cleanupDir(path.join(process.cwd(), 'db/backups'), (e) => e.name.endsWith('.sql'));
        } else if (args.target === 'build_artifacts') {
          const resolvedConfig = await getConfig().catch(() => null);
          const workspaceProjectsRoot =
            resolvedConfig?.stalloneWorkspaceRoot || process.cwd();
          try {
            const projects = await fs.readdir(workspaceProjectsRoot, { withFileTypes: true });
            for (const project of projects) {
              if (project.isDirectory()) {
                const projectPath = path.join(workspaceProjectsRoot, project.name);
                await cleanupDir(path.join(projectPath, 'dist'));
                await cleanupDir(path.join(projectPath, 'build'));
                await cleanupDir(path.join(projectPath, '.cache'));
              }
            }
          } catch (err) {}
        }

        return {
          summary: `System prune completed for ${args.target}. Removed ${count} items.`,
          output: `Pruned ${count} items from ${args.target} target.`,
          artifacts: [],
        };
      }

      default:
        throw new Error(`Unhandled stallone tool: ${name}`);
    }
  }

  return {
    listTools() {
      return TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
    },

    plannerCatalog() {
      const baseCatalog = TOOL_DEFINITIONS.map(
        (tool) =>
          `- ${tool.name}: ${tool.description} Args example: ${tool.plannerArgs}`
      ).join('\n');

      const skillSummary =
        typeof skillManager?.plannerSkillSummary === 'function'
          ? skillManager.plannerSkillSummary()
          : 'Skill manager not configured.';

      return `${baseCatalog}\n\nEnabled skill registry:\n${skillSummary}`;
    },

    async runTool(name, rawArgs, context) {
      const definition = toolMap.get(name);
      if (!definition) {
        throw new Error(`Unsupported stallone tool: ${name}`);
      }

      const args = definition.argsSchema.parse(rawArgs ?? {});

      if (name === 'run_skill') {
        if (!skillManager?.executeSkill) {
          throw new Error('Skill manager is not configured.');
        }

        if (context?.invokedBySkill) {
          throw new Error('Nested run_skill execution is blocked by policy.');
        }

        return skillManager.executeSkill({
          name: args.name,
          input: args.input,
          workspaceRoot: context.workspaceRoot,
          taskId: context.taskId ?? null,
          toolRunner: async (childToolName, childArgs) => {
            if (childToolName === 'run_skill') {
              throw new Error('Skills cannot invoke run_skill recursively.');
            }

            const childDefinition = toolMap.get(childToolName);
            if (!childDefinition) {
              throw new Error(`Unsupported skill tool: ${childToolName}`);
            }

            const validatedChildArgs = childDefinition.argsSchema.parse(childArgs ?? {});
            return runBuiltInTool(childToolName, validatedChildArgs, {
              ...context,
              invokedBySkill: args.name,
            });
          },
        });
      }

      return runBuiltInTool(name, args, context);
    },

    setOrchestrator(instance) {
      orchestrator = instance;
    },
  };
}
