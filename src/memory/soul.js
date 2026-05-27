import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOUL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'soul.md'
);

let cachedSoul = null;

/**
 * Load Stallone's soul (identity + directives) from soul.md.
 * Returns the raw markdown string. Caches after first load.
 */
export async function loadSoul() {
  if (cachedSoul) {
    return cachedSoul;
  }

  try {
    cachedSoul = await fs.readFile(SOUL_PATH, 'utf8');
    return cachedSoul;
  } catch {
    return '';
  }
}

/**
 * Returns a condensed soul summary suitable for injection into
 * Gemini system prompts without blowing the token budget.
 * Extracts sections 1 (identity), 2 (directives), and 8 (lessons).
 */
export async function getSoulSummary() {
  const full = await loadSoul();
  if (!full) return '';

  const lines = full.split('\n');
  const keep = [];
  let inSection = false;
  let sectionCount = 0;

  for (const line of lines) {
    const isH2 = line.startsWith('## ');
    if (isH2) {
      const num = parseInt(line.replace('## ', ''), 10);
      inSection = num === 1 || num === 2 || num === 8;
      if (inSection) sectionCount++;
    }
    if (inSection) keep.push(line);
    if (sectionCount >= 3 && isH2 && keep.length > 10) break;
  }

  return keep.join('\n').trim();
}
