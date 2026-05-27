import { formatMemoryArtifactForPrompt, summarizeMemoryContent } from './exactArtifacts.js';

export const RETRIEVAL_LAYER_ORDER = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const DEFAULT_RETRIEVAL_LAYER_BUDGETS = Object.freeze({
  L0: 1800,
  L1: 3200,
  L2: 2800,
  L3: 1400,
});

function compactText(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

function normalizeEntry(entry = {}) {
  const text = `${entry.text ?? ''}`.trim();
  if (!text) {
    return null;
  }

  return {
    label: entry.label ?? 'Context',
    source: entry.source ?? 'unknown',
    text,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
  };
}

function fitEntriesToBudget(entries, budget) {
  const accepted = [];
  let usedChars = 0;
  let truncated = false;

  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      continue;
    }

    const block = `${normalized.label}:\n${normalized.text}`;
    const nextSize = block.length + (accepted.length > 0 ? 2 : 0);

    if (budget > 0 && usedChars + nextSize > budget) {
      if (accepted.length === 0) {
        const remainder = Math.max(budget - normalized.label.length - 2, 0);
        accepted.push({
          ...normalized,
          text: summarizeMemoryContent(normalized.text, Math.max(remainder, 0)),
        });
        usedChars = `${normalized.label}:\n${accepted[0].text}`.length;
      }
      truncated = true;
      break;
    }

    accepted.push(normalized);
    usedChars += nextSize;
  }

  return {
    entries: accepted,
    usedChars,
    truncated,
  };
}

export function createLayerEntry(input = {}) {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    return null;
  }

  return {
    label: input.label ?? 'Context',
    source: input.source ?? 'unknown',
    text,
    metadata: input.metadata ?? {},
  };
}

export function createMemoryArtifactLayerEntry(artifact, label = null) {
  const text = formatMemoryArtifactForPrompt(artifact);
  return createLayerEntry({
    label: label ?? `Exact memory: ${artifact.artifact_type ?? artifact.artifactType}`,
    source: 'memory_artifact',
    text,
    metadata: {
      artifactType: artifact.artifact_type ?? artifact.artifactType ?? null,
      taskId: artifact.task_id ?? artifact.taskId ?? null,
      chatSessionId: artifact.chat_session_id ?? artifact.chatSessionId ?? null,
      retrievalPriority: artifact.retrieval_priority ?? artifact.retrievalPriority ?? null,
      createdAt: artifact.created_at ?? artifact.createdAt ?? null,
      supersedesArtifactId:
        artifact.supersedes_artifact_id ?? artifact.supersedesArtifactId ?? null,
    },
  });
}

export function assembleLayeredRetrievalContext(input = {}, options = {}) {
  const budgets = {
    ...DEFAULT_RETRIEVAL_LAYER_BUDGETS,
    ...(options.budgets ?? {}),
  };
  const includeHeaders = options.includeHeaders !== false;
  const diagnostics = {
    budgets,
    order: [...RETRIEVAL_LAYER_ORDER],
    layers: {},
  };
  const renderedSections = [];

  for (const layerName of RETRIEVAL_LAYER_ORDER) {
    const layerEntries = Array.isArray(input[layerName]) ? input[layerName] : [];
    const fit = fitEntriesToBudget(layerEntries, budgets[layerName] ?? 0);
    diagnostics.layers[layerName] = {
      requestedCount: layerEntries.length,
      selectedCount: fit.entries.length,
      usedChars: fit.usedChars,
      truncated: fit.truncated,
      entries: fit.entries.map((entry) => ({
        label: entry.label,
        source: entry.source,
        preview: summarizeMemoryContent(entry.text, 180),
        metadata: entry.metadata,
      })),
    };

    if (fit.entries.length === 0) {
      continue;
    }

    const blocks = fit.entries.map((entry) => `${entry.label}:\n${entry.text}`);
    renderedSections.push(
      includeHeaders ? `${layerName}:\n${blocks.join('\n\n')}` : blocks.join('\n\n')
    );
  }

  return {
    text: renderedSections.join('\n\n').trim(),
    diagnostics,
  };
}
