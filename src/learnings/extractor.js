import { parseModelRef } from '../llm/base.js';

function extractJsonArrayText(value) {
  const trimmed = value.trim();

  // Already an array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  // Model returned a single object — wrap it in an array
  if (trimmed.startsWith('{')) {
    const objStart = 0;
    let depth = 0;
    let objEnd = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
    }
    if (objEnd !== -1) {
      return `[${trimmed.slice(objStart, objEnd + 1)}]`;
    }
  }

  // Try to find an array somewhere in the text
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array or object found in learning extractor response');
  }

  return trimmed.slice(start, end + 1);
}

function normalizeKeywords(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(
    values
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
      .filter((item) => item.length >= 3)
  )].slice(0, 8);
}

function scrubSensitive(text) {
  // TODO(privacy): implement scrubSensitive — see docs/PRIVACY_AND_SECRETS.md
  return text;
}

function buildStepSummary(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'none';
  }

  return steps
    .map((step) => {
      const detail = String(step.reason ?? step.summary ?? 'completed')
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      const outcome =
        step.success === false
          ? `failed: ${detail || 'unknown'}`
          : step.success === true
            ? `succeeded: ${detail || 'ok'}`
            : detail || 'completed';
      return `- step ${step.step}: ${step.tool} — ${outcome}`;
    })
    .join('\n');
}

function buildPrompt(task, result) {
  const toolsUsed = [...new Set(result.steps?.map((step) => step.tool) ?? [])];
  const failedSteps = result.steps?.filter((step) => step.success === false) ?? [];

  return `You are extracting reusable engineering learnings from a Stallone task.
Return only a JSON array and nothing else.

Task title:
${task.title}

Task description:
${task.description}

Steps completed:
${result.stepsCompleted ?? 0}

Outcome:
${result.success ? 'success' : `failed — ${result.error ?? 'unknown'}`}

Tools used:
${toolsUsed.join(', ') || 'none'}

Failed steps:
${failedSteps.map((step) => step.tool).join(', ') || 'none'}

Step log:
${buildStepSummary(result.steps)}

Return 1-4 items.
JSON schema for each item:
{
  "category": "planning | execution | verification | publishing | deployment | self-healing",
  "observation": "specific, reusable lesson",
  "keywords": ["keyword1", "keyword2"],
  "confidenceScore": 1-10
}`;
}

function parseModelOutput(text) {
  const candidate = JSON.parse(extractJsonArrayText(text));

  if (!Array.isArray(candidate)) {
    throw new Error('Learning extractor must return an array');
  }

  return candidate
    .map((item) => ({
      category:
        typeof item?.category === 'string' && item.category.trim().length > 0
          ? item.category.trim().slice(0, 50)
          : 'execution',
      observation:
        typeof item?.observation === 'string' ? item.observation.trim() : '',
      keywords: normalizeKeywords(item?.keywords),
      confidenceScore: Number.isFinite(item?.confidenceScore)
        ? Math.max(1, Math.min(10, Math.round(item.confidenceScore)))
        : 6,
    }))
    .filter((item) => item.observation.length >= 10)
    .slice(0, 4);
}

function buildFallback(task, result) {
  const items = [];
  const toolsUsed = [...new Set(result.steps?.map((step) => step.tool) ?? [])];
  const failedSteps = result.steps?.filter((step) => step.success === false) ?? [];

  items.push({
    category: result.success ? 'execution' : 'verification',
    observation: result.success
      ? `Task "${task.title}" completed successfully after ${result.stepsCompleted ?? 0} step(s) using ${toolsUsed.join(', ') || 'no recorded tools'}.`
      : `Task "${task.title}" failed after ${result.stepsCompleted ?? 0} step(s) with error: ${result.error ?? 'unknown error'}.`,
    keywords: result.success ? ['execution', 'success'] : ['verification', 'failure'],
    confidenceScore: result.success ? 6 : 7,
  });

  if (toolsUsed.length > 0) {
    items.push({
      category: 'execution',
      observation: `Task "${task.title}" relied on these tools: ${toolsUsed.join(', ')}.`,
      keywords: [...toolsUsed, 'tooling'],
      confidenceScore: 6,
    });
  }

  if (failedSteps.length > 0) {
    items.push({
      category: 'verification',
      observation: `Failures during task "${task.title}" involved: ${failedSteps.map((step) => step.tool).join(', ')}.`,
      keywords: failedSteps.map((step) => step.tool),
      confidenceScore: 7,
    });
  }

  return items.slice(0, 4);
}

function sanitizeLearning(item) {
  return {
    ...item,
    observation: scrubSensitive(item.observation),
    keywords: item.keywords.map((keyword) => scrubSensitive(keyword)),
  };
}

async function persistLearnings(pool, taskId, items) {
  if (!pool || items.length === 0) {
    return;
  }

  for (const item of items) {
    await pool.query(
      `INSERT INTO learnings (
         task_id,
         category,
         observation,
         keywords,
         confidence_score
       )
       VALUES ($1, $2, $3, $4::text[], $5)`,
      [taskId ?? null, item.category, item.observation, item.keywords, item.confidenceScore]
    );
  }
}

export function createLearningExtractor({ client, modelSelector, pool = null }) {
  return {
    async extract(task, result) {
      const model = parseModelRef(modelSelector.select('fast')).model;
      let learnings = [];

      try {
        const response = await client.generate({
          model,
          prompt: buildPrompt(task, result),
          format: 'json',
          options: {
            temperature: 0,
          },
        });

        const parsed = parseModelOutput(response.responseText);
        if (parsed.length > 0) {
          learnings = parsed;
        }
      } catch {
        // Non-blocking: fallback below.
      }

      if (learnings.length === 0) {
        learnings = buildFallback(task, result);
      }

      const sanitized = learnings.map(sanitizeLearning);
      await persistLearnings(pool, task.id, sanitized);
      return sanitized;
    },
  };
}
