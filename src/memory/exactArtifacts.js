import path from 'node:path';

export const MEMORY_ARTIFACT_DEFAULT_PRIORITIES = Object.freeze({
  user_instruction: 100,
  system_decision: 95,
  approval_response: 95,
  approval_prompt: 90,
  repair_proposal: 90,
  verification_summary: 88,
  plan_draft: 85,
});

const MEMORY_ARTIFACT_SUBSYSTEM_BY_TYPE = Object.freeze({
  user_instruction: 'chat',
  system_decision: 'orchestrator',
  approval_prompt: 'approval',
  approval_response: 'approval',
  repair_proposal: 'self_healing',
  verification_summary: 'verification',
  plan_draft: 'planning',
});

function compactWhitespace(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

export function summarizeMemoryContent(content, limit = 220) {
  const normalized = compactWhitespace(content);
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(limit - 3, 0))}...`;
}

export function deriveProjectScope(task = {}, options = {}) {
  if (typeof options.projectScope === 'string' && options.projectScope.trim()) {
    return options.projectScope.trim();
  }

  if (typeof task.project_name === 'string' && task.project_name.trim()) {
    return task.project_name.trim();
  }

  if (typeof task.project_path === 'string' && task.project_path.trim()) {
    return path.basename(task.project_path.trim());
  }

  if (typeof options.projectPath === 'string' && options.projectPath.trim()) {
    return path.basename(options.projectPath.trim());
  }

  return null;
}

export function deriveSubsystem(task = {}, input = {}) {
  if (typeof input.subsystem === 'string' && input.subsystem.trim()) {
    return input.subsystem.trim();
  }

  if (typeof input.artifactType === 'string') {
    const mapped = MEMORY_ARTIFACT_SUBSYSTEM_BY_TYPE[input.artifactType.trim()];
    if (mapped) {
      return mapped;
    }
  }

  if (typeof task.project_path === 'string' && task.project_path.trim()) {
    return path.basename(task.project_path.trim());
  }

  return 'general';
}

export function buildMemoryArtifactRecord(input = {}, context = {}) {
  const content = `${input.content ?? ''}`.trim();
  if (!content) {
    return null;
  }

  const artifactType = `${input.artifactType ?? ''}`.trim();
  if (!artifactType) {
    throw new Error('artifactType is required for memory artifacts.');
  }

  const task = context.task ?? {};
  const retrievalPriority = Number.isInteger(input.retrievalPriority)
    ? input.retrievalPriority
    : MEMORY_ARTIFACT_DEFAULT_PRIORITIES[artifactType] ?? 50;

  return {
    taskId: input.taskId ?? task.id ?? null,
    chatSessionId: input.chatSessionId ?? task.chat_session_id ?? null,
    artifactType,
    projectScope: deriveProjectScope(task, input),
    subsystem: deriveSubsystem(task, input),
    sourceMessageId:
      input.sourceMessageId == null ? null : `${input.sourceMessageId}`.trim() || null,
    sourceStepNumber: Number.isInteger(input.sourceStepNumber) ? input.sourceStepNumber : null,
    retrievalPriority,
    content,
    contentSummary:
      typeof input.contentSummary === 'string' && input.contentSummary.trim()
        ? input.contentSummary.trim()
        : summarizeMemoryContent(content),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    supersedesArtifactId: input.supersedesArtifactId ?? null,
    archivedAt: input.archivedAt ?? null,
    expiresAt: input.expiresAt ?? null,
  };
}

export function formatMemoryArtifactForPrompt(artifact) {
  const prefix = [
    artifact.artifact_type ?? artifact.artifactType ?? null,
    artifact.project_scope ?? artifact.projectScope ?? null,
    artifact.subsystem ?? artifact.subsystem ?? null,
  ]
    .filter(Boolean)
    .join(' | ');

  if (!prefix) {
    return `${artifact.content ?? ''}`.trim();
  }

  return `[${prefix}] ${`${artifact.content ?? ''}`.trim()}`;
}

export function buildPlanDraftMemoryContent(task, plan, plannerMeta = {}) {
  const payload = {
    taskId: task?.id ?? null,
    title: task?.title ?? null,
    modelUsed: plannerMeta.modelUsed ?? null,
    repaired: plannerMeta.repaired === true,
    fallback: plannerMeta.fallback === true,
    plan,
  };

  return JSON.stringify(payload, null, 2);
}

export function buildVerificationMemoryContent(result = {}) {
  const payload = {
    review: result?.verification?.review ?? null,
    modelUsed: result?.verification?.modelUsed ?? null,
    usedFallback: result?.verification?.usedFallback === true,
    workspaceFiles: result?.verification?.workspaceFiles?.slice?.(0, 20) ?? [],
  };

  return JSON.stringify(payload, null, 2);
}

export function buildApprovalPromptMemoryContent(input = {}) {
  const payload = {
    approvalType: input.approvalType ?? null,
    taskTitle: input.taskTitle ?? null,
    channel: input.channel ?? null,
    message: input.message ?? null,
    details: input.details ?? null,
  };

  return JSON.stringify(payload, null, 2);
}

export function buildApprovalResponseMemoryContent(input = {}) {
  const payload = {
    approvalType: input.approvalType ?? null,
    decision: input.decision ?? null,
    respondedVia: input.respondedVia ?? null,
    note: input.note ?? null,
    reason: input.reason ?? null,
    respondedAt: input.respondedAt ?? null,
  };

  return JSON.stringify(payload, null, 2);
}
