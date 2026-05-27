import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function requestOllama(body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${trimTrailingSlash(config.ollamaBaseUrl)}/api/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const trimmed = String(text ?? '').trim();
  return JSON.parse(trimmed);
}

export async function routeFileEdit(input) {
  const resolvedPath = path.resolve(input.workspaceRoot, input.filePath);

  if (!(await pathExists(resolvedPath))) {
    return { decision: 'write', reason: 'file does not exist' };
  }

  try {
    const payload = await requestOllama(
      {
        model: config.ollamaModelRouter || 'llama3.2:3b',
        system:
          'You are a file edit router. Reply with JSON only: {"decision": "write" or "patch", "reason": "one sentence"}',
        prompt: [
          `File: ${input.filePath}`,
          `Task: ${input.taskDescription}`,
          'Decide whether to overwrite the whole file or patch a specific section.',
        ].join('\n'),
        stream: false,
        options: {
          temperature: 0,
        },
      },
      30_000
    );
    const parsed = extractJson(payload?.response);

    if (parsed?.decision === 'write' || parsed?.decision === 'patch') {
      return {
        decision: parsed.decision,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'model provided no reason',
      };
    }

    return { decision: 'patch', reason: 'parse error, defaulting to patch' };
  } catch {
    return { decision: 'patch', reason: 'parse error, defaulting to patch' };
  }
}
