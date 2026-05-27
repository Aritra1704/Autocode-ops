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

export async function writeFile(input) {
  const prompt = `Write the complete contents of ${input.filePath}.\nTask: ${input.taskDescription}\n${
    input.context ? `Context:\n${input.context}` : ''
  }`;
  const payload = await requestOllama(
    {
      model: config.ollamaModelCoder || 'qwen2.5-coder:7b',
      system:
        'You are a precise code generator. Output ONLY the file content. No markdown fences, no explanation.',
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
      },
    },
    120_000
  );
  const content = stripMarkdownFences(payload?.response ?? '');
  const resolvedPath = path.resolve(input.workspaceRoot, input.filePath);

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content, 'utf8');

  return {
    written: true,
    path: resolvedPath,
    bytesWritten: content.length,
  };
}
