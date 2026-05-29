import fs from 'node:fs/promises';

import pino from 'pino';

import { config } from '../config.js';

const logger = pino({ name: 'stallone' });
const LOW_DISK_WARNING_BYTES = 25 * 1024 * 1024 * 1024;
const MAX_LOADED_MODELS = 3;

function parseTimestamp(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

export async function checkAndEvictIfNeeded() {
  const baseUrl = config.ollamaBaseUrl.replace(/\/$/, '');

  try {
    const response = await fetch(`${baseUrl}/api/ps`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama /api/ps failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];

    if (models.length >= MAX_LOADED_MODELS) {
      const lruModel = [...models].sort(
        (left, right) => parseTimestamp(left?.expires_at) - parseTimestamp(right?.expires_at)
      )[0];

      if (lruModel?.name) {
        const evictResponse = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: lruModel.name,
            keep_alive: '0',
            stream: false,
          }),
        });

        if (!evictResponse.ok) {
          const text = await evictResponse.text();
          throw new Error(
            `Ollama eviction failed (${evictResponse.status}): ${text.slice(0, 200)}`
          );
        }

        logger.info(`Evicted model ${lruModel.name} to stay within 2-model limit`);
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Model resource guard failed during Ollama model check');
  }

  try {
    const stats = await fs.statfs(config.stalloneWorkspaceRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);

    if (freeBytes < LOW_DISK_WARNING_BYTES) {
      logger.warn('Low disk space — pulling a new Ollama model may fail');
    }
  } catch (error) {
    logger.error({ err: error }, 'Model resource guard failed during disk space check');
  }
}
