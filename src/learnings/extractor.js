function extractJsonArrayText(value) {
  const trimmed = value.trim();

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in learning extractor response');
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

function buildPrompt(task, result) {
  const repairState = result.repairState ?? {};
  return `You are extracting reusable engineering learnings from a Stallone task.
Return only a JSON array and nothing else.

Task title:
${task.title}

Task description:
${task.description}

Plan summary:
${result.plan?.summary ?? 'n/a'}

Verification:
status=${result.verification?.review?.status ?? 'unknown'}
summary=${result.verification?.review?.summary ?? 'n/a'}

Publication:
attempted=${result.publication?.attempted === true ? 'yes' : 'no'}
published=${result.publication?.published === true ? 'yes' : 'no'}
error=${result.publication?.error?.message ?? 'none'}

Repair:
status=${repairState.status ?? 'none'}
attemptCount=${repairState.attemptCount ?? 0}
maxAttempts=${repairState.maxAttempts ?? 0}
lastOutcome=${repairState.lastOutcome ?? 'none'}
lastFailureMessage=${repairState.lastFailureMessage ?? 'none'}

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
  const verificationStatus = result.verification?.review?.status ?? 'unknown';
  const publishError = result.publication?.error?.message ?? null;
  const repairState = result.repairState ?? {};
  const items = [];

  items.push({
    category: 'verification',
    observation: `Verification ended with status "${verificationStatus}" for task "${task.title}".`,
    keywords: ['verification', verificationStatus, 'phase5'],
    confidenceScore: 6,
  });

  if (publishError) {
    items.push({
      category: 'publishing',
      observation: `Publishing surfaced an error: ${publishError.slice(0, 220)}.`,
      keywords: ['publishing', 'github', 'error'],
      confidenceScore: 7,
    });
  }

  if (repairState.status === 'resolved' && repairState.attemptCount > 0) {
    items.push({
      category: 'self-healing',
      observation: `A bounded repair workflow recovered task "${task.title}" after ${repairState.attemptCount} attempt(s).`,
      keywords: ['self-healing', 'repair', 'retry', 'recovery'],
      confidenceScore: 8,
    });
  } else if (repairState.status === 'exhausted') {
    items.push({
      category: 'self-healing',
      observation: `Repair retries for task "${task.title}" were exhausted after ${repairState.exhaustedAfterAttempt ?? repairState.attemptCount ?? 0} attempt(s), so the run escalated instead of retrying indefinitely.`,
      keywords: ['self-healing', 'repair', 'budget', 'escalation'],
      confidenceScore: 9,
    });
  }

  return items.slice(0, 4);
}

export function createLearningExtractor({ client, modelSelector }) {
  return {
    async extract(task, result) {
      const model = modelSelector.select('fast');

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
          return parsed;
        }
      } catch {
        // Non-blocking: fallback below.
      }

      return buildFallback(task, result);
    },
  };
}
