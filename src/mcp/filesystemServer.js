import fs from 'node:fs/promises';
import path from 'node:path';

import { shouldIgnoreWorkspaceEntry } from '../project/contract.js';

const FILESYSTEM_TOOLS = [
  {
    name: 'make_dir',
    description: 'Create a directory inside the workspace.',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 file inside the workspace.',
  },
  {
    name: 'append_file',
    description: 'Append UTF-8 content to an existing or new file inside the workspace.',
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace.',
  },
  {
    name: 'list_files',
    description: 'List files and directories inside the workspace.',
  },
];

function assertRelativePath(value) {
  if (path.isAbsolute(value)) {
    throw new Error(`Absolute paths are not allowed: ${value}`);
  }
}

export function resolveWorkspacePath(workspaceRoot, relativePath = '.') {
  assertRelativePath(relativePath);

  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }

  return resolvedPath;
}

async function walkWorkspace(currentPath, workspaceRoot, recursive, limit, results) {
  if (results.length >= limit) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    if (results.length >= limit) {
      break;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(workspaceRoot, absolutePath) || '.';

    if (shouldIgnoreWorkspaceEntry(relativePath)) {
      continue;
    }

    results.push({
      path: relativePath,
      type: entry.isDirectory() ? 'directory' : 'file',
    });

    if (recursive && entry.isDirectory()) {
      await walkWorkspace(absolutePath, workspaceRoot, recursive, limit, results);
    }
  }
}

export async function collectWorkspaceSnapshot(workspaceRoot, options = {}) {
  const startPath = resolveWorkspacePath(workspaceRoot, options.path ?? '.');
  const recursive = options.recursive ?? true;
  const limit = options.limit ?? 100;
  const results = [];

  await walkWorkspace(startPath, workspaceRoot, recursive, limit, results);
  return results;
}

function workspaceArtifact(kind, absolutePath, metadata = {}) {
  return [
    {
      artifactType: kind,
      artifactPath: absolutePath,
      metadata,
    },
  ];
}

export function createFilesystemMcpServer() {
  return {
    name: 'filesystem',
    description: 'Standardized Stallone workspace file operations.',

    listTools() {
      return FILESYSTEM_TOOLS.map((tool) => ({ ...tool }));
    },

    async callTool(toolName, args = {}, context = {}) {
      const workspaceRoot = context.workspaceRoot;
      if (!workspaceRoot) {
        throw new Error('Filesystem MCP server requires workspaceRoot context.');
      }

      switch (toolName) {
        case 'make_dir': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          await fs.mkdir(absolutePath, { recursive: true });
          return {
            summary: `Created directory ${args.path}`,
            artifacts: workspaceArtifact('directory', absolutePath, {
              relativePath: args.path,
            }),
          };
        }

        case 'write_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);

          if (!args.overwrite) {
            try {
              await fs.access(absolutePath);
              throw new Error(`File already exists and overwrite=false: ${args.path}`);
            } catch (error) {
              if (error.code !== 'ENOENT') {
                throw error;
              }
            }
          }

          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, args.content, 'utf8');

          return {
            summary: `Wrote file ${args.path}`,
            artifacts: workspaceArtifact('file', absolutePath, {
              relativePath: args.path,
              bytesWritten: Buffer.byteLength(args.content, 'utf8'),
            }),
          };
        }

        case 'append_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.appendFile(absolutePath, args.content, 'utf8');

          return {
            summary: `Appended content to ${args.path}`,
            artifacts: workspaceArtifact('file', absolutePath, {
              relativePath: args.path,
              bytesAppended: Buffer.byteLength(args.content, 'utf8'),
            }),
          };
        }

        case 'read_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          const content = await fs.readFile(absolutePath, 'utf8');

          return {
            summary: `Read ${args.path}`,
            output: content.slice(0, args.maxChars ?? 8000),
            artifacts: [],
          };
        }

        case 'list_files': {
          const entries = await collectWorkspaceSnapshot(workspaceRoot, {
            path: args.path,
            recursive: args.recursive,
            limit: args.limit,
          });

          return {
            summary: `Listed ${entries.length} workspace entries`,
            output: entries,
            artifacts: [],
          };
        }

        default:
          throw new Error(`Unsupported filesystem MCP tool: ${toolName}`);
      }
    },
  };
}
