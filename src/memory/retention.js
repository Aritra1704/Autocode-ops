import { config } from '../config.js';

export function getMemoryRetentionPolicy(overrides = {}) {
  return {
    enabled: overrides.enabled ?? config.memoryRetentionEnabled,
    activeDays: Math.max(1, Number(overrides.activeDays ?? config.memoryRetentionActiveDays) || 30),
    archivedDays: Math.max(
      1,
      Number(overrides.archivedDays ?? config.memoryRetentionArchivedDays) || 7
    ),
    orphanDays: Math.max(1, Number(overrides.orphanDays ?? config.memoryRetentionOrphanDays) || 14),
    intervalMs: Math.max(
      60_000,
      Number(overrides.intervalMs ?? config.memoryRetentionIntervalMs) || 21_600_000
    ),
    maxPrune: Math.max(
      1,
      Math.min(Number(overrides.maxPrune ?? config.memoryRetentionMaxPrune) || 500, 5000)
    ),
  };
}

function buildIntervalLiteral(days) {
  return `${Math.max(1, Number(days) || 1)} days`;
}

export async function pruneMemoryArtifactsWithPool(pool, policy, options = {}) {
  const normalizedPolicy = getMemoryRetentionPolicy(policy);
  const maxRows = Math.max(
    1,
    Math.min(Number(options.maxRows ?? normalizedPolicy.maxPrune) || normalizedPolicy.maxPrune, 5000)
  );

  if (!normalizedPolicy.enabled) {
    return {
      policy: normalizedPolicy,
      expiredCount: 0,
      archivedCount: 0,
      deletedCount: 0,
      updatedAt: new Date().toISOString(),
      skipped: true,
    };
  }

  const orphanInterval = buildIntervalLiteral(normalizedPolicy.orphanDays);
  const activeInterval = buildIntervalLiteral(normalizedPolicy.activeDays);
  const archivedInterval = buildIntervalLiteral(normalizedPolicy.archivedDays);

  const archivedResult = await pool.query(
    `WITH candidates AS (
       SELECT id
       FROM memory_artifacts
       WHERE task_id IS NULL
         AND chat_session_id IS NULL
         AND archived_at IS NULL
         AND created_at < NOW() - $1::interval
       ORDER BY created_at ASC
       LIMIT $2
     )
     UPDATE memory_artifacts
     SET archived_at = NOW(),
         expires_at = COALESCE(expires_at, NOW())
     WHERE id IN (SELECT id FROM candidates)
     RETURNING id`,
    [orphanInterval, maxRows]
  );

  const expiredResult = await pool.query(
    `WITH candidates AS (
       SELECT id
       FROM memory_artifacts
       WHERE archived_at IS NULL
         AND expires_at IS NULL
         AND created_at < NOW() - $1::interval
       ORDER BY created_at ASC
       LIMIT $2
     )
     UPDATE memory_artifacts
     SET expires_at = NOW()
     WHERE id IN (SELECT id FROM candidates)
     RETURNING id`,
    [activeInterval, maxRows]
  );

  const deletedResult = await pool.query(
    `WITH candidates AS (
       SELECT id
       FROM memory_artifacts
       WHERE (
         (archived_at IS NOT NULL AND archived_at < NOW() - $1::interval)
         OR (expires_at IS NOT NULL AND expires_at < NOW() - $1::interval)
       )
       ORDER BY created_at ASC
       LIMIT $2
     )
     DELETE FROM memory_artifacts
     WHERE id IN (SELECT id FROM candidates)
     RETURNING id`,
    [archivedInterval, maxRows]
  );

  return {
    policy: normalizedPolicy,
    expiredCount: expiredResult.rowCount ?? 0,
    archivedCount: archivedResult.rowCount ?? 0,
    deletedCount: deletedResult.rowCount ?? 0,
    updatedAt: new Date().toISOString(),
    skipped: false,
  };
}
