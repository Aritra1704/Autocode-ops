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

function patternKey(observation) {
  return String(observation ?? '').trim().slice(0, 80);
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
    async checkAndGenerate(taskCategory) {
      const result = await pool.query(
        `SELECT observation, times_applied, created_at
           FROM learnings
          WHERE category = $1
            AND confidence_score >= 7
          ORDER BY times_applied DESC, created_at DESC
          LIMIT 20`,
        [taskCategory]
      );

      const rows = result.rows;
      const groups = new Map();

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const key = patternKey(row.observation);
        if (!key) {
          continue;
        }

        const current = groups.get(key) ?? {
          count: 0,
          topObservation: row.observation,
          hasConsecutiveSuccesses: false,
        };

        current.count += 1;
        if (index > 0 && patternKey(rows[index - 1]?.observation) === key) {
          current.hasConsecutiveSuccesses = true;
        }

        groups.set(key, current);
      }

      const qualifyingPattern = [...groups.values()]
        .filter((group) => group.count >= 3 && group.hasConsecutiveSuccesses)
        .sort((left, right) => right.count - left.count)[0];

      const skillName = sanitizeName(taskCategory);
      if (!qualifyingPattern || !skillName) {
        return { generated: false, skillName: null };
      }

      const skillPath = path.join(skillsDir, `${skillName}.json`);
      if (await fileExists(skillPath)) {
        return { generated: false, skillName };
      }

      const definition = {
        name: skillName,
        description: qualifyingPattern.topObservation,
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

        await pool.query(
          `INSERT INTO skills (
             name,
             version,
             source_type,
             description,
             definition,
             updated_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (name)
           DO UPDATE
           SET definition = EXCLUDED.definition,
               version = EXCLUDED.version,
               source_type = EXCLUDED.source_type,
               description = EXCLUDED.description,
               updated_at = NOW()`,
          [
            definition.name,
            definition.version ?? 1,
            definition.source_type ?? 'generated',
            definition.description ?? '',
            JSON.stringify(definition),
          ]
        );

        synced += 1;
      }

      return { synced };
    },
  };
}
