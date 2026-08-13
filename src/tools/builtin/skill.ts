/**
 * Skill — activate a discovered skill for this run or this turn (alpha.4 §21–§25).
 *
 * A skill is an instruction overlay plus a set of *restrictions*: a tool subset, a
 * permission profile, a step budget. Activating one can therefore only ever make
 * the session narrower, which is why this tool declares **no access request** at
 * all. That absence is deliberate and load-bearing: if activation could grant
 * anything, it would need a capability, and the whole point of §23 is that it
 * cannot.
 *
 * What the tool does *not* do is decide anything. It calls the session's
 * activation callback, which resolves the name against the discovered skills,
 * intersects, and applies the result between steps — never mid-request, because a
 * step's tool catalogue is frozen for the duration of its model call
 * (invariant 2).
 */

import { errorResult, okResult, type ToolDefinition, type ToolExecution } from '../contract.ts';
import type { JsonSchema } from '../../util/jsonschema.ts';
import type { SkillActivationScope } from '../../extensions/skills.ts';

export interface SkillArgs {
  name: string;
  scope?: SkillActivationScope;
}

const schema = (skills: ReadonlyArray<{ name: string; description: string }>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      description:
        skills.length > 0
          ? `Which skill to activate. Available: ${skills.map((s) => s.name).join(', ')}.`
          : 'Which skill to activate.',
    },
    scope: {
      type: 'string',
      enum: ['run', 'turn'],
      description:
        "'turn' applies until this turn ends, 'run' for the rest of the session. Defaults to 'turn'.",
    },
  },
});

export interface SkillToolOptions {
  skills: ReadonlyArray<{ name: string; description: string }>;
}

export function createSkillTool(opts: SkillToolOptions): ToolDefinition<SkillArgs> {
  const catalogue = opts.skills.map((s) => `  ${s.name} — ${s.description}`).join('\n');

  return {
    name: 'Skill',
    description:
      'Load a skill: extra instructions for a specific kind of work, together with the narrower ' +
      'tool and permission set that work should run under. Activation takes effect on your next step. ' +
      'A skill can only restrict what you may do, never widen it — so activating one may remove tools ' +
      'you currently have.' +
      (catalogue !== '' ? `\n\nAvailable skills:\n${catalogue}` : ''),
    inputSchema: schema(opts.skills),
    disclosure: 'eager',
    // Activation changes the session's own constraints rather than the workspace,
    // so there is nothing to roll back — but it is not "read only" in the sense
    // the parallel-execution flag means, and claiming otherwise would let it be
    // reordered against the calls whose catalogue it changes.
    readOnly: false,

    async resolve(args, ctx): Promise<ToolExecution> {
      const subject = {
        key: `skill.activate:${args.name}`,
        title: `activate the "${args.name}" skill`,
        details: ['effect: narrows tools, permissions and budget; grants nothing'],
        risk: 'low' as const,
      };
      const display = {
        title: `Activate skill ${args.name}`,
        summary: `scope ${args.scope ?? 'turn'}`,
      };

      const activate = ctx.activateSkill;
      if (!activate) {
        return {
          accesses: [],
          approvalSubject: subject,
          display,
          execute: async () =>
            errorResult('TOOL_NOT_FOUND', 'This session has no skills configured, so none can be activated.'),
        };
      }

      return {
        // No access request: see the file header. Activation is a narrowing.
        accesses: [],
        approvalSubject: subject,
        display,
        async execute() {
          const outcome = await activate(args.name, args.scope ?? 'turn', 'model');
          if (!outcome.ok) {
            return errorResult('TOOL_INVALID_ARGS', outcome.message);
          }
          const lines = [outcome.message];
          if (outcome.allowedTools) {
            lines.push(`tools from your next step: ${outcome.allowedTools.join(', ') || 'none'}`);
          }
          for (const note of outcome.notes ?? []) lines.push(`note: ${note}`);
          return okResult(lines.join('\n'), {
            metadata: { skill: args.name, scope: args.scope ?? 'turn' },
          });
        },
      };
    },
  };
}
