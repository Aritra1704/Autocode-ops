export function createModelPerformanceTracker(pool) {
  return {
    async recordSuccess(model, taskCategory, tokensUsed, durationMs) {
      const result = await pool.query(
        `INSERT INTO model_performance (
           model,
           task_category,
           success_count,
           fail_count,
           avg_tokens,
           p95_duration_ms,
           updated_at
         )
         VALUES ($1, $2, 1, 0, $3, $4, NOW())
         ON CONFLICT (model, task_category)
         DO UPDATE
         SET success_count = model_performance.success_count + 1,
             avg_tokens = ROUND(
               (
                 (COALESCE(model_performance.avg_tokens, 0)::numeric * model_performance.success_count)
                 + EXCLUDED.avg_tokens::numeric
               ) / (model_performance.success_count + 1),
               2
             ),
             p95_duration_ms = CASE
               WHEN model_performance.p95_duration_ms IS NULL THEN EXCLUDED.p95_duration_ms
               ELSE GREATEST(model_performance.p95_duration_ms, EXCLUDED.p95_duration_ms)
             END,
             updated_at = NOW()
         RETURNING *`,
        [model, taskCategory, tokensUsed, durationMs]
      );

      return result.rows[0];
    },

    async recordFailure(model, taskCategory) {
      const result = await pool.query(
        `INSERT INTO model_performance (
           model,
           task_category,
           success_count,
           fail_count,
           updated_at
         )
         VALUES ($1, $2, 0, 1, NOW())
         ON CONFLICT (model, task_category)
         DO UPDATE
         SET fail_count = model_performance.fail_count + 1,
             updated_at = NOW()
         RETURNING *`,
        [model, taskCategory]
      );

      return result.rows[0];
    },

    async getBestModel(taskCategory, candidates) {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return candidates?.[0];
      }

      const result = await pool.query(
        `SELECT model, success_count, fail_count
           FROM model_performance
          WHERE task_category = $1
            AND model = ANY($2::text[])`,
        [taskCategory, candidates]
      );

      const statsByModel = new Map(
        result.rows.map((row) => [
          row.model,
          {
            successCount: Number(row.success_count) || 0,
            failCount: Number(row.fail_count) || 0,
          },
        ])
      );

      let bestModel = candidates[0];
      let bestScore = -1;

      for (const candidate of candidates) {
        const stats = statsByModel.get(candidate);
        const total = (stats?.successCount ?? 0) + (stats?.failCount ?? 0);
        const successRate = total > 0 ? (stats.successCount ?? 0) / total : 0.5;

        if (successRate > bestScore) {
          bestModel = candidate;
          bestScore = successRate;
        }
      }

      return bestModel;
    },

    async getStats(model, taskCategory) {
      const result = await pool.query(
        `SELECT *
           FROM model_performance
          WHERE model = $1
            AND task_category = $2
          LIMIT 1`,
        [model, taskCategory]
      );

      return result.rows[0] ?? null;
    },
  };
}
