import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export function createContextCompactor(pool) {
  return {
    async saveCheckpoint(taskId, snapshot) {
      const result = await pool.query(
        `INSERT INTO context_checkpoints (
           task_id,
           window_number,
           steps_completed,
           steps_remaining,
           file_hashes,
           key_decisions,
           tokens_used
         )
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7)
         RETURNING *`,
        [
          taskId,
          snapshot.windowNumber,
          JSON.stringify(snapshot.stepsCompleted ?? []),
          JSON.stringify(snapshot.stepsRemaining ?? []),
          JSON.stringify(snapshot.fileHashes ?? {}),
          JSON.stringify(snapshot.keyDecisions ?? []),
          snapshot.tokensUsed ?? null,
        ]
      );

      return result.rows[0];
    },

    async loadLatestCheckpoint(taskId) {
      const result = await pool.query(
        `SELECT *
           FROM context_checkpoints
          WHERE task_id = $1
          ORDER BY window_number DESC
          LIMIT 1`,
        [taskId]
      );

      return result.rows[0] ?? null;
    },

    async listCheckpoints(taskId) {
      const result = await pool.query(
        `SELECT *
           FROM context_checkpoints
          WHERE task_id = $1
          ORDER BY window_number ASC`,
        [taskId]
      );

      return result.rows;
    },

    async hashFile(filePath) {
      try {
        const content = await fs.readFile(filePath);
        return createHash('sha256').update(content).digest('hex');
      } catch {
        return null;
      }
    },

    async buildFileHashes(filePaths) {
      const entries = await Promise.all(
        (filePaths ?? []).map(async (filePath) => [filePath, await this.hashFile(filePath)])
      );

      return Object.fromEntries(entries);
    },
  };
}
