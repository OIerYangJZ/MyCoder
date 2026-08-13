/**
 * Delegate — dispatch a bounded child scope to a discovered agent (ADR-0013).
 *
 * The tool is deliberately thin. It validates the shape of the request, declares
 * one `agent.invoke` access so the policy layer gets a say, and hands the work to
 * the `DelegationService` the runtime was given. Every interesting decision —
 * which capabilities the child gets, how much budget, which model, whether the
 * depth is legal — happens there, once, rather than being split between a tool
 * and a service where the two could disagree.
 *
 * Two consequences worth stating:
 *
 *  - **The depth check is not here.** A child asking for a grandchild still calls
 *    through, so the attempt is recorded as `delegation.requested` followed by
 *    `delegation.denied`. Refusing it in the tool would be cheaper and would
 *    leave no audit trail of what was attempted.
 *  - **The executor is unused.** A delegation performs no effect of its own; the
 *    child's own tool calls go through their own executors, each planned from
 *    their own decisions. The `agent.invoke` access therefore plans to an empty
 *    capability profile, which is correct and worth noticing: delegation grants
 *    no filesystem, no process and no network by itself.
 */

import { errorResult, okResult, type ToolDefinition, type ToolExecution } from '../contract.ts';
import type { JsonSchema } from '../../util/jsonschema.ts';
import type { DelegationRequest, DelegationResult } from '../../session/delegation.ts';

export interface DelegateArgs {
  agent: string;
  task: string;
  contextRefs?: string[];
  maxSteps?: number;
  maxToolCalls?: number;
  maxModelRequests?: number;
  maxWallTimeMs?: number;
  maxCostUsd?: number;
}

const schema = (agents: readonly string[]): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['agent', 'task'],
  properties: {
    agent: {
      type: 'string',
      description:
        agents.length > 0
          ? `Which agent to delegate to. Configured: ${agents.join(', ')}.`
          : 'Which agent to delegate to.',
    },
    task: {
      type: 'string',
      description:
        'The complete task, written for someone who cannot see this conversation. State the goal, ' +
        'the files or symptoms involved, and what to report back. The child starts with no history.',
    },
    contextRefs: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional paths or identifiers that are likely relevant. These are passed as references only — ' +
        'the child reads them itself, under its own permissions.',
    },
    maxSteps: {
      type: 'integer',
      description: 'Upper bound on child steps. Clamped to what this turn has left.',
    },
    maxToolCalls: { type: 'integer', description: 'Upper bound on child tool calls.' },
    maxModelRequests: { type: 'integer', description: 'Upper bound on child model requests.' },
    maxWallTimeMs: { type: 'integer', description: 'Upper bound on child wall-clock time, in milliseconds.' },
    maxCostUsd: { type: 'number', description: 'Upper bound on child cost, when pricing is configured.' },
  },
});

export interface DelegateToolOptions {
  /** Agent names, for the schema description. Purely informational. */
  agents: readonly string[];
}

export function createDelegateTool(opts: DelegateToolOptions): ToolDefinition<DelegateArgs> {
  return {
    name: 'Delegate',
    description:
      'Hand a bounded, self-contained task to a specialist subagent and wait for its report. ' +
      'The child runs with capabilities that are a subset of yours, its own budget, and no view of this ' +
      'conversation — so the task must be written to stand alone. Use it when a task is genuinely separable ' +
      '(a focused review, a diagnosis across many files) and not for work you can do directly in a step or ' +
      'two: a delegation costs a whole model conversation.',
    inputSchema: schema(opts.agents),
    disclosure: 'eager',
    readOnly: false,

    async resolve(args, ctx): Promise<ToolExecution> {
      const requestedDepth = ctx.delegation.depth + 1;
      const subject = {
        key: `agent.invoke:${args.agent}`,
        title: `delegate to the "${args.agent}" subagent`,
        details: [
          `task     : ${firstLine(args.task)}`,
          `depth    : ${requestedDepth} of ${ctx.delegation.maxDepth}`,
          'capability: the child cannot exceed this session; budget comes out of this turn',
        ],
        risk: 'medium' as const,
      };
      const display = {
        title: `Delegate to ${args.agent}`,
        summary: firstLine(args.task),
        body: args.task,
      };

      const delegate = ctx.delegate;
      if (!delegate) {
        return {
          accesses: [],
          approvalSubject: subject,
          display,
          execute: async () =>
            errorResult(
              'DELEGATION_DENIED',
              'Delegation is not available in this session: no delegation service is wired up. ' +
                'Do the work directly.',
            ),
        };
      }

      return {
        accesses: [
          {
            kind: 'agent.invoke',
            agent: args.agent,
            depth: requestedDepth,
            display: `delegate to "${args.agent}": ${firstLine(args.task)}`,
          },
        ],
        approvalSubject: subject,
        display,

        async execute(_executor, signal) {
          const request: DelegationRequest = {
            agent: args.agent,
            task: args.task,
            ...(args.contextRefs ? { contextRefs: args.contextRefs } : {}),
            ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
            ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
            ...(args.maxModelRequests !== undefined ? { maxModelRequests: args.maxModelRequests } : {}),
            ...(args.maxWallTimeMs !== undefined ? { maxWallTimeMs: args.maxWallTimeMs } : {}),
            ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
          };

          const result = await delegate(request, {
            toolCallId: ctx.toolCallId,
            turnId: ctx.turnId,
            stepId: ctx.stepId,
            signal,
            loopBudget: ctx.loopBudget,
            scope: ctx.delegation,
          });

          return renderResult(result);
        },
      };
    },
  };
}

/**
 * Turn the structured result into what the parent model sees.
 *
 * A non-completed delegation is an **error result**, which matters for more than
 * tone: the runtime's doom-loop accounting only fingerprints failures, so a child
 * that keeps failing the same way eventually ends the parent's turn instead of
 * being retried forever (§32).
 */
export function renderResult(result: DelegationResult): ReturnType<typeof okResult> {
  const usage = result.usage;
  const lines = [
    result.summary,
    '',
    `delegation : ${result.delegationId} (${result.agent}, ${result.status})`,
    `child cost : ${usage.modelRequests} model request(s), ${usage.toolCalls} tool call(s), ` +
      `${Math.round(usage.wallTimeMs)}ms` +
      (usage.estimatedCostUsd !== undefined ? `, ~$${usage.estimatedCostUsd.toFixed(4)}` : ''),
  ];
  if (result.grant) {
    lines.push(`child tools: ${result.grant.allowedTools.join(', ') || 'none'}`);
    if (result.grant.skills.length > 0) lines.push(`child skills: ${result.grant.skills.join(', ')}`);
  }
  if (result.notes.length > 0) {
    lines.push('notes      :', ...result.notes.map((n) => `  - ${n}`));
  }

  const metadata = {
    delegationId: result.delegationId,
    childRunId: result.childRunId,
    agent: result.agent,
    status: result.status,
    modelRequests: usage.modelRequests,
    toolCalls: usage.toolCalls,
    wallTimeMs: usage.wallTimeMs,
    ...(usage.estimatedCostUsd !== undefined ? { estimatedCostUsd: usage.estimatedCostUsd } : {}),
    dirtyFiles: result.dirtyFiles,
  };

  if (result.status === 'completed') {
    return okResult(lines.join('\n'), { structured: result, metadata });
  }

  return {
    content: `error: ${result.error?.code ?? 'DELEGATION_FAILED'}\n${lines.join('\n')}`,
    isError: true,
    errorCode: result.error?.code ?? 'DELEGATION_FAILED',
    structured: result,
    metadata,
  };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
