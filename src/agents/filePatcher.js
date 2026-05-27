import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function stripMarkdownFences(content) {
  const trimmed = String(content ?? '').trim();
  const fencedMatch = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fencedMatch ? fencedMatch[1] : trimmed;
}

function countLines(content) {
  if (!content) {
    return 0;
  }

  return String(content).split('\n').length;
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
      const text = await response.text();
      throw new Error(`Ollama request failed with status ${response.status}: ${text.slice(0, 200)}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(error?.message ?? 'Ollama request failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function patchFile(input) {
  const resolvedPath = path.resolve(input.workspaceRoot, input.filePath);
  let existingContent;

  try {
    existingContent = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read file ${resolvedPath}: ${error?.message ?? 'read error'}`);
  }

  const payload = await requestOllama(
    {
      model: config.ollamaModelCoder || 'qwen2.5-coder:7b',
      system:
        'You are a surgical code editor. Output ONLY the complete updated file content. No explanation.',
      prompt: `Edit this file to complete the task.\nFile: ${input.filePath}\nTask: ${
        input.taskDescription
      }\n${input.context ?? ''}\n\nCurrent content:\n${existingContent}`,
      stream: false,
      options: {
        temperature: 0.1,
      },
    },
    180_000
  );
  const updatedContent = stripMarkdownFences(payload?.response ?? '');

  await fs.writeFile(resolvedPath, updatedContent, 'utf8');

  return {
    patched: true,
    path: resolvedPath,
    originalLines: countLines(existingContent),
    newLines: countLines(updatedContent),
  };
}
