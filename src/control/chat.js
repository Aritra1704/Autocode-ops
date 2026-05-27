import { z } from 'zod';

import {
  actorSchema,
  actorModelRole,
  actorSystemPrompt,
  listActors,
} from './actors.js';
import { deriveExecutionControl, normalizeTaskContract } from './taskContract.js';
import { collectWorkspaceSnapshot } from '../tools/registry.js';

const sessionTitleSchema = z.string().trim().min(1).max(160);
const messageSchema = z.string().trim().min(1).max(12000);

const createSessionSchema = z
  .object({
    title: sessionTitleSchema.default('Stallone chat'),
    actor: actorSchema.default('architect'),
    projectPath: z.string().trim().min(1).optional(),
  })
  .partial()
  .strict();

const appendMessageSchema = z
  .object({
    content: messageSchema,
    actor: actorSchema.optional(),
  })
  .strict();

const draftTaskSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000).optional(),
    actor: actorSchema.optional(),
  })
  .partial()
  .strict();

const CHAT_MODEL_TIMEOUT_MS = 60000;
const CHAT_SUMMARY_STATE_VERSION = 'chat_summary_v1';
const EXECUTION_APPROVAL_PHRASES = new Set([
  'yes',
  'yes start it',
  'yes start this',
  'yes run it',
  'yes run this',
  'yep',
  'yeah',
  'go ahead',
  'go ahead start it',
  'go ahead start this',
  'start',
  'start it',
  'start this',
  'start now',
  'run it',
  'run this',
  'run now',
  'execute it',
  'execute this',
  'approve it',
  'approve this',
  'proceed',
  'continue',
  'do it',
  'ship it',
  'do that',
  'go for it',
  'ok',
  'okay',
  'do as you said',
  'proceed with the steps',
  'start on the action items',
]);
const SHORT_AFFIRMATIVE_PHRASES = new Set([
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'sure',
  'go ahead',
  'do it',
  'proceed',
  'continue',
]);
const SHORT_NEGATIVE_PHRASES = new Set([
  'no',
  'nope',
  'nah',
  'not now',
  'stop',
  'cancel',
  'don t',
  'do not',
  'no thanks',
]);
const EXECUTION_REQUEST_PATTERNS = [
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:create|build|implement|set up|setup|scaffold|generate|write|draft|fix|update|add|remove|refactor|rename|move|delete|start|analyze|review|examine|read|inspect|check|go through|walk through|scan|find|plan|list|show|tell|summarize|search|get|run|do|execute|perform|extract|compile|gather|investigate|verify|audit|audit-commit|safe-commit|reconstruct|repair|heal|improve|reflect|chat|decompose|split)\b/i,
  /^(?:please\s+)?(?:i need you to|need you to|help me)\s+(?:create|build|implement|set up|setup|scaffold|generate|write|draft|fix|update|add|remove|refactor|rename|move|delete|start|analyze|review|examine|read|inspect|check|go through|walk through|scan|find|plan|list|show|tell|summarize|search|get|run|do|execute|perform|extract|compile|gather|investigate|verify|audit|audit-commit|safe-commit|reconstruct|repair|heal|improve|reflect|chat|decompose|split)\b/i,
];
const TARGET_HINT_PATTERN =
  /(?:\.[a-z0-9]{1,8}\b|\/[a-z0-9_.-]+|\b(?:readme|package\.json|dockerfile|ui|api|page|component|route|endpoint|schema|table|migration|query|test|frontend|backend|database|react|node|typescript|python|markdown)\b)/i;
const VAGUE_OBJECTIVE_PATTERN =
  /\b(?:fix it|update it|make it better|do it|handle it|something|stuff|thing|this|that)\b/i;
const LIST_SPLIT_PATTERN = /\s*(?:\||\n)\s*/;
const PENDING_ACTION_TYPES = new Set(['approval_request', 'clarification_question', 'none']);
const PENDING_ACTION_QUESTION_KINDS = new Set(['yes_no', 'open_text', 'none']);

