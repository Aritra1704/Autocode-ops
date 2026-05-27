import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readSnippet(filePath, maxChars) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.slice(0, maxChars).trim();
  } catch {
    return '';
  }
}

async function runCommand(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout).trim();
  } catch {
    return '';
  }
}

function appendSection(state, header, content, sourceName) {
  if (!content || state.context.length >= MAX_CHARS) {
    return;
  }

  const prefix = state.context.length > 0 ? '\n\n' : '';
  const section = `${prefix}## ${header}\n${content}`;
  const remainingChars = MAX_CHARS - state.context.length;

  if (remainingChars <= 0) {
    return;
  }

  state.context += section.slice(0, remainingChars);
  state.sources.push(sourceName);
}

export async function loadTaskContext(task, options = {}) {
  const state = {
    context: '',
    sources: [],
  };
  const taskBlock = [`Task ID: ${task?.id ?? ''}`, `Title: ${task?.title ?? ''}`];
  if (task?.description) {
    taskBlock.push(`Description: ${task.description}`);
  }
  if (task?.project_name) {
    taskBlock.push(`Project: ${task.project_name}`);
  }

  appendSection(state, 'Task', taskBlock.join('\n').trim(), 'task');

  const projectPath = task?.project_path ?? options.workspaceRoot ?? null;
  if (!projectPath || !(await pathExists(projectPath))) {
    return {
      context: state.context,
      tokenEstimate: Math.ceil(state.context.length / CHARS_PER_TOKEN),
      sources: state.sources,
    };
  }

  const readmePath = path.join(projectPath, 'README.md');
  appendSection(state, 'README', await readSnippet(readmePath, 800), 'readme');

  const packageJsonPath = path.join(projectPath, 'package.json');
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (await pathExists(packageJsonPath)) {
    appendSection(
      state,
      'Package',
      await readSnippet(packageJsonPath, 400),
      'package_json'
    );
  } else if (await pathExists(pyprojectPath)) {
    appendSection(
      state,
      'Pyproject',
      await readSnippet(pyprojectPath, 400),
      'pyproject'
    );
  }

  appendSection(
    state,
    'Git Log',
    await runCommand('git', ['log', '--oneline', '-10'], projectPath),
    'git_log'
  );

  appendSection(
    state,
    'File Tree',
    (
      await runCommand(
        'find',
        [
          '.',
          '-maxdepth',
          '3',
          '-type',
          'f',
          '-not',
          '-path',
          '*/node_modules/*',
          '-not',
          '-path',
          '*/.git/*',
        ],
        projectPath
      )
    ).slice(0, 600),
    'file_tree'
  );

  return {
    context: state.context,
    tokenEstimate: Math.ceil(state.context.length / CHARS_PER_TOKEN),
    sources: state.sources,
  };
}
