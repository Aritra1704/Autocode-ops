import { z } from 'zod';

const nonEmptyLine = z.string().trim().min(1);

const nonEmptyList = z.array(nonEmptyLine).min(1).max(20);
const executionPolicySchema = z
  .enum(['auto_local', 'require_approval', 'external_only'])
  .default('require_approval');

const repoIntentSchema = z
  .object({
    publish: z.boolean().default(false),
    deploy: z.boolean().default(false),
    deployTarget: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const taskContractSchema = z
  .object({
    version: z.literal('task_contract_v1').default('task_contract_v1'),
    projectName: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-_]{1,63}$/i, 'projectName must be 2-64 chars: letters, numbers, -, _'),
    objective: z.string().trim().min(10).max(2000),
    inScope: nonEmptyList,
    outOfScope: nonEmptyList,
    constraints: nonEmptyList,
    successCriteria: nonEmptyList,
    priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
    skillHints: z.array(nonEmptyLine).max(12).default([]),
    executionPolicy: executionPolicySchema,
    repoIntent: repoIntentSchema.default({ publish: false, deploy: false }),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

function formatList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

export function normalizeTaskContract(input) {
  return taskContractSchema.parse(input);
}

export function buildTaskTitleFromContract(contract) {
  const projectName = contract.projectName.trim();
  const objective = contract.objective.trim();
  return `${projectName}: ${objective}`.slice(0, 80);
}

export function buildTaskDescriptionFromContract(contract) {
  const executionControl = deriveExecutionControl(contract);
  const lines = [
    '[task_contract_v1]',
    '',
    '## Objective',
    contract.objective,
    '',
    '## Project',
    `- name: ${contract.projectName}`,
    `- priority: ${contract.priority}`,
    `- execution_policy: ${executionControl.executionPolicy}`,
    `- execution_class: ${executionControl.executionClass}`,
    `- approval_required: ${executionControl.approvalRequired ? 'yes' : 'no'}`,
    `- publish: ${contract.repoIntent.publish ? 'yes' : 'no'}`,
    `- deploy: ${contract.repoIntent.deploy ? 'yes' : 'no'}`,
  ];

  if (contract.repoIntent.deployTarget) {
    lines.push(`- deploy_target: ${contract.repoIntent.deployTarget}`);
  }

  lines.push(
    '',
    '## In Scope',
    formatList(contract.inScope),
    '',
    '## Out Of Scope',
    formatList(contract.outOfScope),
    '',
    '## Constraints',
    formatList(contract.constraints),
    '',
    '## Success Criteria',
    formatList(contract.successCriteria)
  );

  if (contract.skillHints.length > 0) {
    lines.push('', '## Skill Hints', formatList(contract.skillHints));
  }

  if (contract.notes) {
    lines.push('', '## Notes', contract.notes);
  }

  return lines.join('\n').trim();
}

export function deriveExecutionClass(contract) {
  if (contract?.repoIntent?.deploy === true) {
    return 'deploy';
  }

  if (contract?.repoIntent?.publish === true) {
    return 'publish';
  }

  return 'local_only';
}

export function deriveExecutionControl(contract) {
  const normalized = normalizeTaskContract(contract);
  const executionClass = deriveExecutionClass(normalized);
  const executionPolicy = normalized.executionPolicy ?? 'external_only';
  const localOnly = executionClass === 'local_only';

  let approvalRequired = true;
  let autoStartAllowed = false;

  if (localOnly && executionPolicy === 'auto_local') {
    approvalRequired = false;
    autoStartAllowed = true;
  }

  return {
    executionClass,
    executionPolicy,
    approvalRequired,
    autoStartAllowed,
  };
}

export function extractTaskContractFromTask(task) {
  return task?.result?.taskContract ?? null;
}