function normalizeIntentMessage(message) {
  return `${message ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createPendingAction(input = {}) {
  const type = PENDING_ACTION_TYPES.has(input?.type) ? input.type : 'none';
  const questionKind = PENDING_ACTION_QUESTION_KINDS.has(input?.questionKind)
    ? input.questionKind
    : 'none';

  return {
    type,
    taskId: input?.taskId ?? null,
    draftObjective: input?.draftObjective ?? null,
    questionKind,
    assistantMessageId: input?.assistantMessageId ?? null,
    expiresAt: input?.expiresAt ?? null,
  };
}

function hasPendingAction(action) {
  return action?.type && action.type !== 'none';
}

function isShortAffirmative(message) {
  return SHORT_AFFIRMATIVE_PHRASES.has(normalizeIntentMessage(message));
}

function isShortNegative(message) {
  return SHORT_NEGATIVE_PHRASES.has(normalizeIntentMessage(message));
}

function compact(value, limit = 4000) {
  const text = `${value ?? ''}`.trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildMessageExcerpt(content, limit = 220) {
  return compact(`${content ?? ''}`.replace(/\s+/g, ' '), limit);
}

function normalizeListItem(item) {
  return `${item ?? ''}`
    .replace(/^[\-\*\d\.\)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeList(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const normalized = normalizeListItem(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function matchPreferencePattern(content, patternGroups) {
  for (const group of patternGroups) {
    if (group.pattern.test(content)) {
      return {
        value: group.value,
        source: group.source ?? 'explicit',
        confidence: group.confidence ?? 0.95,
      };
    }
  }

  return null;
}

function extractChatPreferences(messages) {
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .slice(-20)
    .reverse();
  const preferences = {};

  const explicitPreferenceMatchers = {
    verbosity: [
      {
        pattern: /\b(concise|brief|short|quick summary|quick answer|tldr|just the answer)\b/i,
        value: 'concise',
        confidence: 0.98,
      },
      {
        pattern: /\b(detailed|detail|thorough|comprehensive|deep dive|in depth|more detail)\b/i,
        value: 'detailed',
        confidence: 0.98,
      },
    ],
    explanationDepth: [
      {
        pattern: /\b(no explanation|don't explain|do not explain|just the code|code only)\b/i,
        value: 'low',
        confidence: 0.98,
      },
      {
        pattern: /\b(explain why|teach me|walk me through|show me why|show your reasoning|explain the reasoning)\b/i,
        value: 'high',
        confidence: 0.98,
      },
    ],
    planningStyle: [
      {
        pattern: /\b(step by step|steps|numbered steps|checklist|plan steps|give me the steps)\b/i,
        value: 'stepwise',
        confidence: 0.96,
      },
      {
        pattern: /\b(brainstorm|talk it through|discuss first|think with me|explore options)\b/i,
        value: 'conversational',
        confidence: 0.96,
      },
    ],
  };

  for (const message of userMessages) {
    const content = `${message.content ?? ''}`;

    for (const [dimension, patterns] of Object.entries(explicitPreferenceMatchers)) {
      if (preferences[dimension]) {
        continue;
      }

      const match = matchPreferencePattern(content, patterns);
      if (match) {
        preferences[dimension] = {
          ...match,
          evidence: buildMessageExcerpt(content, 160),
        };
      }
    }
  }

  if (!preferences.interactionMode) {
    const latestExecutionRequest = userMessages.find((message) =>
      isExecutionTaskRequest(message.content)
    );
    if (latestExecutionRequest) {
      preferences.interactionMode = {
        value: 'execution_oriented',
        source: 'inferred',
        confidence: 0.72,
        evidence: buildMessageExcerpt(latestExecutionRequest.content, 160),
      };
    }
  }

  if (!preferences.interactionMode) {
    const latestDiscussionRequest = userMessages.find((message) =>
      /\b(brainstorm|discuss|talk through|explore options|what do you think)\b/i.test(
        `${message.content ?? ''}`
      )
    );
    if (latestDiscussionRequest) {
      preferences.interactionMode = {
        value: 'discussion_oriented',
        source: 'inferred',
        confidence: 0.68,
        evidence: buildMessageExcerpt(latestDiscussionRequest.content, 160),
      };
    }
  }

  return preferences;
}

function findFirstExecutionRequestIndex(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    if (isExecutionTaskRequest(messages[index]?.content)) {
      return index;
    }
  }

  return -1;
}

function countWords(text) {
  return `${text ?? ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildDraftObjective(
  messages,
  previousDraft = null,
  explicitObjective = null,
  previousPendingAction = createPendingAction()
) {
  if (explicitObjective?.trim()) {
    return explicitObjective.trim();
  }

  const userMessages = messages.filter((message) => message.role === 'user');
  if (userMessages.length === 0) {
    return previousDraft?.contract?.objective ?? previousDraft?.objective ?? null;
  }

  const firstExecutionIndex = findFirstExecutionRequestIndex(userMessages);
  if (firstExecutionIndex >= 0) {
    const baseObjective = `${userMessages[firstExecutionIndex]?.content ?? ''}`.trim();
    const followUps = userMessages
      .slice(firstExecutionIndex + 1)
      .map((message) => `${message.content ?? ''}`.trim())
      .filter((content) => {
        if (!content) {
          return false;
        }

        if (
          previousPendingAction.type === 'clarification_question' &&
          previousPendingAction.questionKind === 'yes_no' &&
          (isShortAffirmative(content) || isShortNegative(content))
        ) {
          return true;
        }

        return !isExecutionApprovalIntent(content);
      });

    if (followUps.length > 0) {
      return compact(`${baseObjective}\n\nAdditional context: ${followUps.join(' | ')}`, 1800);
    }

    return baseObjective;
  }

  if (
    previousPendingAction.type === 'clarification_question' &&
    previousPendingAction.questionKind === 'yes_no' &&
    (previousDraft?.contract?.objective || previousDraft?.objective)
  ) {
    const latestUserMessage = `${userMessages.at(-1)?.content ?? ''}`.trim();
    if (isShortAffirmative(latestUserMessage) || isShortNegative(latestUserMessage)) {
      return compact(
        `${previousDraft.contract?.objective ?? previousDraft.objective}\n\nAdditional context: confirmation=${isShortAffirmative(latestUserMessage) ? 'yes' : 'no'}`,
        1800
      );
    }
  }

  if (previousDraft?.pendingClarification && (previousDraft?.contract?.objective || previousDraft?.objective)) {
    const latestUserMessage = `${userMessages.at(-1)?.content ?? ''}`.trim();
    if (latestUserMessage) {
      return compact(
        `${previousDraft.contract?.objective ?? previousDraft.objective}\n\nAdditional context: ${latestUserMessage}`,
        1800
      );
    }
  }

  return null;
}

function getRelevantDraftMessages(messages) {
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => `${message.content ?? ''}`.trim())
    .filter(Boolean);
  const firstExecutionIndex = findFirstExecutionRequestIndex(
    userMessages.map((content) => ({ content }))
  );
  if (firstExecutionIndex >= 0) {
    return userMessages.slice(firstExecutionIndex);
  }
  return userMessages;
}

function splitDirectiveSegments(content) {
  return `${content ?? ''}`
    .split(/\s*(?:;|\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseListDirective(content, cuePattern) {
  const match = `${content ?? ''}`.trim().match(cuePattern);
  if (!match?.[1]) {
    return [];
  }

  return dedupeList(match[1].split(LIST_SPLIT_PATTERN));
}

function inferPriority(messages, previousPriority = 'medium') {
  for (const content of [...messages].reverse()) {
    if (/\b(?:critical|sev1|p0)\b/i.test(content)) {
      return 'critical';
    }
    if (/\b(?:urgent|high priority|p1)\b/i.test(content)) {
      return 'high';
    }
    if (/\b(?:low priority|whenever|not urgent|p3)\b/i.test(content)) {
      return 'low';
    }
    if (/\b(?:medium priority|normal priority|p2)\b/i.test(content)) {
      return 'medium';
    }
  }

  return previousPriority;
}

function inferRepoIntent(messages, previousIntent = { publish: false, deploy: false }) {
  const intent = { ...previousIntent };

  for (const content of messages) {
    if (/\b(?:deploy it|ship it|push to prod|release it)\b/i.test(content)) {
      intent.deploy = true;
    }
    if (/\b(?:do not deploy|don't deploy|without deploy|no deploy)\b/i.test(content)) {
      intent.deploy = false;
    }
    if (
      /\b(?:publish it|publish to github|open a pr|create a pr|open pull request|create pull request|push to github)\b/i.test(
        content
      )
    ) {
      intent.publish = true;
    }
    if (/\b(?:do not publish|don't publish|without publish|no pr|no publish)\b/i.test(content)) {
      intent.publish = false;
    }
  }

  return intent;
}

function buildContractRefinements(messages, previousDraft = null) {
  const relevantMessages = getRelevantDraftMessages(messages);
  const directiveSegments = relevantMessages.flatMap((content) => splitDirectiveSegments(content));
  const previousContract = previousDraft?.contract ?? null;

  const inScope = [
    ...(previousContract?.inScope ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:include|also include|in scope|scope includes|add scope)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const outOfScope = [
    ...(previousContract?.outOfScope ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:out of scope|do not touch|don't touch|exclude|skip)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const constraints = [
    ...(previousContract?.constraints ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:constraints?|must|need to|use|keep|without)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const successCriteria = [
    ...(previousContract?.successCriteria ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(
        content,
        /\b(?:success means|done when|acceptance criteria|success criteria|make sure|ensure)\s*:?\s*(.+)$/i
      )
    ),
  ];
  const skillHints = [
    ...(previousContract?.skillHints ?? []),
    ...directiveSegments.flatMap((content) =>
      parseListDirective(content, /\b(?:skill hint|skill hints|use skill)\s*:?\s*(.+)$/i)
    ),
  ];

  return {
    inScope: dedupeList(inScope),
    outOfScope: dedupeList(outOfScope),
    constraints: dedupeList(constraints),
    successCriteria: dedupeList(successCriteria),
    skillHints: dedupeList(skillHints),
    priority: inferPriority(relevantMessages, previousContract?.priority ?? 'medium'),
    repoIntent: inferRepoIntent(relevantMessages, previousContract?.repoIntent ?? undefined),
  };
}

function assessDraftReadiness(session, objective) {
  const normalized = `${objective ?? ''}`.trim();
  const missingContext = [];

  if (normalized.length < 5) {
    missingContext.push('requested_change');
  } else {
    const hasTargetHint = TARGET_HINT_PATTERN.test(normalized);
    const isVagueShortRequest =
      VAGUE_OBJECTIVE_PATTERN.test(normalized) && countWords(normalized) <= 4;

    if (isVagueShortRequest || normalized.length < 12) {
      missingContext.push('requested_change');
    }

    if (!hasTargetHint) {
      missingContext.push('target_area');
    }
  }

  return {
    readyForPlanning: missingContext.length === 0,
    missingContext,
  };
}

function buildClarificationQuestion(session, draftState) {
  const prompts = [];
  for (const key of draftState?.missingContext ?? []) {
    if (key === 'requested_change') {
      prompts.push('What exactly should I change or create?');
    }

    if (key === 'target_area') {
      prompts.push(
        session.project_path
          ? 'Which file, component, or subsystem should this apply to?'
          : 'Which project, file, or component should this apply to?'
      );
    }
  }

  if (prompts.length === 0) {
    prompts.push('What should success look like when this task is done?');
  }

  return [
    'I can turn this into a task, but I need a bit more detail before planning safely.',
    '',
    ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`),
    draftState?.contract?.objective || draftState?.objective
      ? `\nCurrent draft objective: ${draftState.contract?.objective ?? draftState.objective}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPendingActionFromMessages(messages, previousSummaryState = null) {
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant') ?? null;
  if (!latestAssistant) {
    return createPendingAction(previousSummaryState?.pendingAction);
  }

  return createPendingAction({
    ...(latestAssistant.metadata?.pendingAction ?? {}),
    assistantMessageId:
      latestAssistant.metadata?.pendingAction?.assistantMessageId ?? latestAssistant.id ?? null,
  });
}

function buildContractDraftState({ session, messages, previousSummaryState = null, explicitObjective = null }) {
  const previousDraft = previousSummaryState?.contractDraft ?? null;
  const objective = buildDraftObjective(
    messages,
    previousDraft,
    explicitObjective,
    createPendingAction(previousSummaryState?.pendingAction)
  );
  if (!objective) {
    return null;
  }
  const readiness = assessDraftReadiness(session, objective);
  const refinements = buildContractRefinements(messages, previousDraft);
  const contract =
    objective.trim().length >= 10
      ? buildDraftContract({
          session,
          messages,
          objective,
          refinements,
        })
      : null;

  return {
    objective,
    contract,
    readyForPlanning: readiness.readyForPlanning,
    pendingClarification: !readiness.readyForPlanning,
    missingContext: readiness.missingContext,
    clarificationQuestion: readiness.readyForPlanning
      ? null
      : buildClarificationQuestion(session, {
          contract,
          missingContext: readiness.missingContext,
        }),
    objectiveSource: explicitObjective ? 'explicit' : 'conversation',
    lastRefinedAt: new Date().toISOString(),
  };
}

function buildChatSummaryState({ session, messages, previousSummaryState = null, explicitObjective = null }) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const latestUserMessages = userMessages.slice(-4);
  const latestRequest = latestUserMessages.at(-1)?.content ?? '';
  const previousContext = latestUserMessages
    .slice(0, -1)
    .map((message) => buildMessageExcerpt(message.content, 180));
  const summary = compact(
    latestRequest
      ? [
          `Latest request: ${buildMessageExcerpt(latestRequest, 320)}`,
          previousContext.length > 0 ? `Recent context: ${previousContext.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    1200
  );

  return {
    version: CHAT_SUMMARY_STATE_VERSION,
    summary,
    highlights: latestUserMessages.map((message) => buildMessageExcerpt(message.content, 180)),
    preferences: extractChatPreferences(messages),
    pendingAction: buildPendingActionFromMessages(messages, previousSummaryState),
    contractDraft: buildContractDraftState({
      session,
      messages,
      previousSummaryState,
      explicitObjective,
    }),
    messageCount: messages.length,
    updatedAt: new Date().toISOString(),
  };
}

function formatChatPreferencePrompt(summaryState) {
  const preferences = summaryState?.preferences;
  if (!preferences || Object.keys(preferences).length === 0) {
    return 'Operator preferences: none captured yet';
  }

  const entries = Object.entries(preferences).map(([name, value]) => {
    const confidence =
      typeof value?.confidence === 'number' ? `${Math.round(value.confidence * 100)}%` : 'n/a';
    return `${name}=${value?.value ?? 'unknown'} (${value?.source ?? 'unknown'}, ${confidence})`;
  });

  return `Operator preferences: ${entries.join('; ')}`;
}

function buildFallbackChatResponse({ actor, userMessage, projectPath }) {
  const projectLine = projectPath ? `\nProject: ${projectPath}` : '';
  return compact(
    `I can help as ${actor}. I can discuss, plan, and execute repo-local work directly.${projectLine}\n\nNext useful step: tell me the objective, constraints, and success criteria, or ask me to draft a task plan.\n\nYour message: ${userMessage}`,
    2000
  );
}

function buildGreetingResponse({ actor, projectPath }) {
  const projectLine = projectPath ? `\nProject: ${projectPath}` : '';
  return `Hi. I am Stallone in ${actor} mode.${projectLine}

I can discuss, review, plan, draft a task contract, and execute repo-local work directly.`;
}

function isExecutionApprovalIntent(message) {
  return EXECUTION_APPROVAL_PHRASES.has(normalizeIntentMessage(message));
}

function isExecutionTaskRequest(message) {
  const normalized = `${message ?? ''}`.trim();
  if (!normalized || normalized.startsWith('/')) {
    return false;
  }

  if (isExecutionApprovalIntent(normalized)) {
    return false;
  }

  return EXECUTION_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isHighSignalInstructionMessage(message, summaryState = null) {
  const content = `${message ?? ''}`.trim();
  if (!content || content.startsWith('/')) {
    return false;
  }

  if (
    isExecutionTaskRequest(content) ||
    isExecutionApprovalIntent(content) ||
    isShortAffirmative(content) ||
    isShortNegative(content)
  ) {
    return true;
  }

  if (summaryState?.contractDraft?.pendingClarification) {
    return true;
  }

  return /\b(must|should|only|exactly|do not|don't|without|with|keep|avoid|required|constraint|success criteria)\b/i.test(
    content
  );
}

function formatPlanForChat(plan) {
  const lines = [];
  const summary = `${plan?.summary ?? ''}`.trim();
  if (summary) {
    lines.push(`Plan: ${summary}`);
  }

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length > 0) {
    lines.push('Steps:');
    for (const step of steps) {
      lines.push(
        `${step?.stepNumber ?? '?'}. ${`${step?.objective ?? 'No objective'}`.trim()} [${`${step?.tool ?? 'unspecified'}`.trim()}]`
      );
    }
  }

  return lines.join('\n');
}

function buildApprovalPendingAction(taskId, draftObjective = null) {
  return createPendingAction({
    type: 'approval_request',
    taskId,
    draftObjective,
    questionKind: 'none',
  });
}

function buildClarificationPendingAction(draftObjective = null, questionKind = 'open_text') {
  return createPendingAction({
    type: 'clarification_question',
    draftObjective,
    questionKind,
  });
}

function buildPlannedTaskChatResponse({
  task,
  plan,
  execution = null,
  executionApproval = null,
  autoPlannedFromChat = false,
}) {
  const autoStarted = executionApproval?.status === 'approved';
  const waitingApproval =
    executionApproval?.status === 'pending' || task?.status === 'waiting_approval';
  const header = autoStarted
    ? autoPlannedFromChat
      ? 'I turned that request into a local task and started execution.'
      : 'Plan created and execution started.'
    : waitingApproval
      ? autoPlannedFromChat
        ? 'I turned that request into a task and it is waiting for approval.'
        : 'Plan created and is waiting for approval before execution.'
    : autoPlannedFromChat
      ? 'I turned that request into a task.'
      : 'Plan created and queued for execution.';
  const lines = [header, '', `Task: ${task.id}`];
  const formattedPlan = formatPlanForChat(plan);
  if (formattedPlan) {
    lines.push(formattedPlan);
  }
  if (execution?.executionClass) {
    lines.push(`Execution class: ${execution.executionClass}`);
  }
  if (autoStarted) {
    lines.push('Execution is in progress. Use /status to inspect progress.');
  } else if (waitingApproval) {
    lines.push('Execution is waiting for approval. Reply `yes` to approve it, or `no` to keep it blocked.');
  } else {
    lines.push('Execution has been queued. Use /status to inspect progress.');
  }
  return lines.join('\n');
}

function buildApprovalDisambiguationResponse() {
  return 'I am not currently holding an approval or yes/no prompt for this chat. Tell me what you want me to continue, or restate the task in one sentence.';
}

async function reconcileAutoStartedPlan(orchestrator, planned) {
  if (!planned?.task?.id) {
    return planned;
  }

  if (planned.executionApproval?.status === 'approved') {
    return planned;
  }

  if (planned.execution?.executionClass !== 'local_only' || planned.execution?.approvalRequired === true) {
    return planned;
  }

  if (!orchestrator?.getTaskDetails) {
    return planned;
  }

  const detail = await orchestrator.getTaskDetails(planned.task.id, { logLimit: 5 });
  const liveTask = detail?.task ?? null;
  const liveApprovalStatus = liveTask?.result?.preExecutionPlan?.status ?? null;
  const autoStarted =
    liveApprovalStatus === 'approved' || (liveTask?.status && liveTask.status !== 'waiting_approval');

  if (!liveTask || !autoStarted) {
    return planned;
  }

  return {
    ...planned,
    task: {
      ...planned.task,
      ...liveTask,
      status: liveTask.status ?? planned.task.status,
    },
    executionApproval: {
      ...(planned.executionApproval ?? {}),
      task_id: planned.task.id,
      status: 'approved',
      approvalRequired: false,
      autoStarted: true,
    },
  };
}

function buildDraftContract({ session, messages, objective, refinements = {} }) {
  const latestUserMessage =
    objective ||
    [...messages]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content ||
    session.title;

  return normalizeTaskContract({
    version: 'task_contract_v1',
    projectName:
      session.project_name ||
      session.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) ||
      'stallone-task',
    objective: latestUserMessage,
    inScope: dedupeList([
      'Analyze the requested work',
      'Prepare a safe implementation plan',
      'Make only changes required by the approved task',
      ...(refinements.inScope ?? []),
    ]).slice(0, 20),
    outOfScope: dedupeList([
      'Unrelated refactors',
      'Unapproved deployment',
      'Bypassing approval gates',
      ...(refinements.outOfScope ?? []),
    ]).slice(0, 20),
    constraints: dedupeList([
      'Use the selected project path only',
      'Keep changes reviewable',
      'Keep publish, deploy, and other public actions explicit and reviewable',
      ...(refinements.constraints ?? []),
    ]).slice(0, 20),
    successCriteria: dedupeList([
      'Plan is explicit and executable',
      'Tests or verification steps are identified',
      'Local-only work can execute safely without external side effects',
      ...(refinements.successCriteria ?? []),
    ]).slice(0, 20),
    priority: refinements.priority ?? 'medium',
    skillHints: dedupeList(refinements.skillHints ?? []).slice(0, 12),
    repoIntent: refinements.repoIntent ?? {
      publish: false,
      deploy: false,
    },
    notes: `Drafted from chat session ${session.id}`,
  });
}

async function buildProjectSnapshot(projectPath) {
  if (!projectPath) {
    return 'No project selected.';
  }

  try {
    const snapshot = await collectWorkspaceSnapshot(projectPath, {
      recursive: true,
      limit: 45,
    });
    if (snapshot.length === 0) {
      return 'Project snapshot is empty.';
    }

    return snapshot
      .map((entry) => `${entry.type === 'directory' ? 'dir ' : 'file'} ${entry.path}`)
      .join('\n');
  } catch (error) {
    return `Project snapshot unavailable: ${error.message}`;
  }
}

async function buildChatPrompt({ session, messages, userMessage }) {
  const projectSnapshot = await buildProjectSnapshot(session.project_path);
  const lines = [
    `Session title: ${session.title}`,
    `Actor: ${session.actor}`,
    session.project_path ? `Project path: ${session.project_path}` : 'Project path: none selected',
    session.summary ? `Session summary: ${session.summary}` : 'Session summary: none yet',
    formatChatPreferencePrompt(session.summary_state),
    '',
    'Project snapshot:',
    projectSnapshot,
    '',
    'Recent conversation:',
  ];

  for (const message of messages.slice(-12)) {
    lines.push(`${message.role}: ${message.content}`);
  }

  lines.push('', `Current user message: ${userMessage}`);
  return lines.join('\n');
}

export function createChatService({
  pool,
  projectService,
  orchestrator,
  llmClient = null,
  modelSelector = null,
  logger = null,
  mcpRegistry = null,
}) {
  if (!pool) {
    throw new Error('Chat service requires a database pool');
  }

  const postgresServer = mcpRegistry?.getServer?.('postgres') ?? null;

  async function callPostgresTool(toolName, args, fallback) {
    if (postgresServer) {
      return postgresServer.callTool(toolName, args);
    }
    return fallback();
  }

  async function listMessages(sessionId, limit = 40) {
    const result = await callPostgresTool(
      'list_chat_messages',
      { sessionId, limit },
      () =>
        pool.query(
          `SELECT id, session_id, role, actor, content, metadata, created_at
           FROM chat_messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [sessionId, limit]
        )
    );

    return result.rows.reverse();
  }

  async function listTasksForSession(sessionId, limit = 20) {
    const result = await callPostgresTool(
      'list_tasks_by_chat_session',
      {
        sessionId,
        limit,
      },
      () =>
        pool.query(
          `SELECT id, title, status, priority, created_at, updated_at
           FROM tasks
           WHERE chat_session_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [sessionId, limit]
        )
    );

    return result.rows;
  }

  async function getSessionRow(sessionId) {
    const result = await callPostgresTool(
      'get_chat_session',
      { sessionId },
      () =>
        pool.query(
          `SELECT
             chat_sessions.id,
             chat_sessions.title,
             chat_sessions.actor,
             chat_sessions.project_target_id,
             chat_sessions.project_path,
             chat_sessions.summary,
             chat_sessions.summary_state,
             chat_sessions.status,
             chat_sessions.created_at,
             chat_sessions.updated_at,
             project_targets.name AS project_name
           FROM chat_sessions
           LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
           WHERE chat_sessions.id = $1`,
          [sessionId]
        )
    );

    return result.rows[0] ?? null;
  }

  async function insertMessage({ sessionId, role, actor = null, content, metadata = {} }) {
    const result = await callPostgresTool(
      'insert_chat_message',
      { sessionId, role, actor, content, metadata },
      () =>
        pool.query(
          `INSERT INTO chat_messages (session_id, role, actor, content, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, session_id, role, actor, content, metadata, created_at`,
          [sessionId, role, actor, content, JSON.stringify(metadata)]
        )
    );

    await callPostgresTool(
      'touch_chat_session',
      { sessionId },
      () => pool.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId])
    );

    return result.rows[0];
  }

  async function updateSummary(session, messages) {
    const summaryState = buildChatSummaryState({
      session,
      messages,
      previousSummaryState: session.summary_state,
    });
    const summary = summaryState.summary;

    await callPostgresTool(
      'update_chat_summary',
      {
        sessionId: session.id,
        summary,
        summaryState,
      },
      () =>
        pool.query(
          `UPDATE chat_sessions
           SET summary = $2, summary_state = $3::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [session.id, summary, JSON.stringify(summaryState)]
        )
    );

    await callPostgresTool(
      'insert_chat_summary',
      {
        sessionId: session.id,
        summary,
        summaryState,
        messageCount: messages.length,
      },
      () =>
        pool.query(
          `INSERT INTO chat_summaries (session_id, summary, summary_state, message_count)
           VALUES ($1, $2, $3::jsonb, $4)`,
          [session.id, summary, JSON.stringify(summaryState), messages.length]
        )
    );

    if (orchestrator?.recordPersonaPreferenceSignals) {
      await orchestrator.recordPersonaPreferenceSignals(summaryState);
    }

    return summary;
  }

  async function createPlannedTaskMessage({
    session,
    sessionId,
    actor,
    objective,
    contract: providedContract = null,
    autoPlannedFromChat = false,
  }) {
    const messages = await listMessages(sessionId);
    const contract =
      providedContract ??
      buildDraftContract({
        session,
        messages,
        objective,
      });
    const execution = deriveExecutionControl(contract);
    const planned = await reconcileAutoStartedPlan(
      orchestrator,
      await orchestrator.createPlannedTask(contract, {
      source: autoPlannedFromChat ? 'chat_auto_plan' : 'chat',
      chatSessionId: sessionId,
      projectPath: session.project_path,
      projectTargetId: session.project_target_id ?? null,
      autoApproveExecution: execution.autoStartAllowed,
      approvalSource: 'chat',
      approvalNote: `Auto-started local-only task from chat session ${sessionId}`,
      })
    );
    const assistant = await insertMessage({
      sessionId,
      role: 'assistant',
      actor,
      content: buildPlannedTaskChatResponse({
        task: planned.task,
        plan: planned.plan,
        execution: planned.execution,
        executionApproval: planned.executionApproval,
        autoPlannedFromChat,
      }),
      metadata: {
        taskId: planned.task.id,
        taskStatus: planned.task.status,
        plan: planned.plan,
        draftContract: contract,
        execution: planned.execution,
        executionPending: planned.executionApproval?.status !== 'approved',
        executionApproval: planned.executionApproval,
        autoPlannedFromChat,
        pendingAction:
          planned.executionApproval?.status === 'pending'
            ? buildApprovalPendingAction(planned.task.id, contract.objective)
            : createPendingAction(),
      },
    });

    await updateSummary(session, [...messages, assistant]);

    return {
      planned,
      assistant,
    };
  }

  async function generateAssistantResponse({ session, actor, messages, userMessage }) {
    if (/^(hi|hello|hey|yo|hola)$/i.test(userMessage.trim())) {
      return buildGreetingResponse({
        actor,
        projectPath: session.project_path,
      });
    }

    if (!llmClient?.generate || !modelSelector?.selectWithFallback) {
      return buildFallbackChatResponse({
        actor,
        userMessage,
        projectPath: session.project_path,
      });
    }

    const modelRole = actorModelRole(actor);
    const models = modelSelector.selectWithFallback(modelRole);
    let lastError = null;

    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, CHAT_MODEL_TIMEOUT_MS);

      try {
        const response = await llmClient.generate({
          model,
          system: actorSystemPrompt(actor),
          prompt: await buildChatPrompt({ session, messages, userMessage }),
          temperature: 0.2,
          signal: controller.signal,
        });

        return compact(response.responseText, 8000);
      } catch (error) {
        lastError = error;
        logger?.warn?.({ err: error, model, actor }, 'Chat model failed; trying fallback');
      } finally {
        clearTimeout(timer);
      }
    }

    logger?.warn?.({ err: lastError, actor }, 'All chat models failed; using fallback response');
    return buildFallbackChatResponse({
      actor,
      userMessage,
      projectPath: session.project_path,
    });
  }

  return {
    actors: listActors(),

    async createSession(input = {}) {
      const parsed = createSessionSchema.parse(input);
      const actor = actorSchema.parse(parsed.actor ?? 'architect');
      const project = parsed.projectPath
        ? await projectService.ensureProjectTarget(parsed.projectPath)
        : null;
      const title = sessionTitleSchema.parse(parsed.title ?? 'Stallone chat');

      const result = await callPostgresTool(
        'insert_chat_session',
        {
          title,
          actor,
          projectTargetId: project?.id ?? null,
          projectPath: project?.root_path ?? null,
        },
        () =>
          pool.query(
            `INSERT INTO chat_sessions (title, actor, project_target_id, project_path)
             VALUES ($1, $2, $3, $4)
             RETURNING id, title, actor, project_target_id, project_path, summary, summary_state, status, created_at, updated_at`,
            [title, actor, project?.id ?? null, project?.root_path ?? null]
          )
      );

      return result.rows[0];
    },

    async listSessions(limit = 30) {
      const result = await callPostgresTool(
        'list_chat_sessions',
        {
          limit: Math.min(Math.max(Number(limit) || 30, 1), 100),
        },
        () =>
          pool.query(
            `SELECT
               chat_sessions.id,
               chat_sessions.title,
               chat_sessions.actor,
               chat_sessions.project_path,
               chat_sessions.summary,
               chat_sessions.summary_state,
               chat_sessions.status,
               chat_sessions.created_at,
               chat_sessions.updated_at,
               project_targets.name AS project_name
             FROM chat_sessions
             LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
             ORDER BY chat_sessions.updated_at DESC
             LIMIT $1`,
            [Math.min(Math.max(Number(limit) || 30, 1), 100)]
          )
      );

      return result.rows;
    },

    async getSession(sessionId) {
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const [messages, tasks] = await Promise.all([
        listMessages(sessionId),
        listTasksForSession(sessionId, 20),
      ]);

      return {
        session,
        messages,
        tasks,
      };
    },

    async appendMessage(sessionId, input) {
      const parsed = appendMessageSchema.parse(input);
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const actor = actorSchema.parse(parsed.actor ?? session.actor);
      const user = await insertMessage({
        sessionId,
        role: 'user',
        actor,
        content: parsed.content,
      });
      const messages = await listMessages(sessionId);
      const sessionTasks = await listTasksForSession(sessionId, 20);
      const pendingExecutionTasks = sessionTasks.filter(
        (task) => task.status === 'waiting_approval'
      );
      const previousPendingAction = createPendingAction(session.summary_state?.pendingAction);
      const conversationSummaryState = buildChatSummaryState({
        session: {
          ...session,
          actor,
        },
        messages,
        previousSummaryState: session.summary_state,
      });
      if (
        isHighSignalInstructionMessage(parsed.content, conversationSummaryState) &&
        typeof orchestrator.persistMemoryArtifact === 'function'
      ) {
        try {
          await orchestrator.persistMemoryArtifact(
            {
              chatSessionId: sessionId,
              artifactType: 'user_instruction',
              content: parsed.content,
              sourceMessageId: user.id,
              retrievalPriority: 100,
              projectPath: session.project_path ?? null,
              metadata: {
                actor,
                sessionTitle: session.title,
                source: 'chat_message',
              },
            },
            {
              task: {
                chat_session_id: sessionId,
                project_path: session.project_path ?? null,
              },
              supersedeLatest: false,
            }
          );
        } catch (error) {
          logger?.warn?.({ err: error, sessionId }, 'Failed to capture high-signal chat instruction');
        }
      }
      const activeDraft = conversationSummaryState.contractDraft ?? null;
      const isAffirmativeReply = isShortAffirmative(parsed.content);
      const isNegativeReply = isShortNegative(parsed.content);

      if (isAffirmativeReply || isNegativeReply) {
        if (previousPendingAction.type === 'approval_request') {
          const targetedTaskId =
            previousPendingAction.taskId ??
            (pendingExecutionTasks.length === 1 ? pendingExecutionTasks[0].id : null);

          if (targetedTaskId) {
            const approvalResult = isAffirmativeReply
              ? await orchestrator.approveTaskExecution(targetedTaskId, {
                  respondedVia: 'chat',
                  note: `Approved from turn-aware chat reply in session ${sessionId}`,
                })
              : await orchestrator.rejectTaskExecution?.(targetedTaskId, {
                  respondedVia: 'chat',
                  reason: `Execution rejected from turn-aware chat reply in session ${sessionId}`,
                });

            if (approvalResult) {
              const assistant = await insertMessage({
                sessionId,
                role: 'assistant',
                actor,
                content: isAffirmativeReply
                  ? `Execution approved for task ${targetedTaskId}. Work is now in progress. Use /status ${targetedTaskId} if you want another snapshot.`
                  : `Okay. I will not start task ${targetedTaskId}. It stays blocked until you approve it again or create a fresh task.`,
                metadata: {
                  taskId: targetedTaskId,
                  executionApproval: approvalResult,
                  autoApprovedFromChat: isAffirmativeReply,
                  pendingAction: createPendingAction(),
                },
              });

              await updateSummary(session, [...messages, assistant]);

              return {
                user,
                assistant,
              };
            }
          }

          const assistant = await insertMessage({
            sessionId,
            role: 'assistant',
            actor,
            content: targetedTaskId
              ? `Task ${targetedTaskId} is no longer waiting for approval. Use /status ${targetedTaskId} to inspect its current state.`
              : buildApprovalDisambiguationResponse(),
            metadata: {
              conservativeExecution: true,
              approvalIntentDetected: true,
              pendingAction: createPendingAction(),
            },
          });

          await updateSummary(session, [...messages, assistant]);

          return {
            user,
            assistant,
          };
        }

        if (
          previousPendingAction.type === 'clarification_question' &&
          previousPendingAction.questionKind === 'yes_no'
        ) {
          if (activeDraft?.readyForPlanning && activeDraft.contract) {
            const { assistant } = await createPlannedTaskMessage({
              session: {
                ...session,
                actor,
                summary_state: conversationSummaryState,
              },
              sessionId,
              actor,
              objective: activeDraft.contract.objective,
              contract: activeDraft.contract,
              autoPlannedFromChat: true,
            });

            return {
              user,
              assistant,
            };
          }

          const assistant = await insertMessage({
            sessionId,
            role: 'assistant',
            actor,
            content:
              activeDraft?.clarificationQuestion ??
              'I recorded that answer, but I still need a bit more detail before I can plan safely.',
            metadata: {
              conservativeExecution: true,
              clarificationRequested: true,
              draftContract: activeDraft?.contract ?? null,
              missingContext: activeDraft?.missingContext ?? ['requested_change'],
              pendingAction: buildClarificationPendingAction(
                activeDraft?.contract?.objective ?? activeDraft?.objective ?? previousPendingAction.draftObjective,
                'open_text'
              ),
            },
          });

          await updateSummary(
            {
              ...session,
              actor,
              summary_state: conversationSummaryState,
            },
            [...messages, assistant]
          );

          return {
            user,
            assistant,
          };
        }

        if (!hasPendingAction(previousPendingAction)) {
          const assistant = await insertMessage({
            sessionId,
            role: 'assistant',
            actor,
            content: buildApprovalDisambiguationResponse(),
            metadata: {
              conservativeExecution: true,
              clarificationRequested: true,
              pendingAction: createPendingAction(),
            },
          });

          await updateSummary(session, [...messages, assistant]);

          return {
            user,
            assistant,
          };
        }
      }

      if (isExecutionApprovalIntent(parsed.content)) {
        const targetedPendingTask =
          pendingExecutionTasks.find((task) => task.id === previousPendingAction.taskId) ??
          (pendingExecutionTasks.length === 1 ? pendingExecutionTasks[0] : null);

        if (targetedPendingTask) {
          const approved = await orchestrator.approveTaskExecution(targetedPendingTask.id, {
            respondedVia: 'chat',
            note: `Approved from natural-language chat reply in session ${sessionId}`,
          });

          if (approved) {
            const assistant = await insertMessage({
              sessionId,
              role: 'assistant',
              actor,
              content: `Execution approved for task ${targetedPendingTask.id}. Work is now in progress. Use /status ${targetedPendingTask.id} if you want another snapshot.`,
              metadata: {
                taskId: targetedPendingTask.id,
                executionApproval: approved,
                autoApprovedFromChat: true,
                pendingAction: createPendingAction(),
              },
            });

            await updateSummary(session, [...messages, assistant]);

            return {
              user,
              assistant,
            };
          }
        } else if (pendingExecutionTasks.length === 0 && activeDraft?.objective) {
          const contract =
            activeDraft.contract ??
            buildDraftContract({
              session,
              messages,
              objective: activeDraft.objective,
            });

          const { assistant } = await createPlannedTaskMessage({
            session: {
              ...session,
              actor,
              summary_state: conversationSummaryState,
            },
            sessionId,
            actor,
            objective: contract.objective,
            contract,
            autoPlannedFromChat: true,
          });

          return {
            user,
            assistant,
          };
        } else {
          const content =
            pendingExecutionTasks.length > 1
              ? `I found ${pendingExecutionTasks.length} legacy tasks still sitting in waiting_approval in this chat. Use /status <task-id> to inspect one, or create a fresh task with /plan.`
              : 'There is no task waiting to be started in this chat. Create one with /plan first.';
          const assistant = await insertMessage({
            sessionId,
            role: 'assistant',
            actor,
            content,
            metadata: {
              conservativeExecution: true,
              approvalIntentDetected: true,
              pendingAction: createPendingAction(),
            },
          });

          await updateSummary(session, [...messages, assistant]);

          return {
            user,
            assistant,
          };
        }
      }

      if (
        pendingExecutionTasks.length === 0 &&
        (isExecutionTaskRequest(parsed.content) || session.summary_state?.contractDraft?.pendingClarification)
      ) {
        if (activeDraft?.readyForPlanning && activeDraft.contract) {
          const { assistant } = await createPlannedTaskMessage({
            session: {
              ...session,
              actor,
              summary_state: conversationSummaryState,
            },
            sessionId,
            actor,
            objective: activeDraft.contract.objective,
            contract: activeDraft.contract,
            autoPlannedFromChat: true,
          });

          return {
            user,
            assistant,
          };
        }

        const assistant = await insertMessage({
          sessionId,
          role: 'assistant',
          actor,
          content:
            activeDraft?.clarificationQuestion ??
            'I need a bit more detail before I can turn this into a task.',
          metadata: {
            conservativeExecution: true,
            clarificationRequested: true,
            draftContract: activeDraft?.contract ?? null,
            missingContext: activeDraft?.missingContext ?? ['requested_change'],
            pendingAction: buildClarificationPendingAction(
              activeDraft?.contract?.objective ?? activeDraft?.objective ?? null,
              'open_text'
            ),
          },
        });

        await updateSummary(
          {
            ...session,
            actor,
            summary_state: conversationSummaryState,
          },
          [...messages, assistant]
        );

        return {
          user,
          assistant,
        };
      }

      const content = await generateAssistantResponse({
        session: {
          ...session,
          actor,
          summary_state: conversationSummaryState,
        },
        actor,
        messages,
        userMessage: parsed.content,
      });
      const assistant = await insertMessage({
        sessionId,
        role: 'assistant',
        actor,
        content,
        metadata: {
          conservativeExecution: true,
          pendingAction: createPendingAction(),
        },
      });

      await updateSummary(
        {
          ...session,
          actor,
          summary_state: conversationSummaryState,
        },
        [...messages, assistant]
      );

      return {
        user,
        assistant,
      };
    },

    async draftTask(sessionId, input = {}) {
      const parsed = draftTaskSchema.parse(input);
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      const messages = await listMessages(sessionId);
      const draftState = buildContractDraftState({
        session,
        messages,
        previousSummaryState: session.summary_state,
        explicitObjective: parsed.objective,
      });
      const contract =
        draftState?.contract ??
        buildDraftContract({
          session,
          messages,
          objective: parsed.objective,
        });

      // Part 7d: Add safe minimum fallbacks
      if (!Array.isArray(contract.outOfScope) || contract.outOfScope.length === 0) {
        contract.outOfScope = ['Unrelated refactors', 'Changes outside the stated objective'];
      }
      if (!Array.isArray(contract.constraints) || contract.constraints.length === 0) {
        contract.constraints = ['Stay within the project path', 'Do not modify unrelated files'];
      }
      if (!Array.isArray(contract.successCriteria) || contract.successCriteria.length === 0) {
        contract.successCriteria = ['Task objective is met', 'Tests pass if a test command exists'];
      }

      const assistant = await insertMessage({
        sessionId,
        role: 'assistant',
        actor: parsed.actor ?? session.actor,
        content: `Drafted a task contract. It is not queued until you request a plan or approve execution.\n\nObjective: ${contract.objective}`,
        metadata: {
          draftContract: contract,
          draftReadyForPlanning: draftState?.readyForPlanning ?? true,
          missingContext: draftState?.missingContext ?? [],
          pendingAction: createPendingAction(),
        },
      });

      await updateSummary(session, [...messages, assistant]);

      return { contract };
    },

    async planTask(sessionId, input = {}) {
      const session = await getSessionRow(sessionId);
      if (!session) {
        return null;
      }

      if (input.contract) {
        const messages = await listMessages(sessionId);
        let contract;
        try {
          contract = normalizeTaskContract(input.contract);
        } catch (err) {
          const issues = err?.issues ?? [];
          const errorLines = issues.length > 0
            ? issues.map((issue) => `- \`${issue.path.join('.')}\`: ${issue.message}`).join('\n')
            : err.message;
          return {
            reply: `I couldn't finalize the task contract — please clarify:\n\n${errorLines}\n\nReply with the missing details and I'll try again.`,
            summaryState: {
              ...session.summary_state,
              pendingAction: { type: 'clarification_question', questionKind: 'open_text' },
            },
          };
        }
        const planned = await reconcileAutoStartedPlan(
          orchestrator,
          await orchestrator.createPlannedTask(contract, {
          source: 'chat',
          chatSessionId: sessionId,
          projectPath: session.project_path,
          projectTargetId: session.project_target_id ?? null,
          autoApproveExecution: deriveExecutionControl(contract).autoStartAllowed,
          approvalSource: 'chat',
          approvalNote: `Auto-started local-only task from chat session ${sessionId}`,
          })
        );

        const assistant = await insertMessage({
          sessionId,
          role: 'assistant',
          actor: session.actor,
          content: buildPlannedTaskChatResponse({
            task: planned.task,
            plan: planned.plan,
            execution: planned.execution,
            executionApproval: planned.executionApproval,
          }),
          metadata: {
            taskId: planned.task.id,
            taskStatus: planned.task.status,
            plan: planned.plan,
            execution: planned.execution,
            executionPending: planned.executionApproval?.status !== 'approved',
            executionApproval: planned.executionApproval,
            pendingAction:
              planned.executionApproval?.status === 'pending'
                ? buildApprovalPendingAction(planned.task.id, contract.objective)
                : createPendingAction(),
          },
        });

        await updateSummary(session, [...messages, assistant]);
        return planned;
      }

      const messages = await listMessages(sessionId);
      const draftState = buildContractDraftState({
        session,
        messages,
        previousSummaryState: session.summary_state,
        explicitObjective: input.objective,
      });

      const { planned } = await createPlannedTaskMessage({
        session,
        sessionId,
        actor: session.actor,
        objective: draftState?.contract?.objective ?? input.objective,
        contract: draftState?.contract ?? null,
      });

      return planned;
    },

    async approveTask(sessionId, input = {}) {
      const taskId = z.string().uuid().parse(input.taskId);
      const session = await getSessionRow(sessionId);
      const approved = await orchestrator.approveTaskExecution(taskId, {
        respondedVia: 'chat',
        note: `Approved from chat session ${sessionId}`,
      });

      if (!approved) {
        return null;
      }

      const messages = session ? await listMessages(sessionId) : [];
      const assistant = await insertMessage({
        sessionId,
        role: 'assistant',
        actor: input.actor ?? null,
        content: `Execution approved for task ${taskId}.`,
        metadata: {
          taskId,
          executionApproval: approved,
          pendingAction: createPendingAction(),
        },
      });

      if (session) {
        await updateSummary(session, [...messages, assistant]);
      }

      return approved;
    },
  };
}
