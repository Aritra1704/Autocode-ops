import fs from 'node:fs/promises';
import path from 'node:path';

function sanitizeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function scrubSensitive(text) {
  // TODO(privacy): implement scrubSensitive — see docs/PRIVACY_AND_SECRETS.md
  return text;
}

function extractKeywords(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4)
  );
}

function similarityScore(observationA, observationB) {
  const keywordsA = extractKeywords(observationA);
  const keywordsB = extractKeywords(observationB);

  if (keywordsA.size === 0 || keywordsB.size === 0) {
    return 0;
  }

  const intersection = [...keywordsA].filter((word) => keywordsB.has(word)).length;
  return intersection / Math.max(keywordsA.size, keywordsB.size);
}

function normalizeLearningRow(row) {
  return {
    category: row.category ?? 'execution',
    observation: String(row.observation ?? '').trim(),
    confidenceScore: Number.isFinite(row.confidenceScore)
      ? row.confidenceScore
      : Number.isFinite(row.confidence_score)
        ? row.confidence_score
        : 0,
  };
}

function clusterLearnings(rows) {
  const clusters = [];

  for (const row of rows) {
    if (!row.observation) {
      continue;
    }

    let bestCluster = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const clusterScore = Math.max(
        ...cluster.members.map((member) => similarityScore(member.observation, row.observation))
      );
      if (clusterScore >= 0.6 && clusterScore > bestScore) {
        bestCluster = cluster;
        bestScore = clusterScore;
      }
    }

    if (!bestCluster) {
      clusters.push({
        members: [row],
        topObservation: row.observation,
        topConfidenceScore: row.confidenceScore,
      });
      continue;
    }

    bestCluster.members.push(row);
    if (row.confidenceScore > bestCluster.topConfidenceScore) {
      bestCluster.topConfidenceScore = row.confidenceScore;
      bestCluster.topObservation = row.observation;
    }
  }

  return clusters;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function createSkillGenerator(pool, options = {}) {
  const skillsDir = options.skillsDir ?? path.join(process.cwd(), 'skills', 'generated');

  return {
    async checkAndGenerate(taskCategory, freshLearnings = null) {
      const skillName = sanitizeName(taskCategory);
      if (!skillName) {
        return { generated: false, skillName: null };
      }

      const rows = Array.isArray(freshLearnings)
        ? freshLearnings
            .map(normalizeLearningRow)
            .filter(
              (row) => row.category === taskCategory && row.confidenceScore >= 5 && row.observation
            )
        : (
            await pool.query(
              `SELECT
                 category,
                 observation,
                 confidence_score AS "confidenceScore",
                 created_at
               FROM learnings
              WHERE category = $1
                AND confidence_score >= 5
              ORDER BY times_applied DESC, created_at DESC
              LIMIT 20`,
              [taskCategory]
            )
          ).rows.map(normalizeLearningRow);

      const qualifyingCluster = clusterLearnings(rows)
        .filter((cluster) => cluster.members.length >= 3)
        .sort((left, right) => {
          // Prefer highest top confidence score first, then largest cluster
          if (right.topConfidenceScore !== left.topConfidenceScore) {
            return right.topConfidenceScore - left.topConfidenceScore;
          }
          return right.members.length - left.members.length;
        })[0];

      if (!qualifyingCluster) {
        return { generated: false, skillName };
      }

      const skillPath = path.join(skillsDir, `${skillName}.json`);
      if (await fileExists(skillPath)) {
        return { generated: false, skillName };
      }

      const definition = {
        name: skillName,
        description: scrubSensitive(qualifyingCluster.topObservation),
        version: 1,
        source_type: 'generated',
        steps: [],
      };

      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(skillPath, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
      console.log(`Generated skill: ${skillName} at ${skillPath}`);

      return { generated: true, skillName };
    },

    async syncToDatabase() {
      await fs.mkdir(skillsDir, { recursive: true });
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      let synced = 0;

      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name) !== '.json') {
          continue;
        }

        const filePath = path.join(skillsDir, entry.name);
        const fileContents = await fs.readFile(filePath, 'utf8');
        const definition = JSON.parse(fileContents);
        const definitionForDb = {
          ...definition,
          description: scrubSensitive(definition.description ?? ''),
        };

        await pool.query(
          `INSERT INTO skills (
             name,
             version,
             source_type,
             description,
             definition,
             is_enabled,
             updated_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, true, NOW())
           ON CONFLICT (name)
           DO UPDATE
           SET definition = EXCLUDED.definition,
               version = EXCLUDED.version,
               source_type = EXCLUDED.source_type,
               description = EXCLUDED.description,
               is_enabled = EXCLUDED.is_enabled,
               updated_at = NOW()`,
          [
            definitionForDb.name,
            definitionForDb.version ?? 1,
            definitionForDb.source_type ?? 'generated',
            definitionForDb.description,
            JSON.stringify(definitionForDb),
          ]
        );

        synced += 1;
      }

      return { synced };
    },
  };
}
